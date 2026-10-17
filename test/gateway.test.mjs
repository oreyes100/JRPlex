import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, loadConfig } from '../server.mjs';
import { HttpError, privateEndpoint, rewritePlaylist, equal, sanitizeJson, localMediaUrl } from '../lib/security.mjs';
import { torrentInput } from '../lib/torrents.mjs';

async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, overrides = {}, options = {}) {
  const state = { admin: true, disabled: false, requests: [], logout: 0, denied: false, libraries: [], failRemovePath: false, itemsDelay: 0 };
  const user = () => ({ Id: 'alice', Name: 'Alice', Policy: { IsAdministrator: state.admin, IsDisabled: state.disabled } });
  const media = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    state.requests.push({ path: url.pathname, query: url.searchParams, method: req.method, headers: req.headers, body: raw });
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/Users/AuthenticateByName') {
      const input = JSON.parse(raw);
      return input.Username === 'alice' && input.Pw === 'valid-password' ? json({ AccessToken: 'TOP_SECRET_TOKEN', User: user() }) : json({ error: 'Invalid' }, 401);
    }
    if (!req.headers.authorization?.includes('Token="TOP_SECRET_TOKEN"')) return json({}, 401);
    if (url.pathname === '/Users/Me') return json(user());
    if (url.pathname === '/Users/alice/Views') return json({ Items: [{ Id: 'photo-library', Name: 'Photos', CollectionType: 'photos' }] });
    if (url.pathname === '/Environment/DirectoryContents') {
      const locations = {
        '/media/local': [{ Name: 'Peliculas' }, { Name: 'Musica' }, { Name: '../escape' }],
        '/media/local/Peliculas': [{ Name: 'Animacion' }],
        '/media/cloud': [{ Name: 'DESCARGAS' }],
      };
      return json(locations[url.searchParams.get('path')] || []);
    }
    if (url.pathname === '/Users/Password') {
      const input = JSON.parse(raw);
      if (input.CurrentPw !== 'valid-password') return json({ error: 'Wrong current password' }, 400);
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/Sessions/Logout') { state.logout++; res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/Users/alice/Items/')) return json({ Id: url.pathname.split('/').at(-1) }, state.denied ? 404 : 200);
    if (url.pathname === '/Items') { if (state.itemsDelay) await new Promise(resolve => setTimeout(resolve, state.itemsDelay)); return json({ Items: [{ Id: 'movie', Name: 'A film', Type: 'Movie', MediaType: 'Video', Path: '/private/media/file.mp4', AccessToken: 'TOP_SECRET_TOKEN', Metadata: { ApiKey: 'TOP_SECRET_TOKEN', Url: '/x?api_key=TOP_SECRET_TOKEN' } }] }); }
    if (url.pathname === '/Items/photo/Images/Primary') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end('photo-thumb'); }
    if (url.pathname === '/Items/movie/PlaybackInfo') return json({ MediaSources: [{ Id: 'source', Path: '/private/media', TranscodingUrl: '/videos/movie/master.m3u8?api_key=TOP_SECRET_TOKEN&MediaSourceId=source' }] });
    if (url.pathname === '/Videos/movie/master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-MAP:URI="/videos/movie/init.mp4?api_key=TOP_SECRET_TOKEN"\n#EXT-X-KEY:METHOD=AES-128,URI="key?AccessToken=TOP_SECRET_TOKEN"\n/videos/movie/child/seg.ts?api_key=TOP_SECRET_TOKEN\n'); }
    if (url.pathname === '/Videos/movie/child/seg.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end('media-segment'); }
    if (url.pathname === '/Videos/movie/evil.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\nhttps://evil.example/segment.ts\n'); }
    if (url.pathname === '/Videos/movie/redirect.mp4') { res.writeHead(302, { Location: 'https://evil.example/' }); return res.end(); }
    if (url.pathname === '/Videos/movie/stream.mp4') {
      const range = req.headers.range;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': range ? 4 : 8, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes 2-5/8' } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : range ? '2345' : '01234567');
    }
    if (url.pathname === '/Users') return json([user()]);
    if (url.pathname === '/Library/VirtualFolders' && req.method === 'GET') return json(state.libraries);
    if (url.pathname === '/Library/VirtualFolders/Paths') {
      const input = raw ? JSON.parse(raw) : {};
      const library = state.libraries.find(l => l.Name === (input.Name || url.searchParams.get('name')));
      if (!library) return json({}, 404);
      if (req.method === 'POST') library.Locations = [...new Set([...library.Locations, input.PathInfo.Path])];
      else {
        if (state.failRemovePath) { state.failRemovePath = false; return json({}, 500); }
        library.Locations = library.Locations.filter(p => p !== url.searchParams.get('path'));
      }
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/Library/VirtualFolders/LibraryOptions' && req.method === 'POST') {
      const input = raw ? JSON.parse(raw) : {}; const library = state.libraries.find(l => l.ItemId === input.Id);
      if (!library) return json({}, 404); library.LibraryOptions = input.LibraryOptions; return json({ ok: true });
    }
    if (url.pathname === '/Library/Refresh') { res.writeHead(204); return res.end(); }
    return json({ ok: true });
  });
  const upstream = await start(media);
  const config = { ...loadConfig({ JELLYFIN_URL: upstream, PUBLIC_URL: 'http://localhost:8787' }), ...overrides };
  const app = createApp(config, options);
  const base = await start(app.server);
  t.after(async () => { app.server.closeAllConnections(); media.closeAllConnections(); await Promise.all([new Promise((resolve) => app.server.close(resolve)), new Promise((resolve) => media.close(resolve))]); });
  const request = (path, options = {}) => fetch(base + path, options);
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', headers: { Origin: config.publicUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'valid-password' }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], cookieHeader: response.headers.get('set-cookie'), ...(await response.json()) };
  };
  return { state, app, base, request, login, config };
}

