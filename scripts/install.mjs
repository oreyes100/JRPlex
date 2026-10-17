import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import path from 'node:path';
import { args, project, fail } from './lib.mjs';

try {
  const opt = args(['mode', 'dry-run', 'help'], ['dry-run', 'help']);
  if (opt.help) {
    console.log('node scripts/install.mjs --mode compose|native [--dry-run]\nPrepara .env y directorios locales. No instala software, arranca servicios ni publica puertos.');
  } else {
    const mode = opt.mode ?? (process.platform === 'linux' ? 'compose' : 'native');
    if (!['compose', 'native'].includes(mode)) throw new Error('Modo esperado: compose o native.');
    if (mode === 'compose' && process.platform !== 'linux') throw new Error('Jellyfin en contenedor solo se soporta aquí sobre Linux. Usa --mode native en Windows/macOS.');
    if (process.getuid?.() === 0 && !opt['dry-run']) throw new Error('Ejecuta el instalador como cuenta no root para crear datos con propietario seguro.');
    const folders = ['jellyfin/config', 'jellyfin/cache', 'media/local', 'media/cloud', 'downloads/complete', 'downloads/incomplete', 'qbittorrent/qBittorrent', 'caddy/data', 'caddy/config', 'secrets', 'tv'];
    if (opt['dry-run']) {
      console.log(`Modo ${mode}; raíz ${project}; se crearían .env si falta y ${folders.length} directorios bajo runtime/. Sin cambios.`);
    } else {
      for (const folder of folders) await mkdir(path.join(project, 'runtime', folder), { recursive: true, mode: 0o700 });
      for (const name of ['qb-username', 'qb-password']) {
        try { await writeFile(path.join(project, 'runtime', 'secrets', name), '', { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const envPath = path.join(project, '.env');
      let exists = false;
      try { await access(envPath); exists = true; } catch {}
      if (!exists) {
        let content = await readFile(path.join(project, '.env.example'), 'utf8');
        if (process.getuid) {
          content = content.replace(/^JRP_UID=.*$/m, `JRP_UID=${process.getuid()}`).replace(/^JRP_GID=.*$/m, `JRP_GID=${process.getgid()}`);
        }
        await writeFile(envPath, content, { flag: 'wx', mode: 0o600 });
      }
      if (process.platform !== 'win32') await chmod(envPath, 0o600);
      console.log(`Preparación ${mode} terminada. ${exists ? '.env existente conservado.' : '.env creado sin credenciales.'}`);
      console.log('Revisa rutas y PUBLIC_URL; después ejecuta scripts/preflight.mjs. No se arrancó ningún servicio.');
    }
  }
} catch (error) { fail(error); }
