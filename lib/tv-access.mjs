import { createHash, randomInt } from 'node:crypto';
import { HttpError, opaque } from './security.mjs';
import { createTvStore } from './tv-store.mjs';
import { hasPlayableMedia } from '../public/media-eligibility.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizeCode = value => typeof value === 'string' ? value.toUpperCase().replace(/[-\s]/g, '') : '';
const publicUser = user => ({ Id: user.Id, Name: user.Name });
const folders = new Set(['Folder', 'CollectionFolder', 'PhotoAlbum', 'Series', 'Season', 'MusicAlbum', 'MusicArtist', 'BoxSet', 'Playlist']);
const allowedTypes = {
  home: 'Folder,CollectionFolder,Series,Season,MusicAlbum,MusicArtist,PhotoAlbum,Movie,Video,Episode,Recording,MusicVideo,Audio,Photo',
  movies: 'Folder,CollectionFolder,Series,Season,Movie,Video,Episode,Recording,MusicVideo',
  series: 'Folder,CollectionFolder,Series,Season,Episode',
  music: 'Folder,CollectionFolder,MusicArtist,MusicAlbum,Audio',
  photos: 'Folder,CollectionFolder,PhotoAlbum,Photo',
  resume: 'Movie,Video,Episode,Recording,MusicVideo',
};
const sortColumns = { name: 'SortName,Name', type: 'SortName,Name', origin: 'IsFolder,SortName', date: 'DateCreated,SortName' };

