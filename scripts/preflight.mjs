import { access, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { args, project, loadEnv, privateBackend, fail } from './lib.mjs';

function check(condition, description) {
  console.log(`${condition ? 'APROBADA' : 'FALLIDA'}: ${description}`);
  if (!condition) process.exitCode = 1;
}
function run(command, argv) {
  return spawnSync(command, argv, { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}

try {
  const opt = args(['mode', 'images', 'help'], ['images', 'help']);
  if (opt.help) {
    console.log('node scripts/preflight.mjs --mode compose|native [--images]\nInspección sin cambios. --images consulta manifests del registry; no descarga capas ni arranca servicios.');
  } else {
    const mode = opt.mode ?? (process.platform === 'linux' ? 'compose' : 'native');
    if (!['compose', 'native'].includes(mode)) throw new Error('Modo esperado: compose o native.');
    check(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js >=22');
    const env = await loadEnv();
    const site = new URL(env.PUBLIC_URL);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(site.hostname);
    check(!site.username && !site.password && !site.search && !site.hash && (site.pathname === '/' || !site.pathname), 'PUBLIC_URL sin credenciales, query ni subruta');
    check(site.protocol === 'https:' || (local && site.protocol === 'http:'), 'HTTPS para cualquier publicación fuera de loopback');
    check(!Object.keys(env).some(key => /(PASSWORD|TOKEN|SECRET|API_KEY)$/.test(key)), '.env contiene configuración y rutas, sin valores secretos');
    const data = path.resolve(project, env.JRP_DATA_DIR ?? './runtime');
    for (const [key, fallback] of [['LOCAL_MEDIA', 'media/local'], ['CLOUD_MEDIA', 'media/cloud'], ['DOWNLOADS_COMPLETE', 'downloads/complete'], ['DOWNLOADS_INCOMPLETE', 'downloads/incomplete']]) {
      const media = path.resolve(project, env[key] ?? path.join(data, fallback));
      try { check((await stat(media)).isDirectory(), `${key}: directorio existente`); } catch { check(false, `${key}: falta el directorio configurado`); }
    }
    const complete = path.resolve(project, env.DOWNLOADS_COMPLETE ?? path.join(data, 'downloads/complete'));
    const incomplete = path.resolve(project, env.DOWNLOADS_INCOMPLETE ?? path.join(data, 'downloads/incomplete'));
    check(complete !== incomplete && !complete.startsWith(incomplete + path.sep) && !incomplete.startsWith(complete + path.sep), 'Descargas completas e incompletas en directorios separados');
    if (mode === 'compose') {
      check(process.platform === 'linux', 'Jellyfin Docker sobre Linux soportado');
      check(Number(env.JRP_UID) > 0 && Number(env.JRP_GID) > 0, 'UID y GID no root');
      if (process.getuid) check(Number(env.JRP_UID) === process.getuid(), 'UID de contenedores coincide con propietario que prepara datos');
      const docker = run('docker', ['compose', 'version']);
      check(docker.status === 0, 'Docker Compose disponible');
      if (docker.status === 0) {
        const config = run('docker', ['compose', 'config', '--quiet']);
        check(config.status === 0, 'Compose resuelve configuración y montajes');
        const daemon = run('docker', ['info', '--format', '{{.OSType}}']);
        check(daemon.status === 0 && daemon.stdout.trim() === 'linux', 'Docker daemon Linux accesible');
      }
      for (const key of ['JELLYFIN_IMAGE', 'CADDY_IMAGE', 'QB_IMAGE']) {
        const image = env[key] ?? '';
        const pinned = /@sha256:[a-f0-9]{64}$/.test(image) || /:[0-9][\w.\-]*$/.test(image);
        check(pinned, `${key}: versión explícita o digest`);
        if (opt.images && pinned && docker.status === 0) {
          const inspected = run('docker', ['manifest', 'inspect', image]);
          check(inspected.status === 0, `${key}: manifest presente en registry (no demuestra arranque)`);
        }
      }
      for (const name of ['qb-username', 'qb-password']) {
        try {
          await access(path.join(data, 'secrets', name));
          const permissions = await stat(path.join(data, 'secrets', name));
          check((permissions.mode & 0o077) === 0, `${name}: permisos restringidos al propietario`);
        } catch { check(false, `${name}: placeholder/archivo secreto preparado`); }
      }
      if (env.QB_URL) {
        check(env.QB_URL === 'http://qbittorrent:8080', 'QB_URL coincide con servicio privado de Compose');
        try { await access(path.join(data, 'qbittorrent/qBittorrent/qBittorrent.conf')); }
        catch { check(false, 'Preparar torrents antes del perfil torrents: scripts/torrent-secrets.mjs'); }
      }
    } else {
      privateBackend(env.JELLYFIN_URL);
      check(true, 'Backend Jellyfin nativo privado configurado');
      console.log('PENDIENTE: arranque nativo, permisos de servicio y reproducción real en este sistema. Usa scripts/smoke.mjs.');
    }
    console.log('PENDIENTE: comprobar archivo remoto real, descarga finalizada, reproducción, restauración y acceso HTTPS exterior. Preflight no aprueba publicación.');
  }
} catch (error) { fail(error); }