const authHeaders = (session, config) => ({ Cookie: session.cookie, Origin: config.publicUrl, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' });

test('health reveals no backend details; anonymous API and streams are denied', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/healthz')).json(), { status: 'ok' });
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal((await f.request('/jellyfin/Videos/movie/stream.mp4')).status, 401);
  assert.equal(f.state.requests.length, 0);
});

test('slow Jellyfin catalogue returns an actionable timeout instead of a blank indefinite load', async t => {
  const f = await fixture(t, { upstreamTimeout: 25 }); const session = await f.login(); f.state.itemsDelay = 100;
  const response = await f.request('/jellyfin/Items?Recursive=true&Limit=20&IncludeItemTypes=Movie', { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /biblioteca.*tardó demasiado/i);
});

test('admin folder browser is read-only, filters entries, and rejects parent traversal', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/folders?source=local')).status, 401);
  const session = await f.login();
  const list = async (query) => f.request(`/api/admin/folders?${query}`, { headers: { Cookie: session.cookie } });
  const rootListing = await list('source=local');
  assert.equal(rootListing.status, 200);
  assert.deepEqual((await rootListing.json()).folders, ['Musica', 'Peliculas'], 'untrusted path-shaped entries are not returned');
  const filtered = await list('source=local&search=music');
  assert.deepEqual((await filtered.json()).folders, ['Musica']);
  assert.equal((await list('source=local&path=..')).status, 400);
  const nested = await list('source=local&path=Peliculas');
  assert.deepEqual((await nested.json()).folders, ['Animacion']);
  assert.equal(f.state.requests.filter(request => request.path === '/Environment/DirectoryContents').length, 3);
});

test('admins can browse Drive folders and save a shared Google folder link as a mounted library path', async (t) => {
  const folderId = 'southparkfolder123456'; const driveLink = `https://drive.google.com/drive/folders/${folderId}?hl=es-419`;
  const googleOAuth = {
    listFolders: async (parentId, pageToken) => ({ parentId: parentId || null, folders: [{ id: folderId, name: 'South Park' }], nextPageToken: pageToken ? null : 'next' }),
    resolveFolderUrl: async value => { assert.equal(value, driveLink); return '/media/cloud/Series/South Park'; },
    status: async () => ({ configured: true, linked: true }),
  };
  const f = await fixture(t, {}, { googleOAuth });
  f.state.libraries.push({ ItemId: 'library-id', Name: 'Películas', Locations: ['/media/cloud'], LibraryOptions: { PathInfos: [{ Path: '/media/cloud' }] } });
  const session = await f.login();
  const listing = await f.request(`/api/admin/google-drive/folders?parentId=${encodeURIComponent('seriesfolder12345678')}`, { headers: { Cookie: session.cookie } });
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), { parentId: 'seriesfolder12345678', folders: [{ id: folderId, name: 'South Park' }], nextPageToken: 'next' });
  const mapped = await f.request('/api/admin/libraries/library-id/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ path: driveLink, previousPaths: ['/media/cloud'] }) });
  assert.equal(mapped.status, 200);
  assert.equal((await mapped.json()).path, '/media/cloud/Series/South Park');
  assert.deepEqual(f.state.libraries[0].Locations, ['/media/cloud/Series/South Park']);
  const created = await f.request('/jellyfin/Library/VirtualFolders?name=South%20Park&collectionType=movies&refreshLibrary=false', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: driveLink }] } }) });
  assert.equal(created.status, 200);
  const createRequest = f.state.requests.find(request => request.path === '/Library/VirtualFolders' && request.method === 'POST');
  assert.equal(JSON.parse(createRequest.body).LibraryOptions.PathInfos[0].Path, '/media/cloud/Series/South Park');
  const viewer = { ...session, cookie: session.cookie };
  f.state.admin = false;
  const denied = await f.request('/api/admin/google-drive/folders', { headers: { Cookie: viewer.cookie } });
  assert.equal(denied.status, 403);
});

