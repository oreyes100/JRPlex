import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HttpError, loadConfig, opaque, equal, safePath, cleanQuery, sanitizeJson, rewritePlaylist, boundedBody, requireStrongPassword, normalizeIp } from './lib/security.mjs';
import { mediaFolderPath, replaceLibraryPath } from './lib/library-mapping.mjs';
import { createTorrentClient } from './lib/torrents.mjs';
import { createGoogleDriveOAuth, googleDriveFolderIdFromUrl } from './lib/google-drive-oauth.mjs';
import { isCloudMountActive } from './lib/cloud-mount-status.mjs';
import { createCasting } from './lib/casting.mjs';
import { createTvAccess } from './lib/tv-access.mjs';

export { loadConfig } from './lib/security.mjs';
const projectRoot = dirname(fileURLToPath(import.meta.url));
const mutation = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const jsonType = (response) => /(?:application\/json|\+json)/i.test(response.headers.get('content-type') || '');
const publicUser = (user) => ({ Id: user.Id, Name: user.Name, Policy: { IsAdministrator: !!user.Policy?.IsAdministrator, IsDisabled: !!user.Policy?.IsDisabled, EnableMediaPlayback: user.Policy?.EnableMediaPlayback !== false, EnableContentDownloading: !!user.Policy?.EnableContentDownloading } });

