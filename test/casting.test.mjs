import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, loadConfig } from '../server.mjs';

async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t) {
  const state = { admin: true, disabled: false, denied: false, hls: false, external: false, slow: false, now: Date.now(), torrentCalls: [], requests: [] };
  const media = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost'); state.requests.push({ path: url.pathname, query: url.searchParams, body: raw });
    const json = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const user = name => ({ Id: name, Name: name, Policy: { IsAdministrator: state.admin, IsDisabled: state.disabled, EnableMediaPlayback: true } });
    if (url.pathname === '/Users/AuthenticateByName') { const name = JSON.parse(raw).Username; return json({ AccessToken: `${name}_PRIVATE_TOKEN`, User: user(name) }); }
    const name = req.headers.authorization?.includes('bob_PRIVATE_TOKEN') ? 'bob' : 'alice';
    if (url.pathname === '/Users/Me') return json(user(name));
    if (/^\/Users\/(alice|bob)\/Items\/movie$/.test(url.pathname)) return json({ Id: 'movie', Name: 'Synthetic film', Type: 'Movie', MediaType: 'Video' }, state.denied ? 404 : 200);
    if (url.pathname === '/Items/movie/PlaybackInfo') return json({ PlaySessionId: 'play_session', MediaSources: [{ Id: 'source', SupportsDirectPlay: !state.hls && !state.external, Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', BitDepth: 8, Level: 40 }, { Type: 'Audio', Codec: 'aac' }], TranscodingUrl: state.external ? 'https://evil.invalid/movie.m3u8?api_key=PRIVATE' : '/videos/movie/master.m3u8?api_key=PRIVATE&MediaSourceId=source' }] });
    if (url.pathname === '/Videos/movie/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?api_key=PRIVATE"\n#EXT-X-KEY:METHOD=AES-128,URI="key?AccessToken=PRIVATE"\nchild/segment.ts\n'); }
    if (url.pathname === '/Videos/movie/child/segment.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('segment'); }
    if (url.pathname === '/Videos/movie/stream.mp4') {
      if (state.slow) { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write('first-frame'); return; }
      const partial = !!req.headers.range; res.writeHead(partial ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': partial ? 4 : 8, 'accept-ranges': 'bytes', ...(partial ? { 'content-range': 'bytes 2-5/8' } : {}) }); return res.end(req.method === 'HEAD' ? undefined : partial ? '2345' : '01234567');
    }
    if (url.pathname === '/Sessions/Logout') { res.writeHead(204); return res.end(); }
    return json({}, 404);
  });
  const upstream = await start(media);
  const config = loadConfig({ JELLYFIN_URL: upstream });
  const torrentClient = { castSource(id, index) { state.torrentCalls.push(['source', id, index]); if (id !== 'selected_torrent' || index !== 0) throw Object.assign(new Error('Not found'), { status: 404 }); return { contentType: 'video/mp4', name: 'Synthetic torrent', canSeek: false }; }, async stream(req, res, id, index) { state.torrentCalls.push(['stream', id, index]); res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(req.method === 'HEAD' ? undefined : 'torrent-frame'); }, close() {} };
  const app = createApp(config, { torrentClient, castingNow: () => state.now });
  const base = await start(app.server); config.publicUrl = base;
  t.after(async () => { app.close(); app.server.closeAllConnections(); media.closeAllConnections(); await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => media.close(resolve))]); });
  const request = (path, options) => fetch(new URL(path, base), options);
  const login = async (username = 'alice') => {
    const response = await request('/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'fixture' }) });
    const data = await response.json(); return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  };
  const call = (session, path, data, method = 'POST') => request(path, { method, headers: { Cookie: session.cookie, Origin: base, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(data || {}) }) });
  const receiverCall = (path, data) => request(path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { app, base, state, request, login, call, receiverCall };
}

test('cast capability serves only its authorized item without cookies, supports CORS Range HEAD and revokes on logout', async t => {
  const f = await fixture(t); const session = await f.login();
  assert.equal((await f.request('/api/cast/media', { method: 'POST' })).status, 401);
  const response = await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie', url: 'https://evil.invalid' }); assert.equal(response.status, 201);
  const media = await response.json(); assert.equal(media.canSeek, true); assert.equal(media.contentType, 'video/mp4'); assert.ok(media.url.startsWith(f.base + '/cast/media/')); assert.doesNotMatch(JSON.stringify(media), /PRIVATE_TOKEN|api_key|evil/);
  const video = await f.request(media.url, { headers: { Range: 'bytes=2-5', Origin: 'https://www.gstatic.com' } });
  assert.equal(video.status, 206); assert.equal(video.headers.get('access-control-allow-origin'), '*'); assert.equal(video.headers.get('content-range'), 'bytes 2-5/8'); assert.equal(await video.text(), '2345');
  assert.equal((await f.request(media.url, { method: 'OPTIONS' })).status, 204);
  const head = await f.request(media.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '8');
  assert.equal((await f.request(media.url.replace('/Videos/movie/', '/Videos/other/'))).status, 403);
  assert.equal((await f.request(media.url.replace('/jellyfin/Videos/movie/stream.mp4', '/jellyfin/Users'))).status, 403);
  await f.call(session, '/api/logout'); assert.equal((await f.request(media.url)).status, 401);
});

test('HLS children, init and key URIs keep the scoped capability and upstream credentials remain hidden', async t => {
  const f = await fixture(t); const session = await f.login(); f.state.hls = true;
  const media = await (await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' })).json();
  assert.match(media.contentType, /mpegurl/);
  assert.equal(media.hlsFormat, 'ts');
  const playlist = await (await f.request(media.url)).text();
  assert.doesNotMatch(playlist, /PRIVATE|api_key|AccessToken/);
  assert.equal((playlist.match(new RegExp(`/cast/media/${media.id}/jellyfin/Videos/movie/`, 'g')) || []).length, 3);
  const segment = playlist.split('\n').find(line => line.includes('segment.ts'));
  assert.equal(await (await f.request(segment)).text(), 'segment');
  f.state.external = true;
  assert.equal((await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' })).status, 502);
});

test('regular users cast their permitted library items, other sessions cannot revoke grants and media expires', async t => {
  const f = await fixture(t); f.state.admin = false; const session = await f.login(); const other = await f.login('bob');
  f.state.denied = true;
  assert.equal((await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' })).status, 403);
  f.state.denied = false;
  const response = await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' }); assert.equal(response.status, 201);
  const media = await response.json();
  assert.equal((await f.call(other, `/api/cast/media/${media.id}`, {}, 'DELETE')).status, 403);
  assert.equal((await f.request(media.url)).status, 200);
  f.state.now += 6 * 3600000 + 1;
  assert.equal((await f.request(media.url)).status, 401);
});

test('pairing is one-use, requires CSRF, keeps receiver secret private and limits commands to owner', async t => {
  const f = await fixture(t); const alice = await f.login(); const bob = await f.login('bob');
  const started = await (await f.receiverCall('/cast/receiver/start', { name: 'Living room Fire TV' })).json(); assert.match(started.code, /^\d{6}$/);
  const noCsrf = await f.request('/api/cast/pair', { method: 'POST', headers: { Cookie: alice.cookie, Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: started.code }) }); assert.equal(noCsrf.status, 403);
  const receiver = await (await f.call(alice, '/api/cast/pair', { code: started.code })).json(); assert.equal(receiver.name, 'Living room Fire TV'); assert.equal(receiver.secret, undefined);
  assert.equal((await f.call(bob, '/api/cast/pair', { code: started.code })).status, 404);
  assert.deepEqual((await (await f.call(bob, '/api/cast/receivers', null, 'GET')).json()).receivers, []);
  assert.equal((await f.call(bob, `/api/cast/receivers/${receiver.id}/play`, { kind: 'library', itemId: 'movie', position: 12 })).status, 404);
  const command = await (await f.call(alice, `/api/cast/receivers/${receiver.id}/play`, { kind: 'library', itemId: 'movie', position: 12 })).json();
  let result = await (await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: 0 })).json();
  assert.equal(result.paired, true); assert.equal(result.commands[0].position, 12); assert.equal(result.commands[0].media.id, command.media.id);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|api_key/);
  const sequence = result.commands[0].sequence;
  result = await (await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: sequence, state: { mediaId: command.media.id, status: 'playing', position: 14, duration: 100, paused: false } })).json(); assert.deepEqual(result.commands, []);
  const list = await (await f.call(alice, '/api/cast/receivers', null, 'GET')).json(); assert.equal(list.receivers[0].state.position, 14);
  assert.equal((await f.call(bob, `/api/cast/receivers/${receiver.id}/command`, { command: 'stop' })).status, 404);
  await f.call(alice, `/api/cast/receivers/${receiver.id}/command`, { command: 'pause' });
  result = await (await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: sequence })).json(); assert.equal(result.commands[0].command, 'pause');
  await f.call(alice, `/api/cast/receivers/${receiver.id}/command`, { command: 'stop' }); assert.equal((await f.request(command.media.url)).status, 401);
  await f.call(alice, '/api/logout'); assert.equal((await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: 0 })).status, 401);
});

