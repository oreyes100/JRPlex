import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, fail, project } from './lib.mjs';

// Child diagnostics and config dumps can contain refresh tokens. Only this URL
// allowlist may reach the terminal; never forward an rclone error or JSON body.
export function authorizationUrls(value) {
  return [...new Set(String(value).match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[A-Za-z0-9_%.-]+/g) ?? [])];
}

export function cleanEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^RCLONE_/i.test(key)));
}

export function failureClassification(value) {
  if (/\bunknown flag\s*:/i.test(value)) return 'CLI_FLAG_UNKNOWN';
  if (/\bunknown command\s/i.test(value)) return 'CLI_COMMAND_UNKNOWN';
  return 'OPERATION_FAILED';
}

export async function runRclone(executable, argv, { env, authorization = false, capture = false, stage = 'rclone', spawnImpl = spawn } = {}) {
  const safeStage = ['rclone', 'encryption-set', 'encryption-check', 'config-read', 'config-create', 'cli-help'].includes(stage) ? stage : 'rclone';
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', tail = '', diagnosticTail = '', overflow = false;
    const emitted = new Set();
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const receive = (buffer, stdout) => {
      diagnosticTail = (diagnosticTail + buffer.toString('utf8')).slice(-16384);
      if (capture && stdout) {
        output += buffer.toString('utf8');
        if (output.length > 1024 * 1024) { overflow = true; stop(); }
      }
      if (authorization) {
        tail = (tail + buffer.toString('utf8')).slice(-8192);
        // Wait for a delimiter so URLs split between pipe chunks stay intact.
        for (const match of tail.matchAll(/(http:\/\/127\.0\.0\.1:53682\/auth\?state=[A-Za-z0-9_%.-]+)(?=[\s"'<>]|$)/g)) {
          if (match.index + match[0].length === tail.length) continue;
          if (!emitted.has(match[1])) { emitted.add(match[1]); console.log(`Autoriza Google Drive en: ${match[1]}`); }
        }
      }
    };
    child.stdout.on('data', (b) => receive(b, true));
    child.stderr.on('data', (b) => receive(b, false));
    const cleanup = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); };
    child.once('error', () => { cleanup(); reject(new Error(`rclone [${safeStage}]: no se pudo iniciar el ejecutable privado.`)); });
    child.once('close', (code) => {
      cleanup();
      if (overflow || code !== 0) reject(new Error(`rclone [${safeStage}] no completó la operación (${Number.isInteger(code) ? `código ${code}` : 'interrumpido'}; ${overflow ? 'OUTPUT_LIMIT' : failureClassification(diagnosticTail)}); diagnóstico privado suprimido para proteger credenciales.`));
      else resolve(output);
    });
  });
}