test('public homepage and privacy policy need no login; player remains separately available', async (t) => {
  const f = await fixture(t);
  const page = await f.request('/');
  assert.equal(page.status, 200);
  const homepage = await page.text();
  assert.match(homepage, /JRPlex/);
  assert.match(homepage, /href="\/privacy"/);
  assert.match(homepage, /href="\/app"/);
  const privacy = await f.request('/privacy');
  assert.equal(privacy.status, 200);
  const policy = await privacy.text();
  assert.match(policy, /drive\.readonly/i);
  assert.match(policy, /cifrad/i);
  const player = await f.request('/app');
  assert.equal(player.status, 200);
  assert.match(await player.text(), /<script type="module" src="\/app\.js"><\/script>/);
  for (const asset of ['/app.js', '/media-eligibility.js']) {
    const response = await f.request(asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/javascript\b/i);
  }
});

test('Google Drive OAuth status and start are admin-only, CSRF protected, and form callback redirects without code', async (t) => {
  let callbackRequest = '';
  const googleOAuth = {
    callbackPath: '/api/google-drive/callback',
    status: async () => ({ configured: true, linked: false, mountVerified: false }),
    start: async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque-test',
    callback: async (requestUrl) => { callbackRequest = requestUrl; return { redirect: 'http://localhost:8787/app?cloud=google-linked' }; },
    disconnect: async () => {},
  };
  const f = await fixture(t, {}, { googleOAuth });
  assert.equal((await f.request('/api/admin/google-drive/status')).status, 401);
  const session = await f.login();
  assert.deepEqual(await (await f.request('/api/admin/google-drive/status', { headers: { Cookie: session.cookie } })).json(), { configured: true, linked: false, mountVerified: false });
  assert.equal((await f.request('/api/admin/google-drive/connect', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const start = await f.request('/api/admin/google-drive/connect', { method: 'POST', headers: authHeaders(session, f.config), body: '{}' });
  assert.equal(start.status, 200); assert.match((await start.json()).url, /^https:\/\/accounts\.google\.com\//);
  const callback = await f.request('/api/google-drive/callback', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=SENSITIVE_CODE&state=opaque-test' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), 'http://localhost:8787/app?cloud=google-linked');
  assert.doesNotMatch(callback.headers.get('location'), /SENSITIVE_CODE|state=/);
  assert.match(callbackRequest, /SENSITIVE_CODE/);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
});

test('login returns opaque secure cookie and server-held CSRF without upstream token', async (t) => {
  const f = await fixture(t, { publicUrl: 'https://jrplex.example' });
  const session = await f.login();
  assert.match(session.cookieHeader, /^__Host-jrplex_session=/);
  assert.match(session.cookieHeader, /HttpOnly/); assert.match(session.cookieHeader, /SameSite=Strict/); assert.match(session.cookieHeader, /; Secure/);
  assert.ok(!JSON.stringify(session).includes('TOP_SECRET_TOKEN'));
  const response = await f.request('/api/session', { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 200); assert.equal((await response.json()).user.Id, 'alice');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('login and mutations reject cross-origin and missing or invalid CSRF', async (t) => {
  const f = await fixture(t);
  const rejected = await f.request('/api/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403);
  const session = await f.login();
  for (const headers of [{ Cookie: session.cookie }, { ...authHeaders(session, f.config), 'X-CSRF-Token': 'wrong' }, { ...authHeaders(session, f.config), Origin: 'https://evil.example' }]) {
    assert.equal((await f.request('/api/logout', { method: 'POST', headers })).status, 403);
  }
  assert.equal(f.state.logout, 0);
});

test('logout revokes local cookie and calls upstream logout', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const response = await f.request('/api/logout', { method: 'POST', headers: authHeaders(session, f.config) });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(f.state.logout, 1);
  assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).status, 401);
});

test('expired session and disabled upstream user are denied', async (t) => {
  const f = await fixture(t); const session = await f.login();
  f.state.disabled = true;
  assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).status, 401);
  f.state.disabled = false;
  const another = await f.login();
  for (const stored of f.app.sessions.values()) stored.expires = Date.now() - 1;
  assert.equal((await f.request('/api/session', { headers: { Cookie: another.cookie } })).status, 401);
});

test('failed login is rate limited, request format and size are bounded', async (t) => {
  const f = await fixture(t, { maxBody: 128 });
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x'.repeat(200), password: 'x' }) })).status, 413);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json' }, body: '{"username":"alice","password":"bad"}' })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json' }, body: '{"username":"alice","password":"bad"}' })).status, 429);
});

test('catalog forces current user and redacts backend credentials and filesystem paths for regular users', async (t) => {
  const f = await fixture(t); f.state.admin = false; const session = await f.login();
  const response = await f.request('/jellyfin/Items?UserId=bob&userIds=bob&api_key=attacker&AccessToken=attacker', { headers: { Cookie: session.cookie, Authorization: 'Bearer attacker' } });
  assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(!text.includes('TOP_SECRET_TOKEN')); assert.ok(!text.includes('/private/media'));
  assert.equal(JSON.parse(text).Items[0].JRPlexMediaExtension, '.mp4');
  assert.equal(JSON.parse(text).Items[0].Path, undefined);
  const forwarded = f.state.requests.at(-1);
  assert.equal(forwarded.query.get('userId'), 'alice'); assert.equal(forwarded.query.get('UserId'), null); assert.equal(forwarded.query.get('userIds'), null);
  assert.equal(forwarded.query.get('api_key'), null); assert.equal(forwarded.query.get('AccessToken'), null);
  assert.match(forwarded.headers.authorization, /TOP_SECRET_TOKEN/); assert.ok(!forwarded.headers.authorization.includes('attacker'));
  assert.equal((await f.request('/jellyfin/Users/bob/Items', { headers: { Cookie: session.cookie } })).status, 403);
});

test('photo library and thumbnails stay inside the authenticated user scope', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const viewsResponse = await f.request('/jellyfin/Users/alice/Views?UserId=bob', { headers: { Cookie: session.cookie } });
  assert.equal(viewsResponse.status, 200);
  assert.equal((await viewsResponse.json()).Items[0].CollectionType, 'photos');
  assert.equal(f.state.requests.at(-1).query.get('userId'), 'alice');
  assert.equal((await f.request('/jellyfin/Users/bob/Views', { headers: { Cookie: session.cookie } })).status, 403);
  const photo = await f.request('/jellyfin/Items/photo/Images/Primary?maxWidth=1600', { headers: { Cookie: session.cookie } });
  assert.equal(photo.status, 200);
  assert.equal(await photo.text(), 'photo-thumb');
  assert.ok(f.state.requests.some(request => request.path === '/Users/alice/Items/photo'));
  f.state.denied = true;
  assert.equal((await f.request('/jellyfin/Items/photo/Images/Primary', { headers: { Cookie: session.cookie } })).status, 403);
});

