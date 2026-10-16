import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, boundedBody } from './security.mjs';

function infoOnly(data) {
  let position = 0; let info; let nodes = 0;
  const invalid = () => { throw new HttpError(400, 'Invalid torrent metadata'); };
  function parse(depth = 0) {
    if (depth > 32 || ++nodes > 100000 || position >= data.length) invalid();
    const start = position;
    if (data[position] >= 48 && data[position] <= 57) {
      const colon = data.indexOf(58, position);
      if (colon < 0 || colon - position > 10) invalid();
      const raw = data.subarray(position, colon).toString();
      if (!/^(?:0|[1-9]\d*)$/.test(raw)) invalid();
      const size = Number(raw); position = colon + 1;
      if (size > data.length - position) invalid();
      const value = data.subarray(position, position + size); position += size;
      return { type: 'string', value, start, end: position };
    }
    if (data[position] === 105) {
      const end = data.indexOf(101, ++position);
      if (end < 0 || !/^(?:0|-?[1-9]\d*)$/.test(data.subarray(position, end).toString())) invalid();
      position = end + 1; return { type: 'integer', start, end: position };
    }
    if (data[position] === 108 || data[position] === 100) {
      const dictionary = data[position++] === 100;
      const seen = new Set();
      while (data[position] !== 101) {
        let key;
        if (dictionary) { const item = parse(depth + 1); if (item.type !== 'string') invalid(); key = item.value.toString(); if (seen.has(key)) invalid(); seen.add(key); }
        const value = parse(depth + 1);
        if (depth === 0 && key === 'info') { if (value.type !== 'dictionary') invalid(); info = data.subarray(value.start, value.end); }
      }
      position++; return { type: dictionary ? 'dictionary' : 'list', start, end: position };
    }
    invalid();
  }
  const result = parse();
  if (result.type !== 'dictionary' || position !== data.length || !info) invalid();
  return Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
}

export function torrentInput(body) {
  if (typeof body.url === 'string') {
    if (body.url.length > 8192 || !body.url.startsWith('magnet:?')) throw new HttpError(400, 'Use a magnet link or upload a .torrent file; remote URLs are disabled');
    const magnet = new URL(body.url);
    const hashes = magnet.searchParams.getAll('xt');
    if (!hashes.some((v) => /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(v))) throw new HttpError(400, 'Invalid BitTorrent hash');
    // x.pe/xs/as/ws can instruct the daemon to contact arbitrary HTTP hosts.
    // Only the hash and display name cross the trust boundary; DHT discovers peers.
    const safe = new URL('magnet:?');
    for (const hash of hashes.filter((v) => /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(v))) safe.searchParams.append('xt', hash);
    if (magnet.searchParams.has('dn')) safe.searchParams.set('dn', magnet.searchParams.get('dn').slice(0, 256));
    const rawHash = hashes.find((value) => /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(value)).slice(9);
    return { magnet: safe.href, hash: normalizeBtih(rawHash) };
  }
  if (typeof body.torrentBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.torrentBase64) || body.torrentBase64.length > 1400000) throw new HttpError(400, 'Invalid torrent upload');
  const data = Buffer.from(body.torrentBase64, 'base64');
  if (!data.length || data.length > 1024 * 1024 || data[0] !== 100 || data[data.length - 1] !== 101 || !data.includes(Buffer.from('4:info'))) throw new HttpError(400, 'Invalid torrent metadata');
  // Preserve the info dictionary byte-for-byte (and therefore its infohash), but
  // discard announce, nodes, webseeds and every other untrusted root field.
  const cleaned = infoOnly(data);
  return { data: cleaned, hash: createHash('sha1').update(cleaned.subarray(7, -1)).digest('hex'), filename: /^[a-zA-Z0-9_. -]{1,100}\.torrent$/i.test(body.filename || '') ? body.filename : 'upload.torrent' };
}

