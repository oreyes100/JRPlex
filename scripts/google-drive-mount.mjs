import { spawn } from 'node:child_process';
import { access, constants, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, fail, project } from './lib.mjs';
import { readGoogleDriveMountCredentials } from '../lib/google-drive-oauth.mjs';

export function rcloneEnvironment(credentials, source = process.env, folderId = '') {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name)));
  Object.assign(env, {
    RCLONE_CONFIG_GDRIVE_TYPE: 'drive',
    RCLONE_CONFIG_GDRIVE_CLIENT_ID: credentials.clientId,
    RCLONE_CONFIG_GDRIVE_CLIENT_SECRET: credentials.clientSecret,
    RCLONE_CONFIG_GDRIVE_SCOPE: 'drive.readonly',
    RCLONE_CONFIG_GDRIVE_TOKEN: JSON.stringify(credentials.token),
  });
  if (folderId) env.RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID = folderId;
  return env;
}

// rclone's FUSE backend ignores --allow-root. Kernel permission checks with
// 0700/0600 preserve access for the mount owner and root while Docker validates it.
export function rcloneMountArgs(mount, cache) {
  return ['--config', '/dev/null', 'mount', 'gdrive:', mount, '--read-only', '--allow-other', '--default-permissions', '--dir-perms', '0700', '--file-perms', '0600', '--vfs-cache-mode', 'full', '--cache-dir', cache,
    '--vfs-cache-max-size', '2G', '--vfs-cache-max-age', '30m', '--vfs-cache-min-free-space', '5G', '--buffer-size', '16M', '--log-level', 'ERROR'];
}

async function validateMount(mount, cache) {
  for (const [value, label] of [[mount, '--mount'], [cache, '--cache']]) if (!path.isAbsolute(value)) throw new Error(`${label} requiere una ruta absoluta.`);
  const info = await lstat(mount);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('El punto de montaje debe ser una carpeta real ya creada.');
  if ((await readdir(mount)).length) throw new Error('El punto de montaje debe estar vacío antes de conectar Drive.');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink() || (process.platform !== 'win32' && (cacheInfo.mode & 0o077))) throw new Error('La caché debe ser una carpeta privada con permisos 0700.');
  await access(cache, constants.W_OK);
}

export async function runGoogleDriveMount(options, { spawnImpl = spawn, sourceEnv = process.env, projectRoot = project, home = os.homedir() } = {}) {
  if (process.platform !== 'linux') throw new Error('El montaje FUSE de esta orden requiere Linux.');
  const rclone = options.rclone || '/usr/bin/rclone';
  const clientFile = options['client-file'] || path.join(home, '.config', 'jrplex', 'google-web.json');
  const keyFile = options['key-file'] || path.join(home, '.local', 'share', 'jrplex', 'secrets', 'google-drive.key');
  const tokenFile = options['token-file'] || path.join(home, '.local', 'share', 'jrplex', 'google-drive', 'token.enc');
  const mount = options.mount || path.join(projectRoot, 'runtime', 'media', 'cloud');
  const cache = options.cache || path.join(home, '.cache', 'jrplex', 'google-drive');
  const folderId = options['folder-id'] || '';
  for (const [value, label] of [[rclone, '--rclone'], [clientFile, '--client-file'], [keyFile, '--key-file'], [tokenFile, '--token-file'], [mount, '--mount'], [cache, '--cache']]) {
    if (!path.isAbsolute(value)) throw new Error(`${label} requiere una ruta absoluta.`);
  }
  if (folderId && !/^(?:root|[A-Za-z0-9_-]{10,200})$/.test(folderId)) throw new Error('--folder-id no tiene un formato de carpeta Google válido.');
  const executable = await lstat(rclone);
  if (!executable.isFile() || executable.isSymbolicLink() || !(executable.mode & 0o111)) throw new Error('No se encontró un binario rclone ejecutable en la ruta indicada.');
  await validateMount(mount, cache);
  const credentials = await readGoogleDriveMountCredentials({ googleOAuthClientFile: clientFile, googleOAuthKeyFile: keyFile, googleOAuthTokenFile: tokenFile, publicUrl: 'https://jrplexps.duckdns.org' }, { projectRoot });
  const child = spawnImpl(rclone, rcloneMountArgs(mount, cache), { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'], env: rcloneEnvironment(credentials, sourceEnv, folderId) });
  let stopping = false;
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('No se pudo iniciar rclone mount.')));
      child.once('exit', (code, signal) => {
        if (stopping) resolve();
        else reject(new Error(`rclone mount terminó inesperadamente (${Number.isInteger(code) ? `código ${code}` : signal || 'sin estado'}).`));
      });
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opt = args(['rclone', 'client-file', 'key-file', 'token-file', 'mount', 'cache', 'folder-id', 'help'], ['help']);
    if (opt.help) console.log('node scripts/google-drive-mount.mjs [--rclone /ruta/rclone] [--client-file /ruta/google-web.json] [--key-file /ruta/google-drive.key] [--token-file /ruta/token.enc] [--mount /ruta/media/cloud] [--cache /ruta/cache] [--folder-id ID]\nMonta Google Drive en solo lectura usando el token web cifrado; rclone recibe el token solo en su entorno de proceso y no se escribe un rclone.conf con el token.');
    else {
      await runGoogleDriveMount(opt);
      console.log('El proceso de montaje Google Drive finalizó.');
    }
  } catch (error) { fail(error); }
}