test('playback info injects current user and rewrites transcoding URL', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const response = await f.request('/jellyfin/Items/movie/PlaybackInfo', { method: 'POST', headers: authHeaders(session, f.config), body: '{"UserId":"bob","userId":"eve"}' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.MediaSources[0].TranscodingUrl, '/jellyfin/Videos/movie/master.m3u8?MediaSourceId=source');
  assert.equal(JSON.parse(f.state.requests.at(-1).body).UserId, 'alice');
  assert.equal(JSON.parse(f.state.requests.at(-1).body).userId, undefined);
});

test('lower-case transcoding paths become canonical and remain authorized through HLS segments', async (t) => {
  const f = await fixture(t); const session = await f.login(); const headers = authHeaders(session, f.config);
  const info = await f.request('/jellyfin/Items/movie/PlaybackInfo', { method: 'POST', headers, body: '{}' });
  const path = (await info.json()).MediaSources[0].TranscodingUrl;
  assert.match(path, /^\/jellyfin\/Videos\/movie\/master\.m3u8/);
  const playlistResponse = await f.request(path, { headers }); assert.equal(playlistResponse.status, 200);
  const playlist = await playlistResponse.text();
  const segmentPath = playlist.split('\n').find((line) => line && !line.startsWith('#'));
  assert.equal(segmentPath, '/jellyfin/Videos/movie/child/seg.ts');
  const segment = await f.request(segmentPath, { headers }); assert.equal(segment.status, 200); assert.equal(await segment.text(), 'media-segment');
  const forwarded = f.state.requests.at(-1);
  assert.equal(forwarded.path, '/Videos/movie/child/seg.ts'); assert.match(forwarded.headers.authorization, /TOP_SECRET_TOKEN/);
  assert.equal(forwarded.query.get('api_key'), null);
  f.state.denied = true;
  assert.equal((await f.request(path, { headers })).status, 403);
  assert.equal((await f.request(segmentPath, { headers })).status, 403);
  assert.equal((await f.request('/jellyfin/videos/movie/master.m3u8', { headers })).status, 403, 'raw lower-case routes do not bypass the allowlist');
  assert.equal(localMediaUrl('/vIdEoS/AbCd-ID/LowerCase/Segment.TS?api_key=secret', '/', f.config), '/jellyfin/Videos/AbCd-ID/LowerCase/Segment.TS');
  for (const [input, expected] of [['audio', 'Audio'], ['items', 'Items'], ['shows', 'Shows']]) assert.equal(localMediaUrl(`/${input}/AbCd`, '/', f.config), `/jellyfin/${expected}/AbCd`);
});

test('range and HEAD streams preserve content headers and enforce item access', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const headers = { Cookie: session.cookie, Range: 'bytes=2-5' };
  const response = await f.request('/jellyfin/Videos/movie/stream.mp4', { headers });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-5/8'); assert.equal(await response.text(), '2345');
  const head = await f.request('/jellyfin/Videos/movie/stream.mp4', { method: 'HEAD', headers });
  assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '4'); assert.equal(await head.text(), '');
  f.state.denied = true;
  assert.equal((await f.request('/jellyfin/Videos/movie/stream.mp4', { headers })).status, 403);
  assert.equal((await f.request('/jellyfin/Items/movie/Images/Primary', { headers })).status, 403);
});