function normalizeBtih(value) {
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let accumulator = 0; const output = [];
  for (const char of value.toUpperCase()) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new HttpError(400, 'Invalid BitTorrent hash');
    accumulator = (accumulator << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; output.push((accumulator >> bits) & 255); }
  }
  if (output.length !== 20 || bits !== 0) throw new HttpError(400, 'Invalid BitTorrent hash');
  return Buffer.from(output).toString('hex');
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mpeg', '.mpg', '.m2ts', '.3gp', '.ogv']);
const SESSION_TTL = 2 * 60 * 1000;
const PIECE_WAIT_LIMIT = 60 * 1000;
const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
  const abort = () => { clearTimeout(timer); cleanup(); reject(new HttpError(499, 'Playback was closed')); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});

export function parseTorrentRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(416, 'Invalid video size');
  if (header === undefined) return { start: 0, end: size - 1, partial: false };
  if (typeof header !== 'string' || header.length > 128) throw new HttpError(416, 'Invalid byte range');
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Only one byte range is supported');
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new HttpError(416, 'Invalid byte range');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HttpError(416, 'Byte range is not satisfiable');
  return { start, end: Math.min(end, size - 1), partial: true };
}

export function createTorrentClient(config, options = {}) {
  let cookie = '';
  const configured = !!(config.qbUrl && config.qbUsername && config.qbPassword);
  const fetcher = options.fetch ?? globalThis.fetch;
  const spawnProcess = options.spawn ?? spawn;
  const sessions = new Map();
  const pendingAdds = new Map();
  const cacheDir = config.torrentFilesDir ? path.resolve(config.torrentFilesDir) : '';
  const pieceWaitLimit = options.pieceWaitLimit ?? PIECE_WAIT_LIMIT;
  let startupCleanup;
  async function request(path, options = {}, retry = true, acceptedStatuses = []) {
    if (!configured) throw new HttpError(503, 'Torrent service is not configured');
    const response = await fetcher(`${config.qbUrl}/api/v2/${path}`, { ...options, redirect: 'manual', signal: AbortSignal.timeout(config.upstreamTimeout), headers: { Referer: config.qbUrl, Origin: config.qbUrl, ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    if (response.status === 403 && retry) {
      await response.body?.cancel();
      await login();
      return request(path, options, false, acceptedStatuses);
    }
    if ((!response.ok || response.status >= 300) && !acceptedStatuses.includes(response.status)) { await response.body?.cancel(); throw new HttpError(502, 'Torrent service unavailable'); }
    return response;
  }
  async function login() {
    const response = await request('auth/login', { method: 'POST', body: new URLSearchParams({ username: config.qbUsername, password: config.qbPassword }) }, false);
    const text = (await boundedBody(response.body, 1024)).toString().trim();
    // qBittorrent 5.2 returns 204 with a port-qualified QBT_SID cookie;
    // older WebUI API versions return 200, "Ok.", and a SID cookie.
    if (![200, 204].includes(response.status) || (text && text !== 'Ok.')) throw new HttpError(502, 'No se pudo autenticar con qBittorrent; revisa las credenciales de servicio.');
    const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
    const sessionCookie = headers.map((value) => value.trim().match(/^(SID|QBT_SID_\d+)=([^;,\s]+)/)).find(Boolean);
    if (!sessionCookie) throw new HttpError(502, 'qBittorrent no devolvió una cookie de sesión válida.');
    cookie = `${sessionCookie[1]}=${sessionCookie[2]}`;
  }
  async function json(path) {
    const response = await request(path);
    try { return JSON.parse((await boundedBody(response.body, config.maxJson)).toString()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'Invalid torrent response'); }
  }
  async function mutate(path, values) {
    const response = await request(path, { method: 'POST', body: new URLSearchParams(values) });
    await boundedBody(response.body, 1024);
    return response.status;
  }
  async function ensureReady() {
    if (!cookie) await login();
    if (!startupCleanup) startupCleanup = (async () => {
      const stale = await json('torrents/info?tag=jrplex-stream');
      if (!Array.isArray(stale)) throw new HttpError(502, 'Invalid torrent response');
      const hashes = stale.filter((row) => String(row.tags || '').split(',').includes('jrplex-stream')).map((row) => row.hash).filter((hash) => /^[a-f0-9]{40}$/i.test(hash || ''));
      for (const hash of hashes) await mutate('torrents/delete', { hashes: hash, deleteFiles: 'true' });
    })();
    await startupCleanup;
  }
  function scheduleCleanup(id) {
    const session = sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    const delay = Math.max(1, SESSION_TTL - (Date.now() - session.lastActivity));
    session.timer = setTimeout(() => {
      const idle = Date.now() - session.lastActivity;
      if (session.activeStreams > 0) { session.lastActivity = Date.now(); scheduleCleanup(id); return; }
      if (idle < SESSION_TTL) { scheduleCleanup(id); return; }
      void remove(id).catch(() => {});
    }, delay);
    session.timer.unref?.();
  }
  function touch(session) { session.lastActivity = Date.now(); scheduleCleanup(session.id); }
  async function remove(id) {
    const session = sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    for (const controller of session.controllers) controller.abort();
    sessions.delete(id);
    if (configured) await mutate('torrents/delete', { hashes: session.hash, deleteFiles: 'true' });
  }
  async function getFiles(hash) {
    const response = await request(`torrents/files?hash=${encodeURIComponent(hash)}`, {}, true, [404]);
    if (response.status === 404) { await response.body?.cancel(); return []; }
    let rows;
    try { rows = JSON.parse((await boundedBody(response.body, config.maxJson)).toString()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'Invalid torrent response'); }
    if (!Array.isArray(rows) || rows.length > 5000 || rows.some((file) => !Number.isSafeInteger(file.index) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.name !== 'string')) throw new HttpError(502, 'Torrent metadata is invalid');
    return rows.sort((a, b) => a.index - b.index);
  }
  async function torrentInfo(hash) {
    const rows = await json(`torrents/info?hash=${encodeURIComponent(hash)}`);
    if (!Array.isArray(rows)) throw new HttpError(502, 'Torrent metadata is invalid');
    return rows.find((row) => row.hash?.toLowerCase() === hash) || null;
  }
  function publicSession(session) {
    return { id: session.id, name: session.name, files: session.files.filter((file) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())).map(({ index, name, size, progress }) => ({ index, name: path.basename(name), size, progress: Number(progress) || 0 })), selectedIndex: session.selectedIndex, active: !!session.selectedIndex || session.selectedIndex === 0 };
  }
  function sessionFor(id) {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, 'Torrent stream not found or expired');
    return session;
  }
  async function waitForPiece(hash, pieceIndex, signal, cache) {
    const deadline = Date.now() + pieceWaitLimit;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new HttpError(499, 'Playback was closed');
      if (!cache.states || Date.now() - cache.time >= 500) {
        cache.states = await json(`torrents/pieceStates?hash=${encodeURIComponent(hash)}`);
        cache.time = Date.now();
        if (!Array.isArray(cache.states)) throw new HttpError(502, 'Torrent piece state is invalid');
      }
      if (cache.states[pieceIndex] === 2) return;
      const info = await torrentInfo(hash);
      if (!info) throw new HttpError(404, 'El torrent ya no está disponible.');
      if (['error', 'missingFiles'].includes(info.state)) throw new HttpError(503, 'qBittorrent no puede leer o guardar las piezas. Revisa el espacio y los permisos de la caché.');
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())), signal);
    }
    throw new HttpError(504, 'No llegaron piezas verificadas en 60 segundos. Comprueba los pares activos y vuelve a intentar.');
  }
  async function resolveVideoFile(session, file, info) {
    if (!cacheDir || !path.isAbsolute(cacheDir)) throw new HttpError(503, 'Torrent streaming storage is not configured');
    const root = await realpath(cacheDir);
    const contentPath = path.resolve(info.content_path || info.save_path || '');
    const relativeName = file.name.replace(/[\\/]+/g, path.sep);
    if (path.isAbsolute(relativeName) || relativeName.split(path.sep).some((part) => part === '..' || part === '')) throw new HttpError(400, 'Unsafe torrent file path');
    const savePath = path.resolve(info.save_path || '');
    if (!savePath || !contentPath.startsWith(`${savePath}${path.sep}`) && contentPath !== savePath) throw new HttpError(502, 'Torrent storage path is outside the configured directory');
    // qBittorrent file names are relative to save_path, including the root
    // directory of multifile torrents. Flat multifile torrents have no root.
    const candidates = [path.resolve(savePath, relativeName), path.resolve(contentPath, relativeName), ...(session.files.length === 1 ? [contentPath] : [])];
    let missing;
    for (const candidate of [...new Set(candidates)]) {
      for (const variant of [candidate, `${candidate}.!qB`]) {
        let resolved;
        try { resolved = await realpath(variant); }
        catch (error) { if (error.code === 'ENOENT') { missing = error; continue; } throw error; }
        if (!resolved.startsWith(`${root}${path.sep}`) || resolved === root) throw new HttpError(403, 'Torrent file path is outside the cache');
        const infoStat = await stat(resolved);
        if (infoStat.isFile()) return resolved;
      }
    }
    throw missing || new HttpError(503, 'Torrent video is not ready to read yet');
  }
  async function stream(req, res, id, fileIndex) {
    const session = sessionFor(id);
    const file = session.files.find((item) => item.index === fileIndex);
    if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()) || session.selectedIndex !== fileIndex) throw new HttpError(404, 'Playable torrent file not found');
    const extension = path.extname(file.name).toLowerCase();
    const transcode = !['.mp4', '.m4v', '.webm'].includes(extension);
    const range = transcode ? { start: 0, end: file.size - 1, partial: false } : parseTorrentRange(req.headers.range, file.size);
    const info = await torrentInfo(session.hash);
    if (!info) throw new HttpError(404, 'Torrent is no longer available');
    const rows = [...session.files].sort((a, b) => a.index - b.index);
    const torrentOffset = rows.filter((row) => row.index < fileIndex).reduce((total, row) => total + row.size, 0);
    const properties = await json(`torrents/properties?hash=${encodeURIComponent(session.hash)}`);
    const pieceSize = properties?.piece_size;
    if (!Number.isSafeInteger(pieceSize) || pieceSize < 1) throw new HttpError(502, 'Torrent piece size is invalid');
    const filename = path.basename(file.name).replace(/[\r\n"\\]/g, '_');
    const headers = {
      'Content-Type': transcode ? 'video/mp4' : mediaType(extension),
      'Accept-Ranges': transcode ? 'none' : 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${transcode ? filename.replace(/\.[^.]+$/, '.mp4') : filename}"`,
      'X-Accel-Buffering': 'no',
      ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
    };
    if (req.method === 'HEAD') { if (!transcode) headers['Content-Length'] = String(range.end - range.start + 1); res.writeHead(!transcode && range.partial ? 206 : 200, headers); res.end(); return; }
    let handle;
    const controller = new AbortController();
    session.controllers.add(controller); session.activeStreams++; touch(session);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      const cache = { states: null, time: 0 };
      let offset = range.start;
      // Do not commit a successful media response until at least its first
      // verified piece is on disk. Otherwise a dead swarm leaves <video>
      // waiting on an already-sent 200 for minutes with no useful error.
      const firstPiece = Math.floor((torrentOffset + offset) / pieceSize);
      await waitForPiece(session.hash, firstPiece, controller.signal, cache);
      const diskPath = await resolveVideoFile(session, file, info);
      handle = await open(diskPath, 'r');
      if (transcode) {
        const child = spawnProcess('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-probesize', '8M', '-analyzeduration', '8M', '-i', 'pipe:0',
          '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        child.stdin.on('error', () => {});
        const processClosed = new Promise((resolve) => child.once('close', resolve));
        const source = async function* () {
          let cursor = 0;
          while (cursor < file.size && !controller.signal.aborted) {
            const piece = Math.floor((torrentOffset + cursor) / pieceSize);
            if (piece !== firstPiece || cursor !== 0) await waitForPiece(session.hash, piece, controller.signal, cache);
            const boundary = ((Math.floor((torrentOffset + cursor) / pieceSize) + 1) * pieceSize) - torrentOffset;
            const length = Math.min(file.size - cursor, Math.max(1, boundary - cursor), 1024 * 1024);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, cursor);
            if (bytesRead !== length) throw new HttpError(502, 'Verified torrent piece could not be read');
            cursor += length; touch(session); yield buffer;
          }
        };
        let inputError = null;
        const inputPump = pipeline(Readable.from(source()), child.stdin, { signal: controller.signal }).catch((error) => { inputError = error; child.kill('SIGTERM'); });
        let firstOutput;
        try {
          child.stdout.pause();
          firstOutput = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new HttpError(504, 'FFmpeg no pudo preparar un segmento reproducible a tiempo.')), 30000);
            const cleanup = () => { clearTimeout(timer); child.stdout.off('data', data); child.off('error', failed); child.off('close', closed); controller.signal.removeEventListener('abort', aborted); };
            const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
            const data = (value) => { child.stdout.pause(); finish(null, value); };
            const aborted = () => finish(new HttpError(499, 'Playback was closed'));
            const failed = () => finish(new HttpError(503, 'No está disponible el convertidor de vídeo del servidor.'));
            const closed = () => finish(inputError || new HttpError(415, 'FFmpeg no pudo preparar el vídeo del torrent.'));
            child.stdout.once('data', data); child.once('error', failed); child.once('close', closed);
            controller.signal.addEventListener('abort', aborted, { once: true });
            if (controller.signal.aborted) aborted();
            else child.stdout.resume();
          });
          if (controller.signal.aborted || res.destroyed) throw new HttpError(499, 'Playback was closed');
          res.writeHead(200, headers); res.write(firstOutput);
          await pipeline(child.stdout, res, { signal: controller.signal });
          await inputPump;
          if (inputError) throw inputError;
          const exitCode = await processClosed;
          if (exitCode !== 0) throw new HttpError(415, 'FFmpeg no pudo decodificar el vídeo del torrent.');
        } catch (error) {
          if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
          if (!controller.signal.aborted && error.status !== 499) session.lastError = error instanceof HttpError ? error.message : 'No se pudo convertir el vídeo del torrent.';
          controller.abort();
          await inputPump;
          throw error;
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      headers['Content-Length'] = String(range.end - range.start + 1);
      res.writeHead(range.partial ? 206 : 200, headers);
      while (offset <= range.end) {
        if (controller.signal.aborted) break;
        const piece = Math.floor((torrentOffset + offset) / pieceSize);
        if (piece !== firstPiece || offset !== range.start) await waitForPiece(session.hash, piece, controller.signal, cache);
        const nextBoundary = ((Math.floor((torrentOffset + offset) / pieceSize) + 1) * pieceSize) - torrentOffset;
        const length = Math.min(range.end - offset + 1, Math.max(1, nextBoundary - offset), 4 * 1024 * 1024);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new HttpError(502, 'Verified torrent piece could not be read');
        if (!res.write(buffer)) await new Promise((resolve, reject) => {
          const cleanup = () => { res.off('drain', drained); res.off('close', closed); controller.signal.removeEventListener('abort', aborted); };
          const drained = () => { cleanup(); resolve(); };
          const closed = () => { cleanup(); reject(new HttpError(499, 'Playback was closed')); };
          const aborted = () => { cleanup(); reject(new HttpError(499, 'Playback was closed')); };
          res.once('drain', drained); res.once('close', closed); controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) aborted();
        });
        touch(session);
        offset += length;
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      if (!controller.signal.aborted && error.status !== 499) session.lastError = error instanceof HttpError ? error.message : 'No se pudo leer el vídeo del torrent. Revisa la caché del servidor.';
      throw error;
    } finally {
      res.off('close', onClose); await handle?.close();
      session.controllers.delete(controller); session.activeStreams = Math.max(0, session.activeStreams - 1); scheduleCleanup(id);
    }
  }
  function mediaType(ext) {
    return ({ '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.m2ts': 'video/mp2t', '.ts': 'video/mp2t', '.3gp': 'video/3gpp', '.ogv': 'video/ogg' })[ext] || 'application/octet-stream';
  }
  return {
    configured,
    async health() { await ensureReady(); const response = await request('app/version'); await boundedBody(response.body, 1024); return true; },
    async list() {
      await ensureReady();
      for (const session of sessions.values()) session.files = await getFiles(session.hash);
      return [...sessions.values()].map(publicSession);
    },
    async add(body) {
      const input = torrentInput(body);
      const active = [...sessions.values()].find((session) => session.hash === input.hash);
      if (active) { touch(active); return publicSession(active); }
      if (pendingAdds.has(input.hash)) return pendingAdds.get(input.hash);
      const task = addTorrent(input);
      pendingAdds.set(input.hash, task);
      try { return await task; }
      finally { if (pendingAdds.get(input.hash) === task) pendingAdds.delete(input.hash); }
    },
    async play(id, rawIndex) {
      const session = sessionFor(id);
      const index = Number(rawIndex);
      const file = session.files.find((item) => item.index === index);
      if (!Number.isSafeInteger(index) || !file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) throw new HttpError(400, 'Selecciona un archivo de vídeo válido.');
      for (const controller of session.controllers) controller.abort();
      await mutate('torrents/filePrio', { hash: session.hash, id: session.files.map((item) => item.index).join('|'), priority: '0' });
      await mutate('torrents/filePrio', { hash: session.hash, id: String(index), priority: '7' });
      await mutate('torrents/setDownloadLimit', { hashes: session.hash, limit: '-1' });
      await mutate('torrents/start', { hashes: session.hash });
      session.lastError = null; session.selectedIndex = index; touch(session);
      return { streamUrl: `/api/admin/torrents/${encodeURIComponent(id)}/stream/${index}`, name: path.basename(file.name), size: file.size };
    },
    async status(id) {
      const session = sessionFor(id);
      const info = await torrentInfo(session.hash);
      if (!info) throw new HttpError(404, 'El torrent ya no está disponible o la sesión caducó.');
      touch(session);
      const storageError = ['error', 'missingFiles'].includes(info.state);
      return { state: info.state || 'unknown', progress: Math.max(0, Math.min(1, Number(info.progress) || 0)),
        peers: Math.max(0, Number(info.num_seeds) || 0) + Math.max(0, Number(info.num_leechs) || 0),
        downloadSpeed: Math.max(0, Number(info.dlspeed) || 0),
        error: session.lastError || (storageError ? 'qBittorrent no puede leer o guardar las piezas. Revisa el espacio y los permisos de la caché.' : null) };
    },
    stream,
    async remove(id) { await remove(id); },
    async close() { await Promise.allSettled([...sessions.keys()].map((id) => remove(id))); },
  };

  async function addTorrent(input) {
      await ensureReady();
      const active = [...sessions.values()].find((session) => session.hash === input.hash);
      if (active) { touch(active); return publicSession(active); }
      if (sessions.size >= 4) throw new HttpError(429, 'Ya hay cuatro sesiones de torrent activas.');
      let details = await torrentInfo(input.hash);
      const owned = (row) => String(row?.tags || '').split(',').map((tag) => tag.trim()).includes('jrplex-stream');
      if (details && !owned(details)) throw new HttpError(409, 'Este enlace ya está agregado a qBittorrent fuera de una sesión JRPlex; no se modificó la descarga existente.');
      if (details) await mutate('torrents/setDownloadLimit', { hashes: input.hash, limit: '1' });
      let addedHere = false;
      if (!details) {
      const form = new FormData();
      if (input.magnet) form.append('urls', input.magnet);
      else form.append('torrents', new Blob([input.data], { type: 'application/x-bittorrent' }), input.filename);
      form.append('savepath', config.torrentSavePath || '/downloads/incomplete');
      // Let qBittorrent resolve magnet metadata while tightly limiting payload
      // transfer. Once the file list arrives, every file is disabled and the
      // torrent is stopped until the user selects a video.
      form.append('paused', 'false');
      form.append('dlLimit', '1');
      form.append('autoTMM', 'false');
      form.append('sequentialDownload', 'true');
      form.append('firstLastPiecePrio', 'true');
      form.append('tags', 'jrplex-stream');
      const response = await request('torrents/add', { method: 'POST', body: form }, true, [409]);
      const result = (await boundedBody(response.body, 4096)).toString().trim();
      if (response.status === 409) {
        details = await torrentInfo(input.hash);
        if (!details || !owned(details)) throw new HttpError(502, 'qBittorrent rechazó el enlace y no publicó metadatos. Comprueba el magnet y que tenga pares disponibles.');
      } else if (result !== 'Ok.') {
        let acceptance;
        try { acceptance = JSON.parse(result); } catch { throw new HttpError(502, 'qBittorrent devolvió una respuesta de alta no reconocida.'); }
        const success = Number(acceptance.success_count) || 0;
        const pending = Number(acceptance.pending_count) || 0;
        const failure = Number(acceptance.failure_count) || 0;
        if (!success && !pending && failure) throw new HttpError(502, 'qBittorrent no aceptó el enlace. Comprueba el magnet y sus trackers.');
        if (!success && !pending) throw new HttpError(502, 'qBittorrent no confirmó la recepción del enlace.');
      }
      if (response.status !== 409) addedHere = true;
      }
      return await createSessionFromTorrent(input.hash, details, addedHere);
  }

  async function createSessionFromTorrent(hash, initialDetails, addedHere) {
      const deadline = Date.now() + 90000;
      let files = [];
      try {
        while (Date.now() < deadline) {
          files = await getFiles(hash);
          if (files.length) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!files.length) throw new HttpError(504, 'El torrent no entregó metadatos en 90 segundos. Comprueba que tenga pares disponibles.');
        const playable = files.filter((file) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
        if (!playable.length) throw new HttpError(415, 'El torrent no contiene un vídeo reproducible.');
        let prioritiesSet = false;
        while (Date.now() < deadline) {
          const status = await mutateToleratingMetadata('torrents/filePrio', { hash, id: files.map((file) => file.index).join('|'), priority: '0' });
          if (status !== 409) { prioritiesSet = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
          files = await getFiles(hash);
          if (!files.length) continue;
        }
        if (!prioritiesSet) throw new HttpError(504, 'El torrent todavía no permite fijar sus archivos. Espera a que qBittorrent termine de leer los metadatos.');
        await mutate('torrents/stop', { hashes: hash });
        const details = await torrentInfo(hash) || initialDetails;
        const id = randomBytes(18).toString('base64url');
        const session = { id, hash, name: details?.name || 'Torrent', files, selectedIndex: null, activeStreams: 0, controllers: new Set(), timer: null, lastActivity: Date.now() };
        sessions.set(id, session); scheduleCleanup(id);
        return publicSession(session);
      } catch (error) {
        if (addedHere) try { await mutate('torrents/delete', { hashes: hash, deleteFiles: 'true' }); } catch {}
        throw error;
      }
  }

  async function mutateToleratingMetadata(path, values) {
    const response = await request(path, { method: 'POST', body: new URLSearchParams(values) }, true, [409]);
    await boundedBody(response.body, 1024);
    return response.status;
  }
}
