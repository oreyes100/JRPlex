import { randomInt } from 'node:crypto';
import { HttpError, localMediaUrl, opaque } from './security.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const seconds = value => { if (!Number.isFinite(value) || value < 0 || value > 604800) throw new HttpError(400, 'Posición de reproducción no válida.'); return value; };
const profile = {
  Name: 'JRPlex TV', MaxStreamingBitrate: 12000000, MaxStaticBitrate: 20000000,
  DirectPlayProfiles: [{ Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' }, { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3' }],
  TranscodingProfiles: [{ Container: 'ts', Type: 'Video', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2', MinSegments: 2, SegmentLength: 6, BreakOnNonKeyFrames: false }, { Container: 'mp3', Type: 'Audio', Protocol: 'http', Context: 'Streaming', AudioCodec: 'mp3', MaxAudioChannels: '2' }],
  CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: true }, { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '41', IsRequired: true }, { Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: false }, { Condition: 'LessThanEqual', Property: 'Height', Value: '1080', IsRequired: false }] }],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'Encode' }],
};

export function createCasting(config, { sessions, upstream, jsonResponse, currentUser, requireAdmin, torrent, proxy, body, send, sameOrigin, rateLimit, clientIp, now = Date.now }) {
  const grants = new Map(); const receivers = new Map();
  const owner = id => { const stored = sessions.get(id); return stored && stored.expires > now() ? { id, ...stored } : null; };
  function revoke(token) { const grant = grants.get(token); if (!grant) return; grants.delete(token); for (const response of grant.responses) response.destroy(); }
  function prune() {
    for (const [token, grant] of grants) if (grant.expires <= now() || !owner(grant.owner)) revoke(token);
    for (const [id, receiver] of receivers) if (receiver.expires <= now() || (receiver.owner && (!owner(receiver.owner) || receiver.seen < now() - 120000))) { revoke(receiver.mediaId); receivers.delete(id); }
  }
  const publicReceiver = receiver => ({ id: receiver.id, name: receiver.name, online: receiver.seen >= now() - 15000, state: receiver.state });
  function findReceiver(id, session) {
    prune(); const receiver = receivers.get(id);
    if (!receiver || receiver.owner !== session.id || receiver.seen < now() - 15000) throw new HttpError(404, 'La pantalla no está vinculada o dejó de responder.');
    return receiver;
  }
  function allowed(grant, url) {
    return grant.kind === 'library' && new RegExp(`^/jellyfin/(?:Videos|Audio)/${grant.itemId}/`).test(new URL(url, config.publicUrl).pathname);
  }
  function mediaUrl(grant, url) {
    if (!allowed(grant, url)) throw new HttpError(502, 'El servidor devolvió una fuente de TV no válida.');
    return `${config.publicUrl}/cast/media/${grant.id}${url}`;
  }
  async function createMedia(session, input) {
    prune(); rateLimit(`cast-media:${session.id}`, 30); const user = await currentUser(session);
    if (user.Policy?.EnableMediaPlayback === false) throw new HttpError(403, 'Tu usuario no tiene permiso de reproducción.');
    if (grants.size >= 1000 || [...grants.values()].filter(grant => grant.owner === session.id).length >= 4) throw new HttpError(429, 'Detén un envío anterior antes de enviar otro vídeo.');
    const grant = { id: opaque(), owner: session.id, expires: Math.min(session.expires, now() + 6 * 3600000), responses: new Set(), kind: input.kind };
    let path; let contentType; let title; let canSeek = true; let sourceInfo = {};
    if (input.kind === 'torrent') {
      await requireAdmin(session);
      if (!idPattern.test(input.sessionId || '') || !Number.isSafeInteger(input.fileIndex) || input.fileIndex < 0) throw new HttpError(400, 'Elige el vídeo del torrent.');
      const source = torrent.castSource(input.sessionId, input.fileIndex);
      Object.assign(grant, { torrentId: input.sessionId, fileIndex: input.fileIndex });
      contentType = source.contentType; canSeek = source.canSeek; title = source.name;
    } else if (input.kind === 'library') {
      if (!idPattern.test(input.itemId || '')) throw new HttpError(400, 'Elige un vídeo de la biblioteca.');
      grant.itemId = input.itemId;
      const itemResponse = await upstream(`/Users/${encodeURIComponent(session.user.Id)}/Items/${input.itemId}`, { session });
      if (!itemResponse.ok) { await itemResponse.body?.cancel(); throw new HttpError(403, 'No tienes acceso a este título.'); }
      const item = await jsonResponse(itemResponse);
      const audio = item.MediaType === 'Audio' || item.Type === 'Audio';
      if (item.IsFolder || (!audio && item.MediaType !== 'Video' && !['Movie', 'Episode', 'Video', 'MusicVideo', 'Recording'].includes(item.Type))) throw new HttpError(400, 'Elige un vídeo o una pista reproducible.');
      const response = await upstream(`/Items/${input.itemId}/PlaybackInfo`, { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ UserId: session.user.Id, IsPlayback: true, AutoOpenLiveStream: false, StartTimeTicks: 0, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, MaxStreamingBitrate: 12000000, DeviceProfile: profile }) });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'No se pudo preparar el vídeo para la TV.'); }
      const info = await jsonResponse(response);
      const sources = (info.MediaSources || []).filter(source => !source.RequiresOpening && !source.RequiresClosing && idPattern.test(source.Id || ''));
      const compatible = source => {
        const video = (source.MediaStreams || []).find(stream => stream.Type === 'Video');
        const track = (source.MediaStreams || []).find(stream => stream.Type === 'Audio');
        return audio ? source.Container === 'mp3' : /^(mp4|m4v)$/i.test(source.Container || '') && video?.Codec === 'h264' && (!source.Bitrate || source.Bitrate <= 20000000) && (!video.Width || video.Width <= 1920) && (!video.Height || video.Height <= 1080) && (!video.BitDepth || video.BitDepth <= 8) && (!video.Level || video.Level <= 41) && (!track || ['aac', 'mp3'].includes(track.Codec));
      };
      const source = sources.find(source => source.SupportsDirectPlay && compatible(source)) || sources.find(source => source.TranscodingUrl);
      if (!source || info.ErrorCode) throw new HttpError(415, 'Este vídeo no tiene una versión compatible para la TV.');
      const direct = source.SupportsDirectPlay && compatible(source);
      const rawUrl = direct ? `/${audio ? 'Audio' : 'Videos'}/${input.itemId}/stream${audio ? '.mp3' : '.mp4'}?Static=true&MediaSourceId=${encodeURIComponent(source.Id)}` : source.TranscodingUrl;
      path = localMediaUrl(rawUrl, `/Items/${input.itemId}/PlaybackInfo`, config);
      contentType = /\.m3u8(?:\?|$)/i.test(path) ? 'application/vnd.apple.mpegurl' : audio ? 'audio/mpeg' : 'video/mp4';
      title = item.Name || 'JRPlex';
      sourceInfo = { mediaSourceId: source.Id, playSessionId: info.PlaySessionId, playMethod: direct ? 'DirectPlay' : 'Transcode' };
      if (/mpegurl/i.test(contentType)) sourceInfo.hlsFormat = /mp4/i.test(source.TranscodingContainer || new URL(rawUrl, config.jellyfinUrl).searchParams.get('SegmentContainer') || 'ts') ? 'fmp4' : 'ts';
    } else throw new HttpError(400, 'Fuente de reproducción no válida.');
    const url = grant.kind === 'torrent' ? `${config.publicUrl}/cast/media/${grant.id}/torrent` : mediaUrl(grant, path);
    const media = { id: grant.id, url, contentType, title: String(title).slice(0, 256), canSeek, expiresAt: grant.expires, ...sourceInfo };
    grants.set(grant.id, grant); return media;
  }
  async function handlePublic(req, res, route) {
    prune();
    const match = route.match(/^\/cast\/media\/([A-Za-z0-9_-]{43})(\/.*)$/);
    if (match) {
      const grant = grants.get(match[1]); const session = grant && owner(grant.owner);
      if (!grant || !session) throw new HttpError(401, 'El envío a TV terminó o caducó.');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
      const target = match[2];
      if (grant.kind === 'torrent' ? target !== '/torrent' : !allowed(grant, target)) throw new HttpError(403, 'El enlace solo autoriza el vídeo seleccionado.');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
      const user = await currentUser(session);
      if (user.Policy?.EnableMediaPlayback === false) { revoke(grant.id); throw new HttpError(403, 'Reproducción revocada.'); }
      grant.responses.add(res); res.once('close', () => grant.responses.delete(res));
      if (grant.kind === 'torrent') { await requireAdmin(session); await torrent.stream(req, res, grant.torrentId, grant.fileIndex); }
      else {
        const query = new URL(req.url, config.publicUrl).search;
        await proxy(req, res, target, session, { requestUrl: target + query, mapMediaUrl: url => mediaUrl(grant, url) });
      }
      return true;
    }
    if (route === '/cast/receiver/start' && req.method === 'POST') {
      sameOrigin(req); rateLimit(`cast-start:${clientIp(req)}`, 20);
      if (receivers.size >= 1000) throw new HttpError(503, 'Hay demasiadas pantallas pendientes.');
      const input = await body(req); let code;
      do { code = String(randomInt(100000, 1000000)); } while ([...receivers.values()].some(receiver => receiver.code === code));
      const receiver = { id: opaque(), secret: opaque(), name: typeof input.name === 'string' ? input.name.trim().slice(0, 60) || 'Mi TV' : 'Mi TV', code, owner: null, expires: now() + 300000, seen: now(), sequence: 0, commands: [], mediaId: null, state: { status: 'ready', position: 0, duration: 0, paused: true, mediaId: null } };
      receivers.set(receiver.id, receiver);
      send(res, 201, { secret: receiver.secret, code, expiresAt: receiver.expires }); return true;
    }
    if (route === '/cast/receiver/poll' && req.method === 'POST') {
      sameOrigin(req); rateLimit(`cast-poll:${clientIp(req)}`, 6000);
      const input = await body(req);
      const receiver = typeof input.secret === 'string' && [...receivers.values()].find(receiver => receiver.secret === input.secret);
      if (!receiver) throw new HttpError(401, 'La vinculación terminó. Genera otro código.');
      receiver.seen = now();
      if (!Number.isSafeInteger(input.ack) || input.ack < 0 || input.ack > receiver.sequence) throw new HttpError(400, 'Estado de pantalla no válido.');
      receiver.commands = receiver.commands.filter(command => command.sequence > input.ack);
      const state = input.state;
      if (receiver.owner && state && state.mediaId === receiver.mediaId && ['ready', 'buffering', 'playing', 'paused', 'blocked', 'ended', 'error'].includes(state.status)) {
        receiver.state = { mediaId: receiver.mediaId, status: state.status, position: seconds(state.position), duration: seconds(state.duration), paused: !!state.paused };
      }
      send(res, 200, { paired: !!receiver.owner, commands: receiver.commands }); return true;
    }
    return false;
  }
  async function handle(req, res, route, session) {
    if (!route.startsWith('/api/cast/')) return false;
    prune();
    if (route === '/api/cast/media' && req.method === 'POST') { send(res, 201, await createMedia(session, await body(req))); return true; }
    const revokeMatch = route.match(/^\/api\/cast\/media\/([A-Za-z0-9_-]{43})$/);
    if (revokeMatch && req.method === 'DELETE') {
      const grant = grants.get(revokeMatch[1]);
      if (grant && grant.owner !== session.id) throw new HttpError(403, 'El envío pertenece a otra sesión.');
      revoke(revokeMatch[1]); send(res, 200, { ok: true }); return true;
    }
    if (route === '/api/cast/pair' && req.method === 'POST') {
      await currentUser(session); rateLimit(`cast-pair:${session.id}`, 10); rateLimit(`cast-pair-ip:${clientIp(req)}`, 30);
      const input = await body(req);
      const receiver = typeof input.code === 'string' && /^\d{6}$/.test(input.code) && [...receivers.values()].find(receiver => !receiver.owner && receiver.code === input.code);
      if (!receiver) throw new HttpError(404, 'Código incorrecto o caducado. Comprueba el código en la TV.');
      receiver.owner = session.id; receiver.code = null; receiver.expires = session.expires;
      send(res, 200, publicReceiver(receiver)); return true;
    }
    if (route === '/api/cast/receivers' && req.method === 'GET') {
      await currentUser(session); send(res, 200, { receivers: [...receivers.values()].filter(receiver => receiver.owner === session.id).map(publicReceiver) }); return true;
    }
    const receiverMatch = route.match(/^\/api\/cast\/receivers\/([A-Za-z0-9_-]{43})\/(play|command)$/);
    if (receiverMatch && req.method === 'POST') {
      const receiver = findReceiver(receiverMatch[1], session); const input = await body(req);
      if (receiverMatch[2] === 'play') {
        const position = seconds(input.position ?? 0); const media = await createMedia(session, input);
        revoke(receiver.mediaId); receiver.mediaId = media.id; receiver.commands = [];
        receiver.state = { status: 'buffering', position: media.canSeek ? position : 0, duration: 0, paused: true, mediaId: media.id };
        receiver.commands.push({ sequence: ++receiver.sequence, command: 'play', media, position: media.canSeek ? position : 0 });
        send(res, 200, { media, receiver: publicReceiver(receiver) }); return true;
      }
      await currentUser(session);
      if (!['pause', 'resume', 'stop', 'seek'].includes(input.command)) throw new HttpError(400, 'Control de TV no válido.');
      if (receiver.commands.length >= 20) throw new HttpError(429, 'La pantalla no está respondiendo a los controles.');
      const command = { sequence: ++receiver.sequence, command: input.command };
      if (input.command === 'seek') command.position = seconds(input.position);
      if (input.command === 'stop') { revoke(receiver.mediaId); receiver.mediaId = null; receiver.commands = []; receiver.state = { status: 'ready', position: 0, duration: 0, paused: true, mediaId: null }; }
      receiver.commands.push(command); send(res, 200, { ok: true }); return true;
    }
    throw new HttpError(404, 'Cast route not found');
  }
  function revokeSession(id) {
    for (const [token, grant] of grants) if (grant.owner === id) revoke(token);
    for (const [key, receiver] of receivers) if (receiver.owner === id) receivers.delete(key);
  }
  return { handle, handlePublic, revokeSession, close() { for (const token of grants.keys()) revoke(token); receivers.clear(); } };
}