export function createTvAccess(config, { sessions, upstream, jsonResponse, currentUser, body, send, sameOrigin, rateLimit, clientIp, casting, dropSession, authorizeItem, now = Date.now, store = createTvStore(config.tvStateDir) }) {
  const pending = new Map();
  for (const record of store.values()) {
    if (record.expires > now() && (record.activated || record.created > now() - 300000)) sessions.set(record.id, { ...record, kind: 'tv', csrfToken: opaque() });
    else store.delete(record.id);
  }
  function prune() {
    for (const [secret, item] of pending) if (item.expires <= now()) pending.delete(secret);
    for (const record of store.values()) if (record.expires <= now() || (!record.activated && record.created <= now() - 300000)) dropSession(record.id);
  }
  function byCode(code) {
    code = normalizeCode(code);
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new HttpError(404, 'Código incorrecto o caducado.');
    const item = [...pending.values()].find(item => item.code === code && !item.approved);
    if (!item) throw new HttpError(404, 'Código incorrecto o caducado.');
    return item;
  }
  async function authenticated(req) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new HttpError(401, 'Vincula tu cuenta con esta TV.');
    const digest = hash(token); const record = store.values().find(record => record.hash === digest && record.expires > now());
    const session = record && sessions.get(record.id);
    if (!session) throw new HttpError(401, 'La cuenta de esta TV caducó o fue revocada.');
    const user = await currentUser({ id: record.id, ...session });
    if (!record.activated) { record.activated = true; store.set(record); }
    return { id: record.id, ...session, user };
  }
  const summary = item => ({ Id: item.Id, Name: String(item.Name || 'Sin título').slice(0, 256), Type: item.Type, MediaType: item.MediaType, IsFolder: !!item.IsFolder || folders.has(item.Type), Playable: hasPlayableMedia(item),
    DateCreated: item.DateCreated || item.DateLastMediaAdded || '', Overview: String(item.Overview || '').slice(0, 4000), RunTimeTicks: item.RunTimeTicks || 0, Image: !!item.ImageTags?.Primary,
    Position: Math.max(0, Math.min(604800, (item.UserData?.PlaybackPositionTicks || 0) / 10000000)), Played: !!item.UserData?.Played });
  async function json(path, session, options = {}) {
    const response = await upstream(path, { session, ...options });
    if (!response.ok) { await response.body?.cancel(); if (response.status === 401) dropSession(session.id); throw new HttpError([401, 403, 404].includes(response.status) ? response.status : 502, 'No se pudo cargar la biblioteca.'); }
    return jsonResponse(response);
  }
  async function handle(req, res, route) {
    if (!route.startsWith('/api/tv/')) return false;
    prune();
    if (route.startsWith('/api/tv/link/') && req.method === 'POST') {
      sameOrigin(req); const input = await body(req); const ip = clientIp(req);
      if (route === '/api/tv/link/start') {
        rateLimit(`tv-start:${ip}`, 20); if (pending.size >= 1000) throw new HttpError(503, 'Hay demasiadas solicitudes de vinculación.');
        let code; do { code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while ([...pending.values()].some(item => item.code === code));
        const secret = opaque(); const item = { code, name: typeof input.name === 'string' ? input.name.trim().slice(0, 60) || 'JRPlex TV' : 'JRPlex TV', expires: now() + 300000, deviceId: opaque() };
        pending.set(secret, item);
        send(res, 201, { secret, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: item.expires, verificationUrl: `${config.publicUrl}/activate#code=${code}` }); return true;
      }
      if (route === '/api/tv/link/poll') {
        rateLimit(`tv-poll:${ip}`, 6000); const item = typeof input.secret === 'string' && pending.get(input.secret);
        if (!item) throw new HttpError(401, 'El código caducó. Genera otro en la TV.');
        send(res, 200, item.approved ? { status: 'approved', token: item.deviceToken, expiresAt: item.deviceExpires, user: item.user } : { status: 'pending', expiresAt: item.expires }); return true;
      }
      rateLimit(`tv-link:${ip}`, 60); const item = byCode(input.code);
      if (route === '/api/tv/link/info') { send(res, 200, { name: item.name, expiresAt: item.expires, code: normalizeCode(input.code) }); return true; }
      if (route === '/api/tv/link/approve') {
        if (item.approving) throw new HttpError(409, 'La vinculación está en curso.');
        if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 256 || typeof input.password !== 'string' || !input.password || input.password.length > 1024) throw new HttpError(400, 'Introduce tu cuenta JRPlex.');
        rateLimit(`tv-user:${ip}:${input.username.trim().normalize('NFKC').toLowerCase()}`, 10); rateLimit(`tv-code:${item.code}`, 10);
        item.approving = true;
        try {
          const response = await upstream('/Users/AuthenticateByName', { session: { deviceId: item.deviceId, kind: 'tv' }, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: input.username, Pw: input.password }) });
          if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 401 || response.status === 403 ? 401 : 502, 'Usuario o contraseña incorrectos, o servidor no disponible.'); }
          const data = await jsonResponse(response);
          if (!/^[A-Za-z0-9_-]{1,512}$/.test(data.AccessToken || '') || !idPattern.test(data.User?.Id || '') || data.User.Policy?.IsDisabled) throw new HttpError(401, 'No se pudo vincular esta cuenta.');
          if (item.expires <= now() || sessions.size >= 10000 || store.values().filter(r => r.user.Id === data.User.Id).length >= 20) {
            const ended = await upstream('/Sessions/Logout', { session: { token: data.AccessToken, deviceId: item.deviceId }, method: 'POST' }); await ended.body?.cancel();
            throw new HttpError(409, 'El código caducó o la cuenta alcanzó su límite de TVs.');
          }
          const token = opaque(); const record = { id: opaque(), hash: hash(token), token: data.AccessToken, deviceId: item.deviceId, user: { ...publicUser(data.User), Policy: data.User.Policy }, created: now(), expires: now() + 30 * 86400000, activated: false, name: item.name };
          store.set(record); sessions.set(record.id, { ...record, kind: 'tv', csrfToken: opaque() });
          Object.assign(item, { approved: true, deviceToken: token, deviceExpires: record.expires, user: publicUser(data.User) });
          send(res, 200, { approved: true, user: publicUser(data.User) }); return true;
        } finally { item.approving = false; }
      }
      throw new HttpError(404, 'Ruta de vinculación no válida.');
    }
    const session = await authenticated(req); rateLimit(`tv-api:${session.id}`, 6000);
    if (req.method !== 'GET') sameOrigin(req);
    if (route === '/api/tv/session' && req.method === 'GET') { send(res, 200, { user: publicUser(session.user), expiresAt: session.expires }); return true; }
    if (route === '/api/tv/logout' && req.method === 'POST') {
      dropSession(session.id); const response = await upstream('/Sessions/Logout', { session, method: 'POST' }); await response.body?.cancel(); send(res, 200, { ok: true }); return true;
    }
    if (route === '/api/tv/catalog' && req.method === 'GET') {
      const params = new URL(req.url, config.publicUrl).searchParams; const kind = params.get('kind') || 'home';
      const parent = params.get('parent') || ''; const search = (params.get('search') || '').trim(); const offset = Number(params.get('offset') || 0);
      const sort = params.get('sort') || (kind === 'photos' ? 'date' : 'name'); const order = (params.get('order') || (sort === 'date' ? 'desc' : 'asc')).toLowerCase();
      if (!['home', 'movies', 'series', 'music', 'photos', 'resume'].includes(kind) || (parent && !idPattern.test(parent)) || search.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Object.hasOwn(sortColumns, sort) || !['asc', 'desc'].includes(order)) throw new HttpError(400, 'Búsqueda no válida.');
      if (parent) await authorizeItem(session, parent);
      const query = new URLSearchParams({ UserId: session.user.Id, Limit: '40', StartIndex: String(offset), Fields: 'Overview,DateCreated,Path', SortBy: sortColumns[sort], SortOrder: order === 'desc' ? 'Descending' : 'Ascending', EnableTotalRecordCount: 'true' });
      if (search) query.set('SearchTerm', search);
      query.set('IncludeItemTypes', allowedTypes[kind]);
      if (parent) { query.set('ParentId', parent); query.set('Recursive', 'false'); }
      else if (kind === 'home' && !search) {
        const data = await json(`/Users/${session.user.Id}/Views`, session); send(res, 200, { items: (data.Items || []).map(summary), total: data.Items?.length || 0, offset: 0 }); return true;
      } else query.set('Recursive', 'true');
      const data = await json(kind === 'resume' && !parent ? `/UserItems/Resume?${query}&MediaTypes=Video` : `/Users/${session.user.Id}/Items?${query}`, session);
      const items = (data.Items || []).filter(item => {
        if (item.IsFolder || folders.has(item.Type)) return true;
        if (kind === 'photos') return item.Type === 'Photo' || item.MediaType === 'Photo';
        if (kind === 'music') return item.Type === 'Audio' || item.MediaType === 'Audio' || (kind === 'music' && item.Type === 'MusicAlbum');
        if (kind === 'series') return ['Series', 'Season', 'Episode'].includes(item.Type);
        if (kind === 'movies' || kind === 'resume') return hasPlayableMedia(item) && ['Movie', 'Video', 'Episode', 'Recording', 'MusicVideo'].includes(item.Type);
        return item.Type === 'Photo' || item.MediaType === 'Photo' || hasPlayableMedia(item);
      });
      if (sort === 'type') items.sort((a, b) => String(a.Type || a.MediaType || '').localeCompare(String(b.Type || b.MediaType || ''), 'es') || String(a.Name || '').localeCompare(String(b.Name || ''), 'es'));
      send(res, 200, { items: items.map(summary), total: data.TotalRecordCount ?? items.length, offset, sort, order }); return true;
    }
    if (route === '/api/tv/item' && req.method === 'GET') {
      const id = new URL(req.url, config.publicUrl).searchParams.get('id'); if (!idPattern.test(id || '')) throw new HttpError(400, 'Título no válido.');
      send(res, 200, summary(await json(`/Users/${session.user.Id}/Items/${id}`, session))); return true;
    }
    if ((route === '/api/tv/image' || route === '/api/tv/photo') && req.method === 'GET') {
      const id = new URL(req.url, config.publicUrl).searchParams.get('id'); if (!idPattern.test(id || '')) throw new HttpError(400, 'Imagen no válida.');
      const item = await json(`/Users/${session.user.Id}/Items/${id}`, session);
      if (route.endsWith('/photo') && item.Type !== 'Photo') throw new HttpError(400, 'No es una fotografía.');
      const response = await upstream(`/Items/${id}/Images/Primary?MaxWidth=${route.endsWith('/photo') ? 1920 : 320}&Quality=85&Format=jpg`, { session });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(404, 'Imagen no disponible.'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      const reader = response.body.getReader(); let size = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 12 * 1024 * 1024) throw new Error('Image too large'); if (!res.destroyed) res.write(value); } res.end(); }
      finally { await reader.cancel().catch(() => {}); } return true;
    }
    if (route === '/api/tv/play' && req.method === 'POST') {
      const input = await body(req); const position = Number(input.position || 0);
      if (!Number.isFinite(position) || position < 0 || position > 604800) throw new HttpError(400, 'Posición no válida.');
      const media = await casting.createMedia(session, { kind: 'library', itemId: input.itemId });
      send(res, 201, { media, position }); return true;
    }
    if (route === '/api/tv/stop' && req.method === 'POST') {
      const input = await body(req); casting.revokeMedia(session, input.mediaId); send(res, 200, { ok: true }); return true;
    }
    if (route === '/api/tv/progress' && req.method === 'POST') {
      const input = await body(req); if (!idPattern.test(input.itemId || '') || !Number.isFinite(input.position) || input.position < 0 || input.position > 604800 || !['start', 'progress', 'stop'].includes(input.event)) throw new HttpError(400, 'Estado no válido.');
      const playback = casting.playback(session, input.mediaId, input.itemId);
      await authorizeItem(session, input.itemId);
      const route = input.event === 'start' ? '' : input.event === 'stop' ? '/Stopped' : '/Progress';
      const response = await upstream(`/Sessions/Playing${route}`, { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ItemId: input.itemId, MediaSourceId: playback.mediaSourceId, PlaySessionId: playback.playSessionId, PositionTicks: Math.round(input.position * 10000000), IsPaused: !!input.paused, CanSeek: playback.canSeek, PlayMethod: playback.playMethod || 'DirectPlay' }) });
      await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo guardar el avance.'); send(res, 200, { ok: true }); return true;
    }
    throw new HttpError(404, 'La API de TV solo permite biblioteca y reproducción.');
  }
  return { handle, revokeSession(id) { store.delete(id); }, close() { pending.clear(); } };
}
