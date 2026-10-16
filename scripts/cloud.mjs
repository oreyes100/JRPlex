import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { args, project, fail } from './lib.mjs';

async function run(argv) {
  return await new Promise((resolve, reject) => {
    const child = spawn('rclone', argv, { stdio: 'inherit', shell: false, windowsHide: true });
    child.on('error', () => reject(new Error('No se pudo iniciar rclone. Instala la versión oficial para este sistema.')));
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`rclone terminó ${signal ? `con señal ${signal}` : `con código ${code}`}; revisa el mensaje local sin publicar secretos.`)));
  });
}

try {
  const opt = args(['action', 'config', 'password-command', 'remote', 'mount', 'cache', 'cache-size', 'help'], ['help']);
  if (opt.help) {
    console.log('node scripts/cloud.mjs --action init|config|check|mount|nfsmount --config /ruta/externa/rclone.conf --password-command "/ruta/al/gestor" [--remote nombre:carpeta --mount /ruta/nube --cache /ruta/cache --cache-size 10G]\ninit cifra una configuración nueva vacía; config abre OAuth oficial; check valida cifrado; mount expone nube solo lectura. Contraseña separada en gestor del sistema.');
  } else {
    if (!['init', 'config', 'check', 'mount', 'nfsmount'].includes(opt.action)) throw new Error('Falta --action init|config|check|mount|nfsmount.');
    if (!opt.config || !path.isAbsolute(opt.config)) throw new Error('--config debe ser una ruta absoluta fuera del repositorio.');
    const config = path.resolve(opt.config);
    let repository = project;
    for (let ancestor = project; ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
      try { await stat(path.join(ancestor, '.git')); repository = ancestor; break; } catch {}
    }
    const outsideRepository = (candidate) => {
      const relative = path.relative(repository, candidate);
      return relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
    };
    const existingTarget = await realpath(config).catch(() => config);
    if (!outsideRepository(existingTarget)) throw new Error('La configuración de nube debe quedar fuera del repositorio, incluso a través de enlaces.');
    if (!opt['password-command'] || /[\r\n]/.test(opt['password-command'])) throw new Error('Falta --password-command con un comando que consulte el gestor de secretos. Nunca escribas una contraseña literal aquí.');
    await mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
    if (!outsideRepository(await realpath(path.dirname(config)))) throw new Error('La carpeta resuelve dentro del repositorio; operación detenida.');
    const common = ['--config', config, '--password-command', opt['password-command']];
    if (opt.action === 'init') {
      try { await stat(config); throw new Error('Ya existe configuración. init no cambia contraseñas existentes; usa check/config.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await run(['config', 'encryption', 'set', ...common]);
    }
    if (opt.action !== 'init') {
      const firstBytes = (await readFile(config, 'utf8')).slice(0, 64);
      if (!firstBytes.includes('RCLONE_ENCRYPT_V0:')) throw new Error('La configuración no tiene formato cifrado. Protege/cifra el archivo antes de continuar.');
    }
    await run(['config', 'encryption', 'check', ...common]);
    if (opt.action === 'config') await run(['config', ...common]);
    if (['mount', 'nfsmount'].includes(opt.action)) {
      if (!opt.remote || !/^[A-Za-z0-9_][\w .-]*:/.test(opt.remote)) throw new Error('Falta --remote nombre:carpeta de un proveedor ya autorizado.');
      if (!opt.mount || !path.isAbsolute(opt.mount) || !opt.cache || !path.isAbsolute(opt.cache)) throw new Error('--mount y --cache deben ser rutas absolutas diferentes.');
      if (path.resolve(opt.mount) === path.resolve(opt.cache)) throw new Error('La caché debe ser distinta del punto de montaje.');
      if (!/^\d+(?:\.\d+)?[KMGTP]$/i.test(opt['cache-size'] ?? '10G')) throw new Error('--cache-size esperado: 10G, 512M, etc.');
      const mountInfo = await stat(opt.mount).catch(() => null);
      if (process.platform !== 'win32' && !mountInfo?.isDirectory()) throw new Error('Crea antes un directorio vacío de montaje con permisos del usuario de Jellyfin.');
      if (mountInfo?.isDirectory() && (await readdir(opt.mount)).length !== 0) throw new Error('El punto de montaje debe estar vacío para no ocultar archivos existentes.');
      await mkdir(opt.cache, { recursive: true, mode: 0o700 });
      console.log('Montaje read-only en primer plano. Detén la reproducción antes de desmontar. Caché de medios local: protege/cifra su disco.');
      await run([opt.action, opt.remote, opt.mount, ...common, '--read-only', '--vfs-cache-mode', 'full', '--vfs-cache-max-size', opt['cache-size'] ?? '10G', '--vfs-cache-min-free-space', '2G', '--vfs-cache-max-age', '24h', '--buffer-size', '16M', '--dir-cache-time', '5m', '--log-level', 'ERROR']);
    } else {
      console.log('Configuración cifrada y descifrado comprobados. Falta verificar un archivo real y reproducción para aprobar la integración de nube.');
    }
  }
} catch (error) { fail(error); }