test('expired codes and receiver secrets are rejected and pairing guesses are bounded', async t => {
  const f = await fixture(t); const session = await f.login();
  const started = await (await f.receiverCall('/cast/receiver/start', {})).json(); f.state.now += 300001;
  assert.equal((await f.call(session, '/api/cast/pair', { code: started.code })).status, 404);
  assert.equal((await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: 0 })).status, 401);
  for (let attempt = 0; attempt < 9; attempt++) assert.equal((await f.call(session, '/api/cast/pair', { code: '000000' })).status, 404);
  assert.equal((await f.call(session, '/api/cast/pair', { code: '000000' })).status, 429);
});

test('native TV ending a receiver requires its secret and same origin, and revokes only its media and pairing', async t => {
  const f = await fixture(t); const owner = await f.login();
  const installer = await f.request('/firetv'); assert.equal(installer.status, 200);
  const page = await installer.text(); assert.match(page, /jrplex-firetv-1\.0\.0\.apk/); assert.match(page, /Vega OS/);
  assert.match(installer.headers.get('content-security-policy'), /default-src 'none'/);
  const started = await (await f.receiverCall('/cast/receiver/start', { name: 'JRPlex Fire TV' })).json();
  const receiver = await (await f.call(owner, '/api/cast/pair', { code: started.code })).json();
  const { media } = await (await f.call(owner, `/api/cast/receivers/${receiver.id}/play`, { kind: 'library', itemId: 'movie' })).json();
  const other = await (await f.receiverCall('/cast/receiver/start', { name: 'Other screen' })).json();
  assert.equal((await f.request('/cast/receiver/end', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: started.secret }) })).status, 403);
  assert.equal((await f.receiverCall('/cast/receiver/end', { secret: receiver.id })).status, 401);
  assert.equal((await f.receiverCall('/cast/receiver/end', { secret: 'wrong' })).status, 401);
  assert.equal((await f.request(media.url)).status, 200);
  f.state.slow = true; const transfer = await f.request(media.url); const reader = transfer.body.getReader(); await reader.read();
  assert.equal((await f.receiverCall('/cast/receiver/end', { secret: started.secret })).status, 200);
  await assert.rejects(reader.read());
  assert.equal((await f.request(media.url)).status, 401);
  assert.equal((await f.receiverCall('/cast/receiver/poll', { secret: started.secret, ack: 0 })).status, 401);
  assert.equal((await f.receiverCall('/cast/receiver/poll', { secret: other.secret, ack: 0 })).status, 200);
  assert.deepEqual((await (await f.call(owner, '/api/cast/receivers', null, 'GET')).json()).receivers, []);
});