test('HLS rewrites segment, map and key URI, removes tokens and rejects external destinations', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const headers = { Cookie: session.cookie };
  const response = await f.request('/jellyfin/Videos/movie/master.m3u8', { headers });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /URI="\/jellyfin\/Videos\/movie\/init.mp4"/);
  assert.match(text, /URI="\/jellyfin\/Videos\/movie\/key"/);
  assert.match(text, /\/jellyfin\/Videos\/movie\/child\/seg.ts/); assert.ok(!text.includes('TOP_SECRET_TOKEN'));
  assert.equal((await f.request('/jellyfin/Videos/movie/evil.m3u8', { headers })).status, 502);
  assert.equal((await f.request('/jellyfin/Videos/movie/redirect.mp4', { headers })).status, 502);
  assert.throws(() => rewritePlaylist('#EXTM3U\n#EXT-X-KEY:URI="https://evil.example/key"', '/Videos/movie/a.m3u8', f.config));
});

test('path attacks, process control, setup and filesystem APIs cannot be proxied', async (t) => {
  const f = await fixture(t); const session = await f.login();
  for (const path of ['/jellyfin/Startup/Complete', '/jellyfin/Environment/DirectoryContents', '/jellyfin/System/Shutdown', '/jellyfin/Plugins', '/jellyfin/Items/movie/File']) {
    assert.equal((await f.request(path, { headers: { Cookie: session.cookie } })).status, 403, path);
  }
  for (const path of ['/jellyfin/%252e%252e/healthz', '/jellyfin/Videos%5cmovie/stream.mp4', '/jellyfin/https:%2f%2fevil.example', '//evil.example/path']) {
    const result = await new Promise((resolve, reject) => {
      const req = http.get(f.base + path, { headers: { Cookie: session.cookie } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    });
    assert.equal(result, 400, path);
  }
});

test('admin routes revalidate current upstream policy instead of cached privileges', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const headers = authHeaders(session, f.config);
  assert.equal((await f.request('/jellyfin/Users', { headers })).status, 200);
  assert.equal((await f.request('/api/admin/status', { headers })).status, 200);
  f.state.admin = false;
  assert.equal((await f.request('/jellyfin/Users', { headers })).status, 403);
  assert.equal((await f.request('/jellyfin/Library/Refresh', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await f.request('/api/admin/torrents', { headers })).status, 403);
  assert.equal((await f.request('/api/admin/torrents', { method: 'POST', headers, body: '{"url":"magnet:?xt=urn:btih:0123456789012345678901234567890123456789"}' })).status, 403);
});

test('admin torrent status reports safe connection diagnosis without secrets', async (t) => {
  const f = await fixture(t, {}, { torrentClient: { configured: true, health: async () => { throw new HttpError(502, 'No se pudo autenticar con qBittorrent; revisa las credenciales de servicio.'); } } });
  const session = await f.login(); const headers = authHeaders(session, f.config);
  const result = await (await f.request('/api/admin/status', { headers })).json();
  assert.deepEqual(result.torrent, { configured: true, available: false, message: 'No se pudo autenticar con qBittorrent; revisa las credenciales de servicio.' });
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.equal(JSON.stringify(result).includes('TOP_SECRET_TOKEN'), false);
});

test('torrent input rejects remote URL and malicious metadata, strips untrusted seed/peer URLs', () => {
  assert.throws(() => torrentInput({ url: 'https://127.0.0.1/private.torrent' }), /remote URLs/);
  assert.throws(() => torrentInput({ url: 'magnet:?xt=urn:btih:wrong' }), /Invalid BitTorrent/);
  const safe = torrentInput({ url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789&xs=http://127.0.0.1/private&tr=http://localhost/tracker&x.pe=127.0.0.1:80' });
  assert.ok(!safe.magnet.includes('127.0.0.1')); assert.ok(!safe.magnet.includes('localhost'));
  const metadata = Buffer.from('d8:announce21:http://localhost/evil4:infod6:lengthi8e4:name5:a.mp4ee');
  assert.equal(torrentInput({ torrentBase64: metadata.toString('base64'), filename: '../evil.torrent' }).data.toString(), 'd4:infod6:lengthi8e4:name5:a.mp4ee');
  assert.throws(() => torrentInput({ torrentBase64: Buffer.from('d4:infoINVALIDe').toString('base64') }), /Invalid torrent/);
});

test('configuration rejects public upstream endpoints and credentials in URLs', () => {
  assert.throws(() => privateEndpoint('https://example.com', 'test'));
  assert.throws(() => privateEndpoint('http://169.254.169.254', 'test'));
  assert.throws(() => privateEndpoint('http://user:pass@localhost', 'test'));
  assert.throws(() => privateEndpoint('http://127.0.0.1/path', 'test'));
  assert.equal(privateEndpoint('http://jellyfin:8096', 'test'), 'http://jellyfin:8096');
  assert.equal(privateEndpoint('http://[::1]:8096', 'test'), 'http://[::1]:8096');
});

test('public origin requires HTTPS except loopback, Unicode comparisons do not throw', () => {
  for (const origin of ['http://jrplex.example', 'http://192.168.1.2:8787', 'http://10.0.0.2:8787']) assert.throws(() => loadConfig({ PUBLIC_URL: origin }), /HTTPS/);
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://jrplex.example']) assert.equal(loadConfig({ PUBLIC_URL: origin }).publicUrl, origin);
  assert.equal(equal('é', 'a'), false); assert.equal(equal('é', 'é'), true); assert.equal(equal(undefined, 'a'), false);
  const config = loadConfig({});
  assert.deepEqual(sanitizeJson({ OpenToken: 'hidden', Password_PBKDF2: 'hidden', Name: 'safe' }, config), { Name: 'safe' });
});

test('media paths are admin-only while declaration filenames retain a non-playable extension hint', async (t) => {
  const admin = await fixture(t); const adminSession = await admin.login();
  const adminList = await admin.request('/jellyfin/Items?Fields=Path', { headers: { Cookie: adminSession.cookie } });
  const adminItem = (await adminList.json()).Items[0];
  assert.equal(adminItem.Path, '/private/media/file.mp4');
  const adminInfo = await admin.request('/jellyfin/Items/movie/PlaybackInfo', { method: 'POST', headers: authHeaders(adminSession, admin.config), body: '{}' });
  assert.equal((await adminInfo.json()).MediaSources[0].Path, '/private/media');

  const regular = await fixture(t); regular.state.admin = false; const regularSession = await regular.login();
  const regularList = await regular.request('/jellyfin/Items?Fields=Path', { headers: { Cookie: regularSession.cookie } });
  const regularItem = (await regularList.json()).Items[0];
  assert.equal(regularItem.Path, undefined);
  assert.equal(regularItem.JRPlexMediaExtension, '.mp4');
  const regularInfo = await regular.request('/jellyfin/Items/movie/PlaybackInfo', { method: 'POST', headers: authHeaders(regularSession, regular.config), body: '{}' });
  assert.equal((await regularInfo.json()).MediaSources[0].Path, undefined);
});

test('admin diagnostics preserve .d.ts as a compound non-media extension without exposing paths to regular users', () => {
  const config = loadConfig({});
  const item = { Name: 'Abs de Pan', Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: '/media/cloud/node_modules/math-intrinsics/abs.d.ts', MediaStreams: [] };
  const safe = sanitizeJson(item, config);
  assert.equal(safe.Path, undefined);
  assert.equal(safe.JRPlexMediaExtension, '.d.ts');
  const admin = sanitizeJson(item, config, '/', true);
  assert.equal(admin.Path, item.Path);
  assert.equal(admin.JRPlexMediaExtension, '.d.ts');
});

test('admin cannot create users or replace passwords shorter than sixteen characters', async (t) => {
  const f = await fixture(t); const session = await f.login(); const headers = authHeaders(session, f.config);
  for (const Password of ['', 'short', '123456789012345']) {
    assert.equal((await f.request('/jellyfin/Users/New', { method: 'POST', headers, body: JSON.stringify({ Name: 'Bob', Password }) })).status, 400);
  }
  assert.equal(f.state.requests.filter((request) => request.path === '/Users/New').length, 0);
  assert.equal((await f.request('/jellyfin/Users/New', { method: 'POST', headers, body: JSON.stringify({ Name: 'Bob', Password: 'a strong 16+ passphrase' }) })).status, 200);
  assert.equal((await f.request('/jellyfin/Users/bob/Password', { method: 'POST', headers, body: '{"NewPw":"short","ResetPassword":true}' })).status, 400);
});

test('own password change requires current password, CSRF and strong replacement then revokes all local sessions', async (t) => {
  const f = await fixture(t); f.state.admin = false;
  const first = await f.login(); const second = await f.login();
  const headers = authHeaders(first, f.config);
  const change = (payload, requestHeaders = headers) => f.request('/api/password', { method: 'POST', headers: requestHeaders, body: JSON.stringify(payload) });
  assert.equal((await change({ currentPassword: 'valid-password', newPassword: 'short' })).status, 400);
  assert.equal((await change({ currentPassword: '', newPassword: 'A sufficiently long passphrase' })).status, 400);
  assert.equal((await change({ currentPassword: 'valid-password', newPassword: 'A sufficiently long passphrase' }, { ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await change({ currentPassword: 'wrong', newPassword: 'A sufficiently long passphrase' })).status, 400);
  assert.equal((await f.request('/api/session', { headers: { Cookie: first.cookie } })).status, 200);
  const response = await change({ currentPassword: 'valid-password', newPassword: 'A sufficiently long passphrase' });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  for (const cookie of [first.cookie, second.cookie]) assert.equal((await f.request('/api/session', { headers: { Cookie: cookie } })).status, 401);
  const forwarded = f.state.requests.filter((request) => request.path === '/Users/Password').at(-1);
  assert.equal(forwarded.query.get('userId'), 'alice');
  assert.deepEqual(JSON.parse(forwarded.body), { CurrentPw: 'valid-password', NewPw: 'A sufficiently long passphrase' });
  assert.equal(f.state.logout, 1);
});

test('failed account attempts do not block another account behind one proxy', async (t) => {
  const f = await fixture(t);
  const failure = () => f.request('/api/login', { method: 'POST', headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json' }, body: '{"username":"bob","password":"bad"}' });
  for (let i = 0; i < 10; i++) assert.equal((await failure()).status, 401);
  assert.equal((await failure()).status, 429);
  const alice = await f.login(); assert.equal(alice.user.Id, 'alice');
  assert.equal((await failure()).status, 429, 'success for Alice must not clear Bob bucket');
});

test('trusted exact proxy IP honors X-Real-IP; untrusted spoofing cannot bypass limits', async (t) => {
  const f = await fixture(t, { trustedProxyIps: ['127.0.0.1'] });
  const request = (ip, password = 'bad') => f.request('/api/login', { method: 'POST', headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ username: 'alice', password }) });
  for (let i = 0; i < 10; i++) assert.equal((await request('198.51.100.1')).status, 401);
  assert.equal((await request('198.51.100.1')).status, 429);
  assert.equal((await request('198.51.100.2', 'valid-password')).status, 200);

  const untrusted = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const response = await untrusted.request('/api/login', { method: 'POST', headers: { Origin: untrusted.config.publicUrl, 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${i + 1}`, 'X-Forwarded-For': `203.0.113.${i + 1}` }, body: '{"username":"alice","password":"bad"}' });
    assert.equal(response.status, 401);
  }
  assert.equal((await untrusted.request('/api/login', { method: 'POST', headers: { Origin: untrusted.config.publicUrl, 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.99', 'X-Forwarded-For': '203.0.113.99' }, body: '{"username":"alice","password":"bad"}' })).status, 429);
  assert.deepEqual(loadConfig({ TRUSTED_PROXY_IPS: '::ffff:127.0.0.1, ::1' }).trustedProxyIps, ['127.0.0.1', '::1']);
  assert.throws(() => loadConfig({ TRUSTED_PROXY_IPS: '10.0.0.0/8' }), /exact IP/);
});


test('torrent status is admin-only and preserves actionable errors without exposing the torrent path', async (t) => {
  const id = 'a'.repeat(24); const calls = [];
  const torrentClient = { status: async (value) => { calls.push(value); return { peers: 0, downloadSpeed: 0, progress: 0, error: 'No llegaron piezas verificadas.' }; } };
  const f = await fixture(t, {}, { torrentClient });
  assert.equal((await f.request(`/api/admin/torrents/${id}/status`)).status, 401);
  const session = await f.login();
  const response = await f.request(`/api/admin/torrents/${id}/status`, { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).error, 'No llegaron piezas verificadas.');
  f.state.admin = false;
  assert.equal((await f.request(`/api/admin/torrents/${id}/status`, { headers: { Cookie: session.cookie } })).status, 403);
  assert.deepEqual(calls, [id]);
});


test('existing library mapping replaces the root with the chosen folder while keeping its identity', async (t) => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [
    { ItemId: 'drive', Name: 'Drive movies', Locations: ['/media/cloud'], LibraryOptions: { PathInfos: [{ Path: '/media/cloud' }] } },
    { ItemId: 'photos', Name: 'Photos', Locations: ['/media/cloud/Photos'], LibraryOptions: { EnablePhotos: true } },
  ];
  const save = input => f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify(input) });
  const response = await save({ path: '/media/cloud/Videos', previousPaths: ['/media/cloud'] });
  assert.equal(response.status, 200);
  assert.deepEqual(f.state.libraries[0].Locations, ['/media/cloud/Videos']);
  assert.equal(f.state.libraries[0].ItemId, 'drive');
  assert.ok(f.state.requests.some(r => r.path === '/Library/Refresh'), 'validate library structure so new physical folder references are indexed');
  assert.equal((await save({ path: '/media/cloud/Other', previousPaths: ['/media/cloud'] })).status, 409, 'stale clients cannot overwrite a new mapping');
  assert.equal((await save({ path: '/etc', previousPaths: ['/media/cloud/Videos'] })).status, 400);
  assert.equal((await save({ path: '/media/cloud/../local', previousPaths: ['/media/cloud/Videos'] })).status, 400);
  assert.equal(f.state.requests.some(r => r.path === '/Items/drive' && r.method === 'DELETE'), false, 'no library or media deletion');
});

test('existing library mapping normalizes duplicate Jellyfin paths before replacing the root', async (t) => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [
    { ItemId: 'drive', Name: 'Drive movies', Locations: ['/media/cloud', '/media/cloud'], LibraryOptions: { EnablePhotos: true, PathInfos: [{ Path: '/media/cloud' }] } },
    { ItemId: 'photos', Name: 'Photos', Locations: ['/media/cloud/Photos'], LibraryOptions: { EnablePhotos: true } },
  ];
  const response = await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ path: '/media/cloud/Videos', previousPaths: ['/media/cloud', '/media/cloud'], enablePhotos: false }) });
  assert.equal(response.status, 200);
  assert.deepEqual(f.state.libraries[0].Locations, ['/media/cloud/Videos']);
  assert.equal(f.state.libraries[0].LibraryOptions.EnablePhotos, false);
});

test('mapping rejects a new library path nested inside another library', async (t) => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [
    { ItemId: 'photos', Name: 'Photos', Locations: ['/media/cloud/Photos'] },
    { ItemId: 'drive', Name: 'Drive', Locations: ['/media/cloud/Videos'] },
  ];
  const response = await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ path: '/media/cloud/Photos/Family', previousPaths: ['/media/cloud/Videos'] }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /se superpone con otra biblioteca/);
  assert.deepEqual(f.state.libraries[1].Locations, ['/media/cloud/Videos']);
  assert.equal(f.state.requests.some(r => r.path === '/Library/VirtualFolders/Paths' && r.method !== 'GET'), false);
});

test('mapping failure restores the previous path and denies viewer or missing-CSRF changes', async (t) => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [{ ItemId: 'drive', Name: 'Drive', Locations: ['/media/cloud'] }];
  f.state.failRemovePath = true;
  const input = { path: '/media/cloud/Movies', previousPaths: ['/media/cloud'] };
  const response = await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify(input) });
  assert.equal(response.status, 502);
  assert.deepEqual(f.state.libraries[0].Locations, ['/media/cloud']);
  assert.equal((await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  f.state.admin = false;
  assert.equal((await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify(input) })).status, 403);
});

test('remapping an existing photo Drive library enables Jellyfin photo indexing before the scan', async t => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [{ ItemId: 'photos', Name: 'Fotos Drive', Locations: ['/media/cloud'], LibraryOptions: { EnablePhotos: false, PathInfos: [{ Path: '/media/cloud' }] } }];
  const response = await f.request('/api/admin/libraries/photos/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ path: '/media/cloud/Photos', previousPaths: ['/media/cloud'], enablePhotos: true }) });
  assert.equal(response.status, 200); assert.equal(f.state.libraries[0].LibraryOptions.EnablePhotos, true);
  assert.deepEqual(f.state.libraries[0].Locations, ['/media/cloud/Photos']);
  const optionsCall = f.state.requests.find(item => item.path === '/Library/VirtualFolders/LibraryOptions');
  assert.equal(JSON.parse(optionsCall.body).LibraryOptions.EnablePhotos, true);
  assert.ok(f.state.requests.some(item => item.path === '/Library/Refresh'));
});

test('remapping can disable photo indexing on a general library', async t => {
  const f = await fixture(t); const session = await f.login();
  f.state.libraries = [{ ItemId: 'drive', Name: 'Drive', Locations: ['/media/cloud'], LibraryOptions: { EnablePhotos: true, PathInfos: [{ Path: '/media/cloud' }] } }];
  const response = await f.request('/api/admin/libraries/drive/path', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ path: '/media/cloud', previousPaths: ['/media/cloud'], enablePhotos: false }) });
  assert.equal(response.status, 200);
  assert.equal(f.state.libraries[0].LibraryOptions.EnablePhotos, false);
  const optionsCall = f.state.requests.find(item => item.path === '/Library/VirtualFolders/LibraryOptions');
  assert.equal(JSON.parse(optionsCall.body).LibraryOptions.EnablePhotos, false);
  assert.ok(f.state.requests.some(item => item.path === '/Library/Refresh'));
});


test('photograph mapping uses the collection type accepted by Jellyfin 12 and enables photo indexing', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const response = await f.request('/jellyfin/Library/VirtualFolders?name=Photos&collectionType=photos&refreshLibrary=true', { method: 'POST', headers: authHeaders(session, f.config), body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: '/media/cloud/Photos' }] } }) });
  assert.equal(response.status, 200);
  const upstream = f.state.requests.find(r => r.path === '/Library/VirtualFolders' && r.method === 'POST');
  assert.equal(upstream.query.get('collectionType'), 'homevideos');
  assert.equal(JSON.parse(upstream.body).LibraryOptions.EnablePhotos, true);
});


test('resume uses Jellyfin 12 UserItems route and forces the authenticated user', async (t) => {
  const f = await fixture(t); const session = await f.login();
  const response = await f.request('/jellyfin/UserItems/Resume?userId=someone-else', { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 200);
  const upstream = f.state.requests.find(r => r.path === '/UserItems/Resume');
  assert.equal(upstream.query.get('userId'), 'alice');
});
