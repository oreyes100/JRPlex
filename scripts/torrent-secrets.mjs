import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { args, project, loadEnv, prompt, fail } from './lib.mjs';

try {
  const opt = args(['mode', 'help'], ['help']);
  if (opt.help) {
    console.log('node scripts/torrent-secrets.mjs --mode compose|native\nCompose genera una contraseña aleatoria y configura qBittorrent ANTES de arrancarlo. Native solicita las credenciales existentes. No imprime ni sobrescribe credenciales.');
  } else {
    const mode = opt.mode ?? 'compose';
    if (!['compose', 'native'].includes(mode)) throw new Error('Modo esperado: compose o native.');
    const env = await loadEnv();
    const data = path.resolve(project, env.JRP_DATA_DIR ?? './runtime');
    const files = [path.join(data, 'secrets/qb-username'), path.join(data, 'secrets/qb-password')];
    await mkdir(path.join(data, 'secrets'), { recursive: true, mode: 0o700 });
    for (const file of files) {
      try { if ((await stat(file)).size > 0) throw new Error('Ya hay credenciales. Se conservaron; no se permite rotación implícita.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const config = path.join(data, 'qbittorrent/qBittorrent/qBittorrent.conf');
    if (mode === 'compose') {
      if (process.platform !== 'linux') throw new Error('El perfil contenedor qBittorrent se prepara en el host Linux; usa --mode native aquí.');
      try { await stat(config); throw new Error('Ya hay configuración qBittorrent. No se modificó. Detén el servicio y revisa una migración explícita.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const username = mode === 'compose' ? 'jrplex-service' : (await prompt('Usuario qBittorrent existente: ')).trim();
    let password = mode === 'compose' ? randomBytes(36).toString('base64url') : await prompt('Contraseña existente (sin eco): ', true);
    if (!username || /[\r\n]/.test(username) || password.length < 16) throw new Error('Usa usuario válido y contraseña única de 16 caracteres o más.');
    if (mode === 'compose') {
      const salt = randomBytes(16);
      const hash = pbkdf2Sync(password, salt, 100000, 64, 'sha512');
      const configText = [
        '[LegalNotice]', 'Accepted=true', '',
        '[BitTorrent]',
        'Session\\DefaultSavePath=/downloads/complete',
        'Session\\TempPath=/downloads/incomplete',
        'Session\\TempPathEnabled=true',
        'Session\\AddExtensionToIncompleteFiles=true',
        'Session\\GlobalMaxRatio=1',
        'Session\\QueueingSystemEnabled=true',
        'Session\\MaxActiveDownloads=2',
        'Session\\MaxActiveTorrents=3',
        'Session\\SSRFMitigation=true',
        'Session\\ValidateHTTPSTrackerCertificate=true', '',
        '[Network]', 'PortForwardingEnabled=false', '',
        '[Preferences]',
        'WebUI\\Address=*', 'WebUI\\Port=8080',
        `WebUI\\Username=${username}`,
        `WebUI\\Password_PBKDF2="@ByteArray(${salt.toString('base64')}:${hash.toString('base64')})"`,
        'WebUI\\LocalHostAuth=true', 'WebUI\\AuthSubnetWhitelistEnabled=false',
        'WebUI\\CSRFProtection=true', 'WebUI\\ClickjackingProtection=true',
        'WebUI\\HostHeaderValidation=true',
        'WebUI\\ServerDomains="qbittorrent;127.0.0.1;localhost"', 'WebUI\\UseUPnP=false', '',
        '[AutoRun]', 'enabled=false', 'OnTorrentAdded\\Enabled=false', '',
      ].join('\n');
      await mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
      await writeFile(config, configText, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(files[0], username, { mode: 0o600 });
    await writeFile(files[1], password, { mode: 0o600 });
    password = '';
    console.log('Credenciales guardadas solo bajo runtime/secrets con permisos de propietario. No se mostraron contraseñas.');
    console.log(mode === 'compose' ? 'Configuración qBittorrent 5.2.4 preparada con PBKDF2 y carpetas separadas. Revisa QB_URL en .env antes de activar --profile torrents.' : 'Configura QB_URL=http://127.0.0.1:8080 y usa los mismos archivos en QB_USERNAME_FILE/QB_PASSWORD_FILE.');
  }
} catch (error) { fail(error); }