test('torrent cast uses the already selected stream, requires current admin, and never calls play or delete', async t => {
  const f = await fixture(t); const session = await f.login();
  const response = await f.call(session, '/api/cast/media', { kind: 'torrent', sessionId: 'selected_torrent', fileIndex: 0 }); assert.equal(response.status, 201);
  const media = await response.json(); assert.equal(media.canSeek, false); assert.equal(await (await f.request(media.url)).text(), 'torrent-frame');
  assert.deepEqual(f.state.torrentCalls, [['source', 'selected_torrent', 0], ['stream', 'selected_torrent', 0]]);
  f.state.admin = false; assert.equal((await f.request(media.url)).status, 403);
  assert.equal((await f.call(session, '/api/cast/media', { kind: 'torrent', sessionId: 'selected_torrent', fileIndex: 0 })).status, 403);
});

test('deleting a grant or disabling the owner revokes media and active transfers are aborted', async t => {
  const f = await fixture(t); const session = await f.login();
  const media = await (await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' })).json(); f.state.slow = true;
  const response = await f.request(media.url); const reader = response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), 'first-frame');
  await f.call(session, `/api/cast/media/${media.id}`, {}, 'DELETE'); await assert.rejects(reader.read());
  const second = await (await f.call(session, '/api/cast/media', { kind: 'library', itemId: 'movie' })).json(); f.state.disabled = true;
  assert.equal((await f.request(second.url)).status, 401);
  assert.equal((await f.request(second.url)).status, 401);
});