export function createApp(config = loadConfig(), options = {}) {
  const sessions = new Map();
  let casting; let tvAccess;
  function dropSession(id) { sessions.delete(id); casting?.revokeSession(id); tvAccess?.revokeSession(id); }
  const attempts = new Map();
  const mappingOperations = new Set();
  const torrent = options.torrentClient || createTorrentClient(config);
  const googleOAuth = options.googleOAuth || createGoogleDriveOAuth(config, { projectRoot });
  const cloudMountStatus = options.cloudMountStatus || (async () => {
    try { return isCloudMountActive(await readFile('/var/lib/jrplex/google-drive-mount/mount-status', 'utf8')); } catch { return false; }
  });
  const cookieName = config.publicUrl.startsWith('https:') ? '__Host-jrplex_session' : 'jrplex_session';
  const publicDir = resolve(options.publicDir || resolve(projectRoot, 'public'));
  const counters = { requests: 0 };

  function send(res, status, data, headers = {}) {
    if (res.destroyed) return;
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }
  function cookie(id, ttl = config.sessionTtl) { return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${config.publicUrl.startsWith('https:') ? '; Secure' : ''}`; }
  function sessionFor(req) {
    const found = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    const id = found?.slice(cookieName.length + 1);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expires <= Date.now()) { if (id) dropSession(id); throw new HttpError(401, 'Authentication required'); }
    return { id, ...session };
  }
  function sameOrigin(req) { if (req.headers.origin !== config.publicUrl) throw new HttpError(403, 'Origin rejected'); }
  function csrf(req, session) { sameOrigin(req); if (!equal(req.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'CSRF token rejected'); }
  function clientIp(req) {
    const socketIp = normalizeIp(req.socket.remoteAddress) || 'unknown';
    if ((config.trustedProxyIps || []).includes(socketIp)) return normalizeIp(req.headers['x-real-ip']) || socketIp;
    return socketIp;
  }
  function rateLimit(key, max) {
    const attempt = attempts.get(key);
    if (attempt?.until > Date.now() && attempt.count >= max) throw new HttpError(429, 'Too many sign-in attempts; try later');
    if (!attempt && attempts.size >= 20000) throw new HttpError(429, 'Too many sign-in attempts; try later');
    attempts.set(key, { count: attempt?.until > Date.now() ? attempt.count + 1 : 1, until: attempt?.until > Date.now() ? attempt.until : Date.now() + 10 * 60000 });
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
    if (Number(req.headers['content-length'] || 0) > config.maxBody) throw new HttpError(413, 'Request too large');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > config.maxBody) throw new HttpError(413, 'Request too large'); chunks.push(chunk); }
    try { const parsed = JSON.parse(Buffer.concat(chunks).toString()); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw 0; return parsed; } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  async function upstream(path, { session, method = 'GET', body: requestBody, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeout); timer.unref?.();
    try {
      const response = await fetch(`${config.jellyfinUrl}${path}`, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `MediaBrowser Client="JRPlex", Device="${session?.kind === 'tv' ? 'Fire TV' : 'Web'}", DeviceId="${session?.deviceId || 'JRPlex-Gateway'}", Version="${session?.kind === 'tv' ? '2.0.0' : '0.1.0'}"${session?.token ? `, Token="${session.token}"` : ''}`, ...headers },
        ...(requestBody ? { body: requestBody } : {}),
      });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'Upstream redirect rejected'); }
      return response;
    } finally { clearTimeout(timer); }
  }
  async function jsonResponse(response) {
    let result;
    try { result = JSON.parse((await boundedBody(response.body, config.maxJson, config.upstreamTimeout)).toString()); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'Invalid media server response'); }
    return result;
  }
  async function currentUser(session) {
    const response = await upstream('/Users/Me', { session });
    if (response.status === 401 || response.status === 403) { dropSession(session.id); await response.body?.cancel(); throw new HttpError(401, 'Session expired'); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Media server unavailable'); }
    const user = await jsonResponse(response);
    if (user.Id !== session.user.Id || user.Policy?.IsDisabled) { dropSession(session.id); throw new HttpError(401, 'Session expired'); }
    return user;
  }
  async function requireAdmin(session) { const user = await currentUser(session); if (!user.Policy?.IsAdministrator) throw new HttpError(403, 'Administrator required'); return user; }
  function isDriveFolderLink(value) {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return url.origin === 'https://drive.google.com' && url.pathname.startsWith('/drive/folders/'); } catch { return false; }
  }
  async function resolveLibraryPath(value) {
    if (!isDriveFolderLink(value)) return mediaFolderPath(value);
    googleDriveFolderIdFromUrl(value);
    if (typeof googleOAuth.resolveFolderUrl !== 'function') throw new HttpError(503, 'La exploración de Google Drive no está disponible en este servidor.');
    return mediaFolderPath(await googleOAuth.resolveFolderUrl(value));
  }
  async function authorizeItem(session, itemId) {
    const response = await upstream(`/Users/${encodeURIComponent(session.user.Id)}/Items/${encodeURIComponent(itemId)}`, { session });
    await response.body?.cancel();
    if (response.status === 401) throw new HttpError(401, 'Session expired');
    if (!response.ok) throw new HttpError(403, 'Item access denied');
  }
  function proxyPolicy(path, method, session) {
    const id = '[A-Za-z0-9_-]+';
    // Access to server filesystem, configuration, plugins and process control is intentionally not exposed.
    if (path === '/Users' && method === 'GET') return 'admin';
    if (path === '/Users/New' && method === 'POST') return 'admin';
    if (new RegExp(`^/Users/${id}/(?:Policy|Password)$`).test(path) && method === 'POST') return 'admin';
    if (new RegExp(`^/Users/${id}$`).test(path) && method === 'DELETE') return 'admin';
    if (path === '/Library/VirtualFolders' && ['GET', 'POST', 'DELETE'].includes(method)) return 'admin';
    if (path === '/Library/Refresh' && method === 'POST') return 'admin';
    if (path === '/Users/Me' && method === 'GET') return 'user';
    if (path === '/UserItems/Resume' && ['GET', 'HEAD'].includes(method)) return 'user';
    const ownUser = path.match(new RegExp(`^/Users/(${id})(?:/(.*))?$`));
    if (ownUser) {
      if (ownUser[1] !== session.user.Id) throw new HttpError(403, 'User access denied');
      const rest = ownUser[2] || '';
      if (['GET', 'HEAD'].includes(method) && /^(?:|Views|Items(?:\/.*)?)$/.test(rest)) return 'user';
      if (['POST', 'DELETE'].includes(method) && /^(?:FavoriteItems|PlayedItems)\/[A-Za-z0-9_-]+$/.test(rest)) return 'user';
      if (method === 'POST' && /^Items\/[A-Za-z0-9_-]+\/UserData$/.test(rest)) return 'user';
    }
    if (['GET', 'HEAD'].includes(method) && /^\/(?:Items(?:\/(?:Resume|Latest|Counts|Filters|Filters2|Root|[A-Za-z0-9_-]+(?:\/Images(?:\/[A-Za-z0-9_-]+(?:\/\d+)?)?|\/PlaybackInfo)?))?|Shows\/(?:NextUp|Upcoming|[A-Za-z0-9_-]+\/(?:Seasons|Episodes))|(?:Genres|Artists|Persons|MusicGenres)(?:\/[A-Za-z0-9_-]+(?:\/Images(?:\/[A-Za-z0-9_-]+(?:\/\d+)?)?)?)?|Videos\/[A-Za-z0-9_-]+\/.*|Audio\/[A-Za-z0-9_-]+\/.*)$/.test(path)) return 'user';
    if (method === 'POST' && new RegExp(`^/Items/${id}/PlaybackInfo$`).test(path)) return 'user';
    if (method === 'POST' && /^\/Sessions\/Playing(?:\/(?:Progress|Stopped))?$/.test(path)) return 'user';
    throw new HttpError(403, 'API route is not exposed');
  }

  async function proxy(req, res, route, session, { requestUrl = req.url, mapMediaUrl } = {}) {
    const path = route.slice('/jellyfin'.length);
    const policy = proxyPolicy(path, req.method, session);
    if (policy === 'admin') await requireAdmin(session);
    const url = cleanQuery(new URL(requestUrl, config.publicUrl));
    url.pathname = path;
    if (policy !== 'admin') {
      for (const key of [...url.searchParams.keys()]) if (/^(userId|userIds)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.set('userId', session.user.Id);
    }
    let itemId = path.match(/^\/(?:Videos|Audio)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] || path.match(/^\/(?:Items|Shows)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
    if (['Resume', 'Latest', 'Counts', 'Filters', 'Filters2', 'Root', 'NextUp', 'Upcoming'].includes(itemId)) itemId = null;
    if (itemId) await authorizeItem(session, itemId);
    let requestBody;
    if (mutation(req.method)) {
      csrf(req, session);
      const parsed = await body(req);
      if (path === '/Library/VirtualFolders' && req.method === 'POST' && Array.isArray(parsed.LibraryOptions?.PathInfos)) {
        for (const info of parsed.LibraryOptions.PathInfos) {
          if (!isDriveFolderLink(info?.Path)) continue;
          info.Path = await resolveLibraryPath(info.Path);
          const check = await upstream('/Environment/DirectoryContents?' + new URLSearchParams({ path: info.Path, includeFiles: 'false', includeDirectories: 'true' }), { session });
          await check.body?.cancel();
          if (!check.ok) throw new HttpError(400, 'Jellyfin no puede leer esa carpeta de Drive en el servidor. Selecciónala desde el explorador de carpetas.');
        }
      }
      if (path === '/Library/VirtualFolders' && req.method === 'POST' && url.searchParams.get('collectionType') === 'photos') {
        url.searchParams.set('collectionType', 'homevideos');
        parsed.LibraryOptions = { ...parsed.LibraryOptions, EnablePhotos: true };
      }
      if (path === '/Users/New') {
        requireStrongPassword(parsed.Password);
        if (typeof parsed.Name !== 'string' || !parsed.Name.trim() || parsed.Name.length > 64) throw new HttpError(400, 'A user name of at most 64 characters is required');
      }
      if (/^\/Users\/[A-Za-z0-9_-]+\/Password$/.test(path)) {
        requireStrongPassword(parsed.NewPw);
        if (parsed.ResetPassword) throw new HttpError(400, 'Password reset without a strong replacement is disabled');
      }
      // UserId is authoritative even if a caller supplies another key casing.
      if (policy !== 'admin') {
        for (const key of Object.keys(parsed)) if (/^userId$/i.test(key)) delete parsed[key];
        parsed.UserId = session.user.Id;
      }
      requestBody = JSON.stringify(parsed);
    }
    const headers = { ...(requestBody ? { 'Content-Type': 'application/json' } : {}) };
    for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) if (req.headers[name]) headers[name] = req.headers[name];
    const response = await upstream(`${url.pathname}${url.search}`, { session, method: req.method, body: requestBody, headers });
    if (!response.ok && response.status !== 304) { await response.body?.cancel(); if (response.status === 401) dropSession(session.id); throw new HttpError([400, 401, 403, 404, 416].includes(response.status) ? response.status : 502, 'Media request failed'); }
    if (req.method === 'HEAD' || response.status === 204 || response.status === 304) {
      const outgoing = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (response.headers.has(name)) outgoing[name] = response.headers.get(name);
      await response.body?.cancel(); res.writeHead(response.status, outgoing); res.end(); return;
    }
    if (jsonType(response)) {
      const mediaItemRoute = path === '/Items' || /^\/Items\/[A-Za-z0-9_-]+(?:\/PlaybackInfo)?$/.test(path);
      const includeMediaPaths = !!session.user.Policy?.IsAdministrator && mediaItemRoute;
      send(res, response.status, sanitizeJson(await jsonResponse(response), config, path, includeMediaPaths)); return;
    }
    if (/\.m3u8$/i.test(path) || /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(response.headers.get('content-type') || '')) {
      const playlist = rewritePlaylist((await boundedBody(response.body, 1024 * 1024, config.upstreamTimeout)).toString(), path, config, mapMediaUrl);
      res.writeHead(response.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(playlist) }); res.end(playlist); return;
    }
    const outgoing = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (response.headers.has(name)) outgoing[name] = response.headers.get(name);
    res.writeHead(response.status, outgoing);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
  }

  async function staticFile(req, res, route) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
    const aliases = { '/': 'home.html', '/app': 'index.html', '/app/': 'index.html', '/tv': 'tv.html', '/tv/': 'tv.html', '/activate': 'activate.html', '/activate/': 'activate.html', '/firetv': 'firetv.html', '/firetv/': 'firetv.html', '/privacy': 'privacy.html', '/privacy/': 'privacy.html' };
    const filename = aliases[route] || route.slice(1);
    if (filename.split('/').some((part) => part.startsWith('.'))) throw new HttpError(404, 'Not found');
    const path = resolve(publicDir, filename);
    if (!path.startsWith(publicDir + sep)) throw new HttpError(404, 'Not found');
    let data;
    try { const actual = await realpath(path); if (!actual.startsWith(publicDir + sep) || !(await stat(actual)).isFile()) throw 0; data = await readFile(actual); } catch { throw new HttpError(404, 'Not found'); }
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
  }

  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), presentation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' https://www.gstatic.com; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://www.gstatic.com; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.publicUrl.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const route = safePath(req.url);
      if (++counters.requests % 100 === 0) {
        for (const [id, session] of sessions) if (session.expires <= Date.now()) dropSession(id);
        for (const [ip, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(ip);
      }
      if (route === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { send(res, 200, { status: 'ok' }); return; }
      if (route === googleOAuth.callbackPath && ['GET', 'POST'].includes(req.method)) {
        let location = `${config.publicUrl}/app?cloud=google-error`;
        let callbackUrl = new URL(req.url, config.publicUrl);
        if (req.method === 'POST') {
          if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'OAuth form response required');
          if (Number(req.headers['content-length'] || 0) > 8192) throw new HttpError(413, 'OAuth response too large');
          const chunks = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > 8192) throw new HttpError(413, 'OAuth response too large'); chunks.push(chunk); }
          const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          for (const name of ['code', 'state', 'error']) if (params.getAll(name).length > 1) throw new HttpError(400, 'Invalid OAuth response');
          callbackUrl = new URL(googleOAuth.callbackPath, config.publicUrl);
          callbackUrl.search = params.toString();
        }
        try { location = (await googleOAuth.callback(callbackUrl.href)).redirect; }
        catch { if (callbackUrl.searchParams.has('error')) location = `${config.publicUrl}/app?cloud=google-cancelled`; }
        res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return;
      }
      if (route === '/api/login' && req.method === 'POST') {
        sameOrigin(req);
        const ip = clientIp(req);
        rateLimit(`ip:${ip}`, 200);
        const input = await body(req);
        if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username.trim() || input.username.length > 256 || input.password.length > 1024) throw new HttpError(400, 'Invalid credentials format');
        const bucket = `user:${ip}:${input.username.trim().normalize('NFKC').toLowerCase()}`;
        rateLimit(bucket, 10);
        const deviceId = opaque();
        const response = await upstream('/Users/AuthenticateByName', { session: { deviceId }, method: 'POST', body: JSON.stringify({ Username: input.username, Pw: input.password }), headers: { 'Content-Type': 'application/json' } });
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 401 || response.status === 403 ? 401 : 502, 'Sign-in failed'); }
        const authenticated = await jsonResponse(response);
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(authenticated.AccessToken || '') || !/^[A-Za-z0-9_-]+$/.test(authenticated.User?.Id || '') || authenticated.User.Policy?.IsDisabled) throw new HttpError(401, 'Sign-in failed');
        if (sessions.size >= 10000) throw new HttpError(503, 'Session capacity reached');
        attempts.delete(bucket);
        try { const previous = sessionFor(req); dropSession(previous.id); } catch {}
        const id = opaque();
        const session = { token: authenticated.AccessToken, deviceId, user: publicUser(authenticated.User), csrfToken: opaque(), expires: Date.now() + config.sessionTtl };
        sessions.set(id, session);
        send(res, 200, { user: session.user, csrfToken: session.csrfToken }, { 'Set-Cookie': cookie(id) }); return;
      }
      if (route.startsWith('/api/tv/') && await tvAccess.handle(req, res, route)) return;
      if (route.startsWith('/cast/') && await casting.handlePublic(req, res, route)) return;
      if (route.startsWith('/api/') || route.startsWith('/jellyfin/')) {
        const session = sessionFor(req);
        if (mutation(req.method)) csrf(req, session);
        if (route.startsWith('/api/cast/') && await casting.handle(req, res, route, session)) return;
        if (route === '/api/session' && req.method === 'GET') { const user = publicUser(await currentUser(session)); sessions.get(session.id).user = user; send(res, 200, { user, csrfToken: session.csrfToken }); return; }
        if (route === '/api/logout' && req.method === 'POST') {
          dropSession(session.id);
          try { const response = await upstream('/Sessions/Logout', { session, method: 'POST' }); await response.body?.cancel(); } catch {}
          send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
        }
        if (route === '/api/password' && req.method === 'POST') {
          const input = await body(req);
          requireStrongPassword(input.newPassword);
          if (typeof input.currentPassword !== 'string' || !input.currentPassword || input.currentPassword.length > 1024) throw new HttpError(400, 'Current password is required');
          await currentUser(session);
          const response = await upstream(`/Users/Password?userId=${encodeURIComponent(session.user.Id)}`, {
            session, method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ CurrentPw: input.currentPassword, NewPw: input.newPassword }),
          });
          await response.body?.cancel();
          if (!response.ok) throw new HttpError([400, 401, 403].includes(response.status) ? response.status : 502, 'Password change failed');
          for (const [id, stored] of sessions) if (stored.user.Id === session.user.Id) dropSession(id);
          try { const logout = await upstream('/Sessions/Logout', { session, method: 'POST' }); await logout.body?.cancel(); } catch {}
          send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
        }
        if (route.startsWith('/api/admin/')) {
          await requireAdmin(session);
          const mappingMatch = route.match(/^\/api\/admin\/libraries\/([A-Za-z0-9_-]{1,128})\/path$/);
          if (mappingMatch && req.method === 'POST') {
            const input = await body(req); const id = mappingMatch[1];
            if (mappingOperations.has(id)) throw new HttpError(409, 'Esta biblioteca ya está guardando una ruta.');
            mappingOperations.add(id);
            try { send(res, 200, await replaceLibraryPath({ id, input: { ...input, path: await resolveLibraryPath(input.path) }, session, upstream, jsonResponse })); }
            finally { mappingOperations.delete(id); }
            return;
          }
          if (route === '/api/admin/google-drive/folders' && req.method === 'GET') {
            if (typeof googleOAuth.listFolders !== 'function') throw new HttpError(503, 'La exploración de Google Drive no está disponible en este servidor.');
            const query = new URL(req.url, config.publicUrl).searchParams;
            if (query.getAll('parentId').length > 1 || query.getAll('pageToken').length > 1) throw new HttpError(400, 'La página solicitada no es válida.');
            send(res, 200, await googleOAuth.listFolders(query.get('parentId') || '', query.get('pageToken') || '')); return;
          }
          if (route === '/api/admin/folders' && req.method === 'GET') {
            const query = new URL(req.url, config.publicUrl);
            const source = query.searchParams.get('source') || '';
            const relative = query.searchParams.get('path') || '';
            const filter = (query.searchParams.get('search') || '').trim().toLocaleLowerCase();
            const roots = { local: '/media/local', cloud: '/media/cloud' };
            if (!Object.hasOwn(roots, source) || relative.length > 1024 || filter.length > 160 || /[\\\\\u0000-\u001f\u007f]/.test(relative)) throw new HttpError(400, 'Invalid folder request');
            const segments = relative.split('/').filter(Boolean);
            if (segments.some((part) => part === '.' || part === '..')) throw new HttpError(400, 'Invalid folder path');
            const currentPath = [roots[source], ...segments].join('/');
            const directoryQuery = new URLSearchParams({ path: currentPath, includeFiles: 'false', includeDirectories: 'true' });
            const directoryResponse = await upstream(`/Environment/DirectoryContents?${directoryQuery}`, { session });
            if (!directoryResponse.ok) { await directoryResponse.body?.cancel(); throw new HttpError(directoryResponse.status === 404 ? 404 : 503, 'Jellyfin could not read this media folder'); }
            const rows = await jsonResponse(directoryResponse);
            if (!Array.isArray(rows)) throw new HttpError(502, 'Jellyfin returned an invalid folder list');
            const folders = rows.map((entry) => typeof entry?.Name === 'string' ? entry.Name : '')
              .filter((name) => name && name !== '.' && name !== '..' && !/[\\\\/\u0000-\u001f\u007f]/.test(name) && (!filter || name.toLocaleLowerCase().includes(filter)))
              .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            send(res, 200, { source, path: relative, currentPath, folders }); return;
          }
          if (route === '/api/admin/google-drive/status' && req.method === 'GET') { send(res, 200, { ...await googleOAuth.status(), mountVerified: await cloudMountStatus() }); return; }
          if (route === '/api/admin/google-drive/connect' && req.method === 'POST') { csrf(req, session); send(res, 200, { url: await googleOAuth.start() }); return; }
          if (route === '/api/admin/google-drive/disconnect' && req.method === 'POST') { csrf(req, session); await googleOAuth.disconnect(); send(res, 200, { ok: true }); return; }
          if (route === '/api/admin/status' && req.method === 'GET') {
            let available = false;
            let message = torrent.configured ? 'No se pudo comprobar la conexión con qBittorrent.' : 'Configura qBittorrent en el servidor para habilitar torrents.';
            if (torrent.configured) {
              try { await torrent.health(); available = true; message = 'Conexión autenticada con qBittorrent.'; }
              catch (error) { if (error instanceof HttpError) message = error.message; }
            }
            send(res, 200, { jellyfin: { available: true }, torrent: { configured: torrent.configured, available, message } }); return;
          }
          if (route === '/api/admin/torrents' && req.method === 'GET') { send(res, 200, { torrents: await torrent.list() }); return; }
          if (route === '/api/admin/torrents' && req.method === 'POST') { send(res, 201, await torrent.add(await body(req))); return; }
          const statusMatch = route.match(/^\/api\/admin\/torrents\/([A-Za-z0-9_-]{24})\/status$/);
          if (statusMatch && req.method === 'GET') { send(res, 200, await torrent.status(statusMatch[1])); return; }
          const playMatch = route.match(/^\/api\/admin\/torrents\/([A-Za-z0-9_-]{24})\/play$/);
          if (playMatch && req.method === 'POST') { const input = await body(req); send(res, 200, await torrent.play(playMatch[1], input.fileIndex)); return; }
          const streamMatch = route.match(/^\/api\/admin\/torrents\/([A-Za-z0-9_-]{24})\/stream\/(\d+)$/);
          if (streamMatch && ['GET', 'HEAD'].includes(req.method)) { await torrent.stream(req, res, streamMatch[1], Number(streamMatch[2])); return; }
          const removeMatch = route.match(/^\/api\/admin\/torrents\/([A-Za-z0-9_-]{24})$/);
          if (removeMatch && req.method === 'DELETE') { await torrent.remove(removeMatch[1]); send(res, 200, { ok: true }); return; }
        }
        if (route.startsWith('/jellyfin/')) { await proxy(req, res, route, session); return; }
        throw new HttpError(404, 'Not found');
      }
      await staticFile(req, res, route);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      send(res, status, { error: error instanceof HttpError ? error.message : 'Service unavailable' });
    }
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 120000, headersTimeout: 15000 }, handler);
  server.maxRequestsPerSocket = 1000;
  casting = createCasting(config, { sessions, upstream, jsonResponse, currentUser, requireAdmin, torrent, proxy, body, send, sameOrigin, rateLimit, clientIp, now: options.castingNow || Date.now });
  tvAccess = createTvAccess(config, { sessions, upstream, jsonResponse, currentUser, body, send, sameOrigin, rateLimit, clientIp, casting, dropSession, authorizeItem, now: options.tvNow || Date.now, ...(options.tvStore ? { store: options.tvStore } : {}) });
  return { server, handler, sessions, config, close: () => { casting.close(); tvAccess.close(); googleOAuth.close?.(); torrent.close?.(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = createApp(); const { server, config } = app;
    server.listen(config.port, config.host, () => process.stdout.write(`JRPlex gateway listening on ${config.host}:${config.port}\n`));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      setTimeout(() => process.exit(1), 15000).unref();
      void Promise.resolve().then(() => app.close()).then(() => process.exit(0), () => process.exit(1));
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch { process.stderr.write('JRPlex configuration is invalid; check local environment and secret files.\n'); process.exitCode = 1; }
}
