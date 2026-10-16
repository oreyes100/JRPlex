import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, link, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, fail, project } from './lib.mjs';

const callback = 'https://jrplexps.duckdns.org/api/google-drive/callback';

async function privateDirectory(dirname) {
  await mkdir(dirname, { recursive: true, mode: 0o700 });
  const info = await lstat(dirname);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('La carpeta privada debe ser real y tener permisos 0700.');
}

async function privateFile(filename, label) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error(`${label} debe ser un archivo regular con permisos 0600.`);
}

async function outsideProject(filename, projectRoot = project) {
  let root = projectRoot;
  for (let ancestor = projectRoot; ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    try { await stat(path.join(ancestor, '.git')); root = ancestor; break; } catch {}
  }
  const [resolvedRoot, resolvedParent] = await Promise.all([realpath(root), realpath(path.dirname(filename))]);
  const relative = path.relative(resolvedRoot, path.join(resolvedParent, path.basename(filename)));
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Las credenciales deben quedar fuera del código del proyecto.');
}

async function installClient(source, target, projectRoot = project) {
  if (!path.isAbsolute(source)) throw new Error('--client-file requiere una ruta absoluta.');
  await privateFile(source, 'El JSON OAuth');
  await outsideProject(source, projectRoot);
  let document;
  try { document = JSON.parse(await readFile(source, 'utf8')); } catch { throw new Error('El archivo OAuth no es JSON válido.'); }
  const web = document?.web;
  if (!web || typeof web.client_id !== 'string' || !web.client_id.endsWith('.apps.googleusercontent.com') || typeof web.client_secret !== 'string' || !web.client_secret || !Array.isArray(web.redirect_uris) || !web.redirect_uris.includes(callback)) {
    throw new Error('Se requiere un cliente Google de tipo Web con el callback HTTPS exacto de JRPlex.');
  }
  await privateDirectory(path.dirname(target));
  await outsideProject(target, projectRoot);
  if (path.resolve(source) === path.resolve(target)) return;
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    if (error.code === 'EEXIST') throw new Error('El cliente OAuth de destino ya existe; no se sobrescribió.');
    throw error;
  }
  await privateFile(target, 'El cliente OAuth copiado');
}

async function ensureKey(filename) {
  await privateDirectory(path.dirname(filename));
  try {
    await privateFile(filename, 'La clave de cifrado');
    const value = (await readFile(filename, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').length !== 32) throw new Error('La clave de cifrado existente no tiene el formato esperado.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString('base64url')}\n`); await handle.sync(); } finally { await handle.close(); }
  }
  await privateFile(filename, 'La clave de cifrado');
}

export async function prepareGoogleDrive({ clientFile, home = os.homedir(), projectRoot = project } = {}) {
  if (process.platform === 'win32') throw new Error('Esta preparación segura se ejecuta en el VPS Linux; no copies el secreto dentro del repositorio Windows.');
  if (!clientFile || !path.isAbsolute(clientFile)) throw new Error('--client-file requiere una ruta absoluta.');
  const clientRoot = path.join(home, '.config', 'jrplex');
  const client = path.join(clientRoot, 'google-web.json');
  const key = path.join(home, '.local', 'share', 'jrplex', 'secrets', 'google-drive.key');
  const state = path.join(home, '.local', 'share', 'jrplex', 'google-drive');
  await installClient(clientFile, client, projectRoot);
  await ensureKey(key);
  await privateDirectory(state);
  return { client, key, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform === 'win32') throw new Error('Esta preparación segura se ejecuta en el VPS Linux; no copies el secreto dentro del repositorio Windows.');
    const opt = args(['client-file', 'help'], ['help']);
    if (opt.help) {
      console.log('node scripts/google-drive-prepare.mjs --client-file /ruta/privada/google-web.json\nValida cliente Web/callback y prepara credencial, clave AES separada y carpeta privada de tokens. No muestra ni modifica secretos existentes.');
    } else {
      if (!opt['client-file']) throw new Error('Indica el JSON descargado con --client-file.');
      const paths = await prepareGoogleDrive({ clientFile: opt['client-file'] });
      console.log('Cliente Google Web verificado y guardado fuera del código.');
      console.log(`Cliente: ${paths.client}`);
      console.log(`Clave AES privada y separada: ${paths.key}`);
      console.log(`Almacenamiento privado para tokens cifrados: ${paths.state}`);
      console.log('Siguiente paso: montar deploy/compose.google-drive.yaml y reiniciar solo el gateway.');
    }
  } catch (error) { fail(error); }
}
