import { randomBytes } from 'node:crypto';
import { args, privateBackend, prompt, jsonRequest, fail } from './lib.mjs';

try {
  const opt = args(['url', 'username', 'local-media', 'cloud-media', 'downloads', 'help'], ['help']);
  if (opt.help) {
    console.log('node scripts/bootstrap.mjs --url http://127.0.0.1:8096 [--username administrador] [--local-media /media/local] [--cloud-media /media/cloud] [--downloads /media/downloads]\nSolicita contraseña por stdin sin eco y nunca la guarda. Rechaza servidores ya configurados. Usa solamente antes de publicar.');
  } else {
    const base = privateBackend(opt.url ?? 'http://127.0.0.1:8096');
    const initial = await jsonRequest(base, '/System/Info/Public');
    if (initial?.StartupWizardCompleted === true) throw new Error('El servidor ya está configurado. No se modificó: administra usuarios/bibliotecas con su cuenta existente.');
    if (initial?.StartupWizardCompleted !== false) throw new Error('No se pudo verificar que el asistente esté pendiente; operación detenida.');
    const username = (opt.username ?? await prompt('Nombre administrador: ')).trim();
    if (!/^[\p{L}\p{N}_.@ -]{3,64}$/u.test(username)) throw new Error('Nombre administrador inválido (3–64 caracteres).');
    let password = await prompt('Contraseña administrador (mínimo 16 caracteres, sin eco): ', true);
    let confirmation = await prompt('Repite contraseña: ', true);
    if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');
    confirmation = '';
    if (password.length < 16 || password.length > 256 || new Set(password).size < 8) throw new Error('Usa una contraseña única de 16–256 caracteres con al menos 8 caracteres diferentes.');
    await jsonRequest(base, '/Startup/User'); // Initializes the first-user record before setting it.
    await jsonRequest(base, '/Startup/Configuration', { method: 'POST', body: { ServerName: 'JRPlex', UICulture: 'es', MetadataCountryCode: 'ES', PreferredMetadataLanguage: 'es' } });
    try {
      await jsonRequest(base, '/Startup/User', { method: 'POST', body: { Name: username, Password: password } });
    } catch (error) {
      // A previous interrupted run may already have set its password. Never reset it.
      if (!error.message.endsWith('HTTP 403.')) throw error;
    }
    const auth = await jsonRequest(base, '/Users/AuthenticateByName', {
      method: 'POST', body: { Username: username, Pw: password },
      headers: { Authorization: `MediaBrowser Client="JRPlex Setup", Device="Setup CLI", DeviceId="${randomBytes(16).toString('hex')}", Version="0.1.0"` },
    });
    password = '';
    const token = auth?.AccessToken;
    if (!token) throw new Error('El motor no devolvió una sesión válida.');
    try {
      const me = await jsonRequest(base, '/Users/Me', { token });
      if (!me?.Policy?.IsAdministrator) throw new Error('La cuenta inicial no es administradora. Asistente sin completar.');
      const existing = await jsonRequest(base, '/Library/VirtualFolders', { token });
      for (const [key, name] of [['local-media', 'Local'], ['cloud-media', 'Nube'], ['downloads', 'Descargas']]) {
        if (!opt[key]) continue;
        const mediaPath = opt[key];
        if (!mediaPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(mediaPath)) throw new Error(`--${key} debe ser ruta absoluta vista por Jellyfin.`);
        if (existing.some(folder => folder.Name === name)) continue;
        await jsonRequest(base, `/Library/VirtualFolders?name=${encodeURIComponent(name)}&refreshLibrary=false`, {
          method: 'POST', token, body: { LibraryOptions: { EnableRealtimeMonitor: key !== 'cloud-media', SaveLocalMetadata: false, PathInfos: [{ Path: mediaPath }] } },
        });
      }
      await jsonRequest(base, '/Startup/RemoteAccess', { method: 'POST', token, body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
      await jsonRequest(base, '/Startup/Complete', { method: 'POST', token });
      const done = await jsonRequest(base, '/System/Info/Public');
      if (done?.StartupWizardCompleted !== true) throw new Error('El motor no confirmó el fin del asistente.');
      console.log(`Bootstrap verificado. Motor ${done.Version ?? 'versión no declarada'}; asistente completado; administrador autenticado. Ninguna contraseña guardada.`);
      console.log('Ejecuta smoke contra JRPlex antes de activar publicación. Verifica en Jellyfin que UPnP/DLNA estén desactivados y las bibliotecas tengan permisos correctos.');
    } finally {
      await jsonRequest(base, '/Sessions/Logout', { method: 'POST', token }).catch(() => {});
    }
  }
} catch (error) { fail(error); }