async function privateFile(filename, label) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}: se requiere un archivo regular privado.`);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error(`${label}: restringe permisos a 0600 antes de continuar.`);
}

async function privateDirectory(dirname) {
  await mkdir(dirname, { recursive: true, mode: 0o700 });
  const info = await stat(dirname);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('La carpeta privada permite acceso a otras cuentas; restringe sus permisos a 0700.');
}

async function outsideRepository(filename) {
  let root = project;
  for (let ancestor = project; ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    try { await stat(path.join(ancestor, '.git')); root = ancestor; break; } catch {}
  }
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(path.dirname(filename));
  const relative = path.relative(resolvedRoot, resolvedParent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('La configuración OAuth debe quedar fuera del repositorio, también al resolver enlaces.');
  }
}

export async function setupGoogleDrive(opt, { runner = runRclone, home = os.homedir() } = {}) {
  if (!opt.rclone || !path.isAbsolute(opt.rclone)) throw new Error('--rclone debe identificar un ejecutable oficial mediante ruta absoluta.');
  const config = opt.config ?? path.join(home, '.config', 'jrplex', 'rclone.conf');
  if (!path.isAbsolute(config)) throw new Error('--config debe ser una ruta absoluta externa al repositorio.');
  if (opt['folder-id'] && !/^(?:root|[A-Za-z0-9_-]{10,200})$/.test(opt['folder-id'])) throw new Error('--folder-id no tiene formato de ID de carpeta Google Drive.');
  const action = opt.action ?? 'authorize';
  if (!['authorize', 'check'].includes(action)) throw new Error('--action debe ser authorize o check.');
  await privateDirectory(path.dirname(config));
  await outsideRepository(config);
  const configExists = await lstat(config).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (configExists) {
    await privateFile(config, 'Configuración');
    if (!(await readFile(config, 'utf8')).slice(0, 256).includes('RCLONE_ENCRYPT_V0:')) throw new Error('La configuración existente no está cifrada; no se modificó.');
  } else if (action === 'check') throw new Error('Todavía no existe configuración cifrada.');

  let passwordCommand = opt['password-command'];
  if (passwordCommand && /[\r\n\0]/.test(passwordCommand)) throw new Error('--password-command debe ser un comando local fijo sin saltos de línea.');
  if (!passwordCommand) {
    if (process.platform === 'win32') throw new Error('En Windows configura --password-command con un helper que consulte Credential Manager y restringe las ACL.');
    const passwordFile = opt['password-file'] ?? path.join(home, 'JRPlex', 'runtime', 'secrets', 'rclone-config-password');
    if (!path.isAbsolute(passwordFile) || passwordFile === config || path.dirname(passwordFile) === path.dirname(config)) throw new Error('La contraseña requiere una ruta absoluta separada de la carpeta OAuth.');
    await privateDirectory(path.dirname(passwordFile));
    try { await privateFile(passwordFile, 'Contraseña'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (configExists) throw new Error('Falta la contraseña de la configuración existente; restaura su copia privada.');
      const secret = await open(passwordFile, 'wx', 0o600);
      try { await secret.writeFile(`${randomBytes(48).toString('base64url')}\n`); } finally { await secret.close(); }
    }
    // rclone parses this command directly; no shell, substitutions or secret argv.
    passwordCommand = `/bin/cat "${passwordFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  const env = cleanEnvironment();
  if (opt['client-file']) {
    if (!path.isAbsolute(opt['client-file'])) throw new Error('--client-file requiere una ruta absoluta privada.');
    await privateFile(opt['client-file'], 'Cliente OAuth');
    let client;
    try { const data = JSON.parse(await readFile(opt['client-file'], 'utf8')); client = data.installed ?? data; } catch { throw new Error('El archivo privado de cliente OAuth no es JSON válido.'); }
    if (typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com') || typeof client.client_secret !== 'string' || !client.client_secret) throw new Error('El archivo privado necesita client_id y client_secret de un cliente Desktop de Google.');
    env.RCLONE_CONFIG_GDRIVE_CLIENT_ID = client.client_id;
    env.RCLONE_CONFIG_GDRIVE_CLIENT_SECRET = client.client_secret;
  }
  const common = ['--config', config, '--password-command', passwordCommand, '--ask-password=false'];
  const call = (argv, options = {}) => {
    const stage = argv[1] === 'encryption' ? `encryption-${argv[2]}` : argv[1] === 'dump' ? 'config-read' : argv[1] === 'create' ? 'config-create' : 'rclone';
    return runner(opt.rclone, [...argv, ...common], { env, stage, ...options });
  };
  const lockName = `${config}.jrplex-setup.lock`;
  let lock;
  try { lock = await open(lockName, 'wx', 0o600); }
  catch { throw new Error('Hay otra configuración OAuth en curso; no se modificó el archivo.'); }
  try {
    if (!configExists) { await call(['config', 'encryption', 'set']); await chmod(config, 0o600); }
    await call(['config', 'encryption', 'check']);
    let remotes;
    try { remotes = JSON.parse(await call(['config', 'dump'], { capture: true })); } catch { throw new Error('No se pudo comprobar de forma privada la configuración cifrada.'); }
    if (action === 'check') {
      if (remotes.gdrive?.type !== 'drive' || remotes.gdrive?.scope !== 'drive.readonly' || !remotes.gdrive?.token) throw new Error('No existe una autorización Google Drive de solo lectura completa.');
      console.log('Google Drive: configuración cifrada, descifrado y autorización de solo lectura comprobados. Reproducción real aún requiere prueba.');
      return;
    }
    if (remotes.gdrive) throw new Error('Ya existe gdrive; se rechazó sobrescribir una autorización o un intento anterior. Usa --action check y recuperación documentada.');
    if (!opt['client-file']) console.log('Cliente OAuth compartido de rclone: se retira durante 2026; configura un cliente Desktop propio antes de aprobar una conexión permanente.');
    console.log('Preparando autorización Google Drive de solo lectura. En VPS mantén el túnel SSH local 53682 abierto.');
    // config create uses a mapper key, unlike the authorize subcommand's CLI flag.
    // Verified against v1.75.2 fs/config.ConfigAuthNoBrowser and oauthutil.configSetup.
    const create = ['config', 'create', 'gdrive', 'drive', 'scope=drive.readonly', 'config_is_local=true', 'config_auth_no_browser=true'];
    if (!opt['client-file']) create.push('config_shared_client_id=true');
    if (opt['folder-id']) create.push(`root_folder_id=${opt['folder-id']}`);
    await call([...create, '--no-output'], { authorization: true });
    await chmod(config, 0o600);
    await call(['config', 'encryption', 'check']);
    let result;
    try { result = JSON.parse(await call(['config', 'dump'], { capture: true })); } catch { throw new Error('No se pudo verificar la autorización de forma privada.'); }
    if (result.gdrive?.type !== 'drive' || result.gdrive?.scope !== 'drive.readonly' || !result.gdrive?.token) throw new Error('OAuth no dejó una autorización de solo lectura completa.');
    console.log('Google Drive autorizado en gdrive:; configuración cifrada y solo lectura comprobadas. Falta probar un vídeo real.');
  } finally { await lock.close(); await unlink(lockName); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opt = args(['rclone', 'config', 'password-command', 'password-file', 'folder-id', 'client-file', 'action', 'help'], ['help']);
    if (opt.help) console.log('node scripts/google-drive.mjs --rclone /ruta/absoluta/rclone [--config /ruta/externa/rclone.conf] [--password-command "/ruta/helper"] [--password-file /ruta/privada/password] [--client-file /ruta/privada/google-desktop.json] [--folder-id ID] [--action authorize|check]\nOAuth solo lectura. En Linux/macOS genera contraseña aleatoria privada si no se indica gestor. Nunca imprime tokens ni diagnósticos rclone.');
    else {
      opt.rclone ??= process.env.RCLONE_BIN || path.join(project, 'runtime', 'tools', 'rclone-v1.75.2-linux-amd64', 'rclone');
      opt['client-file'] ??= path.join(os.homedir(), '.config', 'jrplex', 'google-desktop.json');
      opt['password-command'] ??= path.join(os.homedir(), '.local', 'bin', 'read-rclone-secret');
      for (const key of ['client-file', 'password-command']) {
        try { await lstat(opt[key]); } catch (error) { if (error.code === 'ENOENT') delete opt[key]; else throw error; }
      }
      await setupGoogleDrive(opt);
    }
  } catch (error) { fail(error); }
}
