import { randomBytes } from 'node:crypto';
import { args, privateBackend, prompt, jsonRequest, fail } from './lib.mjs';

const results = [];
function check(ok, name) {
  results.push({ name, status: ok ? 'APROBADA' : 'FALLIDA' });
  console.log(`${ok ? 'APROBADA' : 'FALLIDA'}: ${name}`);
}
function pending(name) { results.push({ name, status: 'PENDIENTE' }); console.log(`PENDIENTE: ${name}`); }
function noSecrets(value) {
  if (!value || typeof value !== 'object') return true;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:AccessToken|api_key|X-Emby-Token|Password|Password_PBKDF2|OpenToken|Path)$/i.test(key)) return false;
    if (typeof child === 'string' && /[?&](?:api_key|access_token|token)=(?!\[redacted\])[^&#\s]+/i.test(child)) return false;
    if (child && typeof child === 'object' && !noSecrets(child)) return false;
  }
  return true;
}

try {
  const opt = args(['url', 'origin', 'username', 'item', 'restricted-item', 'jellyfin-url', 'local', 'expect-viewer', 'help'], ['local', 'expect-viewer', 'help']);
  if (opt.help) {
    console.log('node scripts/smoke.mjs --url https://jrplex.example.org [--origin https://jrplex.example.org] [--username usuario] [--item ID_VIDEO_MP4_COMPATIBLE] [--restricted-item ID_DENEGADO] [--expect-viewer] [--jellyfin-url http://127.0.0.1:8096] [--local]\nPruebas HTTP contra servicios reales. Pide contraseña por stdin sin eco. Sin --local exige HTTPS y certificado válido. No añade usuarios ni torrents.');
  } else {
    if (!opt.url) throw new Error('Falta --url de la instancia real.');
    const base = new URL(opt.url);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Usa origen sin credenciales, query ni subruta.');
    if (opt.local) privateBackend(base.toString());
    else if (base.protocol !== 'https:') throw new Error('La aceptación pública exige HTTPS. Usa --local solo para diagnóstico interno.');
    const origin = opt.origin ?? base.origin;
    if (new URL(origin).origin !== origin) throw new Error('--origin debe ser un origen HTTP(S) válido.');
    let cookie;
    let csrf;
    async function request(endpoint, { method = 'GET', body, auth = false, includeCsrf = true, requestOrigin = origin, headers = {} } = {}) {
      return await fetch(new URL(endpoint, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(auth ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(!['GET', 'HEAD'].includes(method) ? { Origin: requestOrigin } : {}), ...(auth && includeCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }
    let response = await request('/healthz');
    check(response.status === 200, 'Proceso gateway responde /healthz');
    await response.body?.cancel();
    response = await request('/');
    check(response.status === 200 && /text\/html/.test(response.headers.get('content-type') ?? ''), 'Interfaz web servida');
    await response.body?.cancel();
    for (const route of ['/api/session', '/jellyfin/Items']) {
      response = await request(route);
      check(response.status === 401, `Anónimo bloqueado en ${route}`);
      await response.body?.cancel();
    }
    response = await request('/api/login', { method: 'POST', body: { username: 'jrplex-invalid-' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('base64url') } });
    check([401, 403].includes(response.status), 'Credenciales inválidas rechazadas');
    await response.body?.cancel();
    const username = opt.username ?? await prompt('Usuario de prueba existente: ');
    let password = await prompt('Contraseña (sin eco): ', true);
    response = await request('/api/login', { method: 'POST', body: { username, password } });
    password = '';
    if (response.status !== 200) throw new Error(`Login real devolvió HTTP ${response.status}; no se muestran respuestas ni contraseñas.`);
    const setCookie = response.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0];
    const login = await response.json();
    csrf = login.csrfToken;
    check(Boolean(cookie && csrf && login.user?.Id), 'Login válido devuelve sesión opaca');
    check(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Path=\//.test(setCookie) && (!origin.startsWith('https:') || /; Secure/i.test(setCookie)), 'Cookie HttpOnly/SameSite/Path y Secure sobre HTTPS');
    check(noSecrets(login), 'Login sin token Jellyfin ni credenciales upstream');
    try {
      response = await request('/api/session', { auth: true });
      const session = response.status === 200 ? await response.json() : null;
      check(response.status === 200 && session?.user?.Id === login.user.Id, 'Sesión real validada por Jellyfin');
      check(noSecrets(session), 'Sesión sin secretos de backend');
      response = await request('/api/logout', { method: 'POST', body: {}, auth: true, includeCsrf: false });
      check(response.status === 403, 'Mutación sin CSRF rechazada');
      await response.body?.cancel();
      response = await request('/api/logout', { method: 'POST', body: {}, auth: true, requestOrigin: 'https://jrplex-attacker.invalid' });
      check(response.status === 403, 'Mutación con origen ajeno rechazada');
      await response.body?.cancel();
      response = await request('/jellyfin/Items?Recursive=true&Limit=5&Fields=Overview,MediaSources,MediaStreams', { auth: true });
      const catalogue = response.status === 200 ? await response.json() : null;
      check(response.status === 200 && Array.isArray(catalogue?.Items), 'Catálogo contra motor real');
      check(noSecrets(catalogue), 'Catálogo sin rutas privadas ni tokens upstream');
      response = await request('/jellyfin/System/Configuration', { auth: true });
      check(response.status === 403, 'Configuración interna no publicada por gateway');
      await response.body?.cancel();
      if (opt['expect-viewer']) {
        response = await request('/jellyfin/Users', { auth: true });
        check(response.status === 403, 'Usuario ordinario no enumera administración');
        await response.body?.cancel();
      } else pending('Repetir con usuario ordinario y --expect-viewer para probar aislamiento admin');
      if (opt['restricted-item']) {
        response = await request(`/jellyfin/Items/${encodeURIComponent(opt['restricted-item'])}`, { auth: true });
        check([403, 404].includes(response.status), 'Biblioteca denegada inaccesible por ID directo');
        await response.body?.cancel();
      } else pending('Aislamiento de biblioteca: requiere ID real denegado y --restricted-item');
      if (opt.item) {
        if (!/^[A-Za-z0-9_-]+$/.test(opt.item)) throw new Error('--item debe ser un ID de vídeo real.');
        response = await request(`/jellyfin/Videos/${opt.item}/stream.mp4?Static=true`, { auth: true, headers: { Range: 'bytes=0-1023' } });
        const ranged = response.status === 206 && /^bytes 0-1023\//.test(response.headers.get('content-range') ?? '');
        check(ranged, 'Vídeo real: HTTP 206 y Content-Range correctos');
        if (ranged) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          check(bytes.length === 1024, 'Rango devuelve exactamente 1024 bytes');
        } else await response.body?.cancel();
      } else pending('Rango y reproducción: requiere medio MP4 real compatible y --item');
    } finally {
      response = await request('/api/logout', { method: 'POST', body: {}, auth: true });
      check([200, 204].includes(response.status), 'Logout real completado');
      await response.body?.cancel();
      response = await request('/api/session', { auth: true });
      check(response.status === 401, 'Cookie anterior revocada tras logout');
      await response.body?.cancel();
    }
    if (opt['jellyfin-url']) {
      const backend = privateBackend(opt['jellyfin-url']);
      const health = await fetch(new URL('/health', backend), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      check(health.status === 200, 'Motor /health comprueba HTTP y base de datos');
      await health.body?.cancel();
      const info = await jsonRequest(backend, '/System/Info/Public');
      check(info?.StartupWizardCompleted === true, 'Asistente del motor cerrado antes de publicación');
      console.log(`INFO: versión del motor ${String(info?.Version ?? 'no declarada').replace(/[^A-Za-z0-9._-]/g, '')}`);
    } else pending('Comprobación directa del motor/asistente: --jellyfin-url privado');
    pending('Reproducción visual, transcodificación/HLS, nube real, torrent finalizado y restauración requieren sus pruebas específicas');
    const failed = results.filter(r => r.status === 'FALLIDA').length;
    const incomplete = results.filter(r => r.status === 'PENDIENTE').length;
    console.log(`Resultado smoke: ${failed} fallos; ${incomplete} comprobaciones pendientes. No equivale a aprobación general de Gauntlet.`);
    process.exitCode = failed ? 1 : 0;
  }
} catch (error) { fail(error); }
