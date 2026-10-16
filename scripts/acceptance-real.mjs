import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { args, project, jsonRequest } from './lib.mjs';

// This runner performs real, authorized mutations only on its marked test account.
// Report values are fixed labels, status codes, counts, hashes, and item IDs.
const report = { timestamp: new Date().toISOString(), engineVersion: null, source: {}, items: {}, checks: [] };
const sessions = [];
let opt; let admin; let viewerId; let viewerPolicy; let viewerDisabled = false;
let out; let gateway; let engine; let origin; let viewerPassword;
const viewerName = 'jrplex-verificacion';
const secretDirectory = path.join(project, 'runtime', 'secrets');
const passwordFile = path.join(secretDirectory, 'test-viewer-password');
const markerFile = path.join(secretDirectory, 'test-viewer-owner.json');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const idOk = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

class CheckError extends Error {
  constructor(label, status) { super(label); this.status = status; }
}
function check(id, name, ok, details = {}) {
  report.checks.push({ id, name, status: ok ? 'APROBADA' : 'FALLIDA', details });
  console.log(`${ok ? 'APROBADA' : 'FALLIDA'}: ${id} ${name}`);
  return ok;
}
function pending(id, name) { report.checks.push({ id, name, status: 'PENDIENTE', details: {} }); }
function expect(ok, label, status) { if (!ok) throw new CheckError(label, status); }
function endpoint(value) {
  const url = new URL(value);
  expect(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Loopback endpoint required');
  return url;
}
async function privateFile(filename) {
  const metadata = await lstat(filename);
  expect(metadata.isFile() && !metadata.isSymbolicLink(), 'Private regular file required');
  if (process.platform !== 'win32') expect((metadata.mode & 0o077) === 0 && (!process.getuid || metadata.uid === process.getuid()), 'Private file ownership and permissions required');
  const value = (await readFile(filename, 'utf8')).trim();
  expect(value.length >= 16 && value.length <= 1024 && !/[\r\n]/.test(value), 'Private password format invalid');
  return value;
}
function cleanData(value) {
  if (Array.isArray(value)) return value.every(cleanData);
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => !/^(?:access.?token|open.?token|api.?key|password(?:_pbkdf2)?|pw|authorization|credential|credentials|path|substitutionpath)$/i.test(key) && cleanData(item));
  return typeof value !== 'string' || !/[?&](?:api_?key|access_?token|token|authorization)=(?!\[redacted\])[^&#\s]+/i.test(value);
}
async function request(route, { session, method = 'GET', body, headers = {}, csrf = true, requestOrigin = origin, timeout = 60000 } = {}) {
  const target = new URL(route, gateway);
  expect(target.origin === gateway.origin && route.startsWith('/') && !route.startsWith('//'), 'Gateway route rejected');
  return fetch(target, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { ...(session ? { Cookie: session.cookie } : {}), ...(!['GET', 'HEAD'].includes(method) ? { Origin: requestOrigin } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function discard(response) { await response.body?.cancel(); }
async function json(route, options = {}) {
  const requestLabel = `${options.method || 'GET'} ${new URL(route, gateway).pathname}`;
  const response = await request(route, options);
  if (!response.ok) { await discard(response); throw new CheckError(`Gateway JSON request failed: ${requestLabel}`, response.status); }
  if (response.status === 204) { await discard(response); return null; }
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new CheckError(`Gateway JSON response invalid: ${requestLabel}`, response.status); }
}
async function login(name, password) {
  const response = await request('/api/login', { method: 'POST', body: { username: name, password } });
  if (response.status !== 200) { await discard(response); throw new CheckError('Gateway login failed', response.status); }
  const header = response.headers.get('set-cookie') || '';
  const data = await response.json();
  expect(header && data.csrfToken && idOk(data.user?.Id) && cleanData(data), 'Gateway login response invalid');
  const session = { cookie: header.split(';')[0], csrf: data.csrfToken, user: data.user, cookieHeader: header };
  sessions.push(session);
  return session;
}
async function statusCheck(id, name, route, options, accepted) {
  const response = await request(route, options);
  check(id, name, accepted.includes(response.status), { http: response.status });
  await discard(response);
}
async function saveMarker(value) {
  await writeFile(`${markerFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${markerFile}.tmp`, markerFile);
  if (process.platform !== 'win32') await chmod(markerFile, 0o600);
}
async function prepareViewer(users, localFolder) {
  const existing = users.find(user => user.Name === viewerName);
  let originalPolicy = existing?.Policy;
  let marker;
  try {
    const metadata = await lstat(markerFile);
    expect(metadata.isFile() && !metadata.isSymbolicLink() && (process.platform === 'win32' || (metadata.mode & 0o077) === 0), 'Test account marker must be private');
    marker = JSON.parse(await readFile(markerFile, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    expect(marker?.name === viewerName && marker.userId === existing.Id, 'Existing test-name account is not owned by this runner');
    viewerPassword = await privateFile(passwordFile);
    // Ownership proof is required before changing any existing policy.
    const proof = await login(viewerName, viewerPassword);
    expect(proof.user.Id === existing.Id, 'Test-account ownership proof failed');
    viewerId = existing.Id;
  } else {
    expect(!marker?.userId, 'Marked test user disappeared; manual review required');
    try { viewerPassword = await privateFile(passwordFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      viewerPassword = randomBytes(36).toString('base64url');
      await writeFile(passwordFile, viewerPassword, { flag: 'wx', mode: 0o600 });
    }
    const created = await json('/jellyfin/Users/New', { session: admin, method: 'POST', body: { Name: viewerName, Password: viewerPassword } });
    expect(idOk(created?.Id), 'Test account creation did not return a valid ID');
    viewerId = created.Id;
    originalPolicy = created.Policy;
    await saveMarker({ name: viewerName, userId: viewerId, createdAt: new Date().toISOString(), purpose: 'JRPlex real acceptance tests' });
  }
  // UserPolicy is a complete replacement, not a PATCH. Jellyfin v12.2 requires
  // nonempty AuthenticationProviderId and PasswordResetProviderId; retain the
  // server-issued provider IDs and all other policy fields before restricting.
  // Source: jellyfin/jellyfin tag v12.2, MediaBrowser.Model/Users/UserPolicy.cs.
  if (!originalPolicy || typeof originalPolicy !== 'object') {
    const refreshedUsers = await json('/jellyfin/Users', { session: admin });
    originalPolicy = refreshedUsers.find(user => user.Id === viewerId)?.Policy;
  }
  expect(originalPolicy && ['AuthenticationProviderId', 'PasswordResetProviderId'].every(key => typeof originalPolicy[key] === 'string' && originalPolicy[key].trim()), 'Server-issued policy provider IDs required before updating owned viewer');
  viewerPolicy = {
    ...originalPolicy,
    IsAdministrator: false, IsHidden: true, IsDisabled: false,
    EnableMediaPlayback: true, EnableAudioPlaybackTranscoding: true, EnableVideoPlaybackTranscoding: true,
    EnablePlaybackRemuxing: true, EnableContentDeletion: false, EnableContentDeletionFromFolders: [], EnableContentDownloading: false,
    EnableAllFolders: false, EnabledFolders: [localFolder.ItemId],
    EnableAllDevices: true, EnableRemoteAccess: true, EnableSharedDeviceControl: false,
    EnableLiveTvAccess: false, EnableLiveTvManagement: false,
    EnableRemoteControlOfOtherUsers: false, EnablePublicSharing: false,
    EnableAllChannels: false, EnabledChannels: [],
    EnableCollectionManagement: false, EnableSubtitleManagement: false, EnableLyricManagement: false,
  };
  await json(`/jellyfin/Users/${viewerId}/Policy`, { session: admin, method: 'POST', body: viewerPolicy });
  const viewer = await login(viewerName, viewerPassword);
  expect(viewer.user.Id === viewerId && !viewer.user.Policy?.IsAdministrator, 'Restricted viewer policy invalid');
  check('R12', 'Owned test viewer created/reused and restricted to Local', true);
  return viewer;
}
async function mediaItems(folderId, session) {
  const data = await json(`/jellyfin/Items?ParentId=${encodeURIComponent(folderId)}&Recursive=true&IncludeItemTypes=Movie,Video,Episode&Limit=100&Fields=MediaSources,MediaStreams`, { session });
  expect(Array.isArray(data?.Items) && cleanData(data), 'Media catalogue response invalid');
  return data.Items.filter(item => idOk(item.Id) && !item.IsFolder);
}
function safeMediaUrl(value, parent = '/jellyfin/') {
  expect(typeof value === 'string' && value.length < 16384 && !/[?&](?:api_?key|access_?token|token|authorization)=/i.test(value), 'Unsafe credential-bearing media URL');
  const url = new URL(value, new URL(parent, gateway));
  expect(url.origin === gateway.origin && url.pathname.startsWith('/jellyfin/') && !url.username && !url.password && !url.hash && !/[\\\r\n]/.test(value), 'External media URL rejected');
  return `${url.pathname}${url.search}`;
}
async function hlsTest(item) {
  const profile = {
    Name: 'JRPlex Acceptance HLS', MaxStreamingBitrate: 1000000, MaxStaticBitrate: 1000000,
    DirectPlayProfiles: [], CodecProfiles: [], SubtitleProfiles: [],
    TranscodingProfiles: [{ Container: 'mp4', Type: 'Video', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2', MinSegments: 1, SegmentLength: 2, BreakOnNonKeyFrames: false }],
  };
  const info = await json(`/jellyfin/Items/${item.Id}/PlaybackInfo`, { session: admin, method: 'POST', body: { UserId: admin.user.Id, IsPlayback: true, AutoOpenLiveStream: false, StartTimeTicks: 0, MaxStreamingBitrate: 1000000, EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true, DeviceProfile: profile } });
  expect(cleanData(info), 'Playback information contains private fields');
  const source = info.MediaSources?.find(candidate => candidate.TranscodingUrl && !candidate.RequiresOpening);
  expect(source && idOk(source.Id), 'Real transcoding URL unavailable');
  check('R20', 'Real PlaybackInfo produces sanitized H264/AAC fMP4 HLS', true);
  const playing = { ItemId: item.Id, MediaSourceId: source.Id, PlaySessionId: info.PlaySessionId, PositionTicks: 0, CanSeek: true, IsPaused: false, PlayMethod: 'Transcode' };
  let started = false;
  try {
    await json('/jellyfin/Sessions/Playing', { session: admin, method: 'POST', body: playing }); started = true;
    let playlistRoute = safeMediaUrl(source.TranscodingUrl);
    let playlist;
    for (let depth = 0; depth < 4; depth++) {
      const response = await request(playlistRoute, { session: admin, timeout: 60000 });
      expect(response.status === 200, 'HLS playlist request failed', response.status);
      playlist = await response.text();
      expect(playlist.startsWith('#EXTM3U') && !/[?&](?:api_?key|access_?token|token|authorization)=/i.test(playlist), 'HLS playlist invalid or contains credentials');
      const mediaLines = playlist.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      const urls = mediaLines.map(value => safeMediaUrl(value, playlistRoute));
      for (const match of playlist.matchAll(/URI="([^"]+)"/g)) safeMediaUrl(match[1], playlistRoute);
      if (/^#EXT-X-STREAM-INF:/m.test(playlist)) { expect(urls.length > 0, 'HLS master has no variants'); playlistRoute = urls[0]; continue; }
      check('R21', 'Master/media HLS playlists retrieved without tokens', true, { playlists: depth + 1 });
      const map = playlist.match(/#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/);
      expect(map && urls.length, 'fMP4 HLS init/segment references absent');
      for (const [id, name, route] of [['R22', 'Real ffmpeg HLS initialization bytes', safeMediaUrl(map[1], playlistRoute)], ['R23', 'Real ffmpeg HLS media segment bytes', urls[0]]]) {
        const binary = await request(route, { session: admin, timeout: 60000 });
        expect(binary.status === 200 || binary.status === 206, 'HLS binary request failed', binary.status);
        const bytes = (await binary.arrayBuffer()).byteLength;
        check(id, name, bytes > 0, { bytes, http: binary.status });
      }
      await json('/jellyfin/Sessions/Playing/Progress', { session: admin, method: 'POST', body: { ...playing, PositionTicks: 10000000, EventName: 'TimeUpdate' } });
      check('R24', 'Playing and progress events accepted by real engine', true);
      return;
    }
    throw new CheckError('HLS media playlist not reached');
  } finally {
    if (started) {
      const response = await request('/jellyfin/Sessions/Playing/Stopped', { session: admin, method: 'POST', body: { ...playing, PositionTicks: 10000000 } });
      check('R25', 'Stopped playback event accepted', response.ok, { http: response.status });
      await discard(response);
    }
  }
}
async function passwordTest(viewer) {
  const second = await login(viewerName, viewerPassword);
  const replacement = randomBytes(36).toString('base64url');
  // Persist recovery material BEFORE changing the account; no password goes to logs or reports.
  const nextFile = `${passwordFile}.next`;
  await writeFile(nextFile, replacement, { flag: 'wx', mode: 0o600 });
  const response = await request('/api/password', { session: viewer, method: 'POST', body: { currentPassword: viewerPassword, newPassword: replacement } });
  expect(response.ok, 'Test-account password change failed; recovery file retained', response.status);
  await discard(response);
  await rename(nextFile, passwordFile);
  viewerPassword = replacement;
  for (const [index, previous] of [viewer, second].entries()) await statusCheck(`R28-${index + 1}`, 'Password change revokes previous gateway session', '/api/session', { session: previous }, [401]);
  const fresh = await login(viewerName, viewerPassword);
  expect(fresh.user.Id === viewerId, 'Login after password replacement failed');
  check('R29', 'Password changed and new password authenticates owned test account', true);
}

try {
  opt = args(['url', 'origin', 'jellyfin-url', 'admin-password-file', 'out', 'password-test', 'help'], ['password-test', 'help']);
  if (opt.help) {
    console.log('node scripts/acceptance-real.mjs --url http://127.0.0.1:8787 --origin https://jrplexps.duckdns.org --jellyfin-url http://127.0.0.1:8096 --admin-password-file /private/file --out /private/report.json [--password-test]\nMutates only its marked test viewer; requires synthetic media in Local and Descargas. Credentials never enter output.');
    process.exit(0);
  }
  expect(opt.url && opt.origin && opt['jellyfin-url'] && opt['admin-password-file'] && opt.out, 'Required argument absent');
  gateway = endpoint(opt.url); engine = endpoint(opt['jellyfin-url']);
  const publicOrigin = new URL(opt.origin);
  expect(publicOrigin.origin === opt.origin && publicOrigin.protocol === 'https:', 'HTTPS public origin required');
  origin = publicOrigin.origin; out = path.resolve(opt.out);
  expect(![passwordFile, markerFile, path.resolve(opt['admin-password-file'])].includes(out), 'Report cannot overwrite credential material');
  try { expect(!(await lstat(out)).isSymbolicLink(), 'Report destination must not be a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(secretDirectory, 0o700);
  for (const filename of ['server.mjs', 'public/app.js', 'lib/security.mjs', 'lib/torrents.mjs', 'compose.yaml', 'scripts/acceptance-real.mjs']) report.source[filename] = createHash('sha256').update(await readFile(path.join(project, filename))).digest('hex');
  const engineInfo = await jsonRequest(engine, '/System/Info/Public');
  report.engineVersion = /^[\w.-]{1,40}$/.test(engineInfo.Version || '') ? engineInfo.Version : null;
  check('R00', 'Real media engine initialized before publication', engineInfo.StartupWizardCompleted === true && Boolean(report.engineVersion), { engineVersion: report.engineVersion });
  await statusCheck('R01', 'Gateway health', '/healthz', {}, [200]);
  await statusCheck('R02', 'Anonymous catalogue denied', '/jellyfin/Items', {}, [401]);
  await statusCheck('R03', 'Anonymous media stream denied', '/jellyfin/Videos/00000000000000000000000000000000/stream.mp4?Static=true', {}, [401]);
  await statusCheck('R04', 'Invalid credentials denied', '/api/login', { method: 'POST', body: { username: `jrplex-invalid-${randomBytes(5).toString('hex')}`, password: randomBytes(32).toString('base64url') } }, [401]);
  let adminPassword = await privateFile(path.resolve(opt['admin-password-file']));
  admin = await login('jradmin', adminPassword); adminPassword = '';
  check('R05', 'Real administrator login returns opaque session', admin.user.Policy?.IsAdministrator === true);
  check('R06', 'Cookie is HttpOnly, SameSite Strict and Secure', /HttpOnly/i.test(admin.cookieHeader) && /SameSite=Strict/i.test(admin.cookieHeader) && /; Secure/i.test(admin.cookieHeader) && /^__Host-/.test(admin.cookie));
  await statusCheck('R07', 'Mutation without CSRF rejected', '/api/logout', { session: admin, method: 'POST', body: {}, csrf: false }, [403]);
  await statusCheck('R08', 'Mutation from foreign origin rejected', '/api/logout', { session: admin, method: 'POST', body: {}, requestOrigin: 'https://jrplex-attacker.invalid' }, [403]);
  const users = await json('/jellyfin/Users', { session: admin });
  const libraries = await json('/jellyfin/Library/VirtualFolders', { session: admin });
  expect(Array.isArray(users) && Array.isArray(libraries), 'Admin API did not return lists');
  check('R09', 'Real admin users and library APIs work without private fields', cleanData(users) && cleanData(libraries), { users: users.length, libraries: libraries.length });
  const local = libraries.find(folder => folder.Name === 'Local');
  const downloads = libraries.find(folder => folder.Name === 'Descargas');
  expect(idOk(local?.ItemId) && idOk(downloads?.ItemId) && local.ItemId !== downloads.ItemId, 'Distinct Local and Descargas libraries required');
  await json('/jellyfin/Library/Refresh', { session: admin, method: 'POST', body: {} });
  let localItems = []; let downloadItems = [];
  const until = Date.now() + 60000;
  do {
    localItems = await mediaItems(local.ItemId, admin); downloadItems = await mediaItems(downloads.ItemId, admin);
    if (localItems.length && downloadItems.length) break;
    if (Date.now() < until) await pause(2000);
  } while (Date.now() < until);
  expect(localItems.length && downloadItems.length, 'Synthetic media absent after 60-second scan');
  check('R10', 'Both real libraries contain media after refresh', true, { local: localItems.length, downloads: downloadItems.length });
  const item = localItems[0]; const restricted = downloadItems[0];
  report.items = { local: item.Id, restricted: restricted.Id, localLibrary: local.ItemId, downloadsLibrary: downloads.ItemId };
  const catalogue = await json('/jellyfin/Items?Recursive=true&Limit=200&Fields=MediaSources,MediaStreams', { session: admin });
  check('R11', 'Administrator catalogue contains no backend tokens or paths', Array.isArray(catalogue.Items) && cleanData(catalogue), { count: catalogue.Items?.length || 0 });
  const viewer = await prepareViewer(users, local);
  await statusCheck('R13', 'Viewer cannot administer users', '/jellyfin/Users', { session: viewer }, [403]);
  await statusCheck('R14', 'Viewer cannot administer libraries', '/jellyfin/Library/VirtualFolders', { session: viewer }, [403]);
  const visible = await json('/jellyfin/Items?Recursive=true&Limit=1000', { session: viewer });
  const views = await json(`/jellyfin/Users/${viewerId}/Views`, { session: viewer });
  check('R15', 'Viewer sees Local and no Descargas catalogue entries', cleanData(visible) && visible.Items?.some(value => value.Id === item.Id) && !visible.Items?.some(value => downloadItems.some(hidden => hidden.Id === value.Id)) && !views.Items?.some(value => value.Id === downloads.ItemId));
  await statusCheck('R16', 'Denied item inaccessible by direct item ID', `/jellyfin/Items/${restricted.Id}`, { session: viewer }, [403, 404]);
  await statusCheck('R17', 'Denied item stream inaccessible by direct ID', `/jellyfin/Videos/${restricted.Id}/stream.mp4?Static=true`, { session: viewer }, [403, 404]);
  const range = await request(`/jellyfin/Videos/${item.Id}/stream.mp4?Static=true`, { session: admin, headers: { Range: 'bytes=0-1023' } });
  const rangeOk = range.status === 206 && /^bytes 0-1023\/\d+$/.test(range.headers.get('content-range') || '');
  const byteCount = rangeOk ? (await range.arrayBuffer()).byteLength : 0;
  if (!rangeOk) await discard(range);
  check('R18', 'Real video range is exactly 1024 bytes with Content-Range', rangeOk && byteCount === 1024, { http: range.status, bytes: byteCount });
  const head = await request(`/jellyfin/Videos/${item.Id}/stream.mp4?Static=true`, { session: admin, method: 'HEAD', headers: { Range: 'bytes=0-1023' } });
  check('R19', 'HEAD preserves media range headers without a body', head.status === 206 && /^bytes 0-1023\/\d+$/.test(head.headers.get('content-range') || '') && (await head.arrayBuffer()).byteLength === 0, { http: head.status });
  try { await hlsTest(item); } catch (error) { check('R20-HLS', 'Real HLS transcoding integration', false, { reason: error instanceof CheckError ? error.message : 'Network or media request failed', ...(Number.isInteger(error.status) ? { http: error.status } : {}) }); }
  viewerDisabled = true;
  await json(`/jellyfin/Users/${viewerId}/Policy`, { session: admin, method: 'POST', body: { ...viewerPolicy, IsDisabled: true } });
  try { await statusCheck('R26', 'Disabled viewer session immediately rejected', '/api/session', { session: viewer }, [401]); }
  finally { await json(`/jellyfin/Users/${viewerId}/Policy`, { session: admin, method: 'POST', body: viewerPolicy }); viewerDisabled = false; }
  check('R27', 'Owned test viewer re-enabled after revocation test', true);
  const restoredViewer = await login(viewerName, viewerPassword);
  if (opt['password-test']) await passwordTest(restoredViewer);
  else pending('R28', 'Owned test viewer password rotation and two-session revocation');
  const logoutSession = await login(viewerName, viewerPassword);
  await statusCheck('R30', 'Real logout accepted', '/api/logout', { session: logoutSession, method: 'POST', body: {} }, [200, 204]);
  await statusCheck('R31', 'Logout invalidates previous cookie', '/api/session', { session: logoutSession }, [401]);
} catch (error) {
  check('RUN', 'Real acceptance runner completed', false, { reason: error instanceof CheckError ? error.message : 'Filesystem, network, or response failure', ...(Number.isInteger(error.status) ? { http: error.status } : {}) });
} finally {
  if (viewerDisabled && admin && viewerId && viewerPolicy) {
    try { await json(`/jellyfin/Users/${viewerId}/Policy`, { session: admin, method: 'POST', body: viewerPolicy }); check('CLEANUP', 'Disabled test viewer restored in final cleanup', true); }
    catch { check('CLEANUP', 'Disabled test viewer restored in final cleanup', false); }
  }
  for (const session of sessions) {
    try { await discard(await request('/api/logout', { session, method: 'POST', body: {}, timeout: 10000 })); } catch {}
  }
  viewerPassword = '';
  const requiredChecks = [
    ['R00', 'Real initialized engine'], ['R01', 'Gateway health'], ['R02', 'Anonymous catalogue denied'],
    ['R03', 'Anonymous stream denied'], ['R04', 'Invalid credentials denied'], ['R05', 'Administrator login'],
    ['R06', 'Secure cookie attributes'], ['R07', 'CSRF enforcement'], ['R08', 'Origin enforcement'],
    ['R09', 'Real admin APIs'], ['R10', 'Two populated libraries'], ['R11', 'Catalogue secret filtering'],
    ['R12', 'Owned restricted viewer'], ['R13', 'Viewer user-administration denial'], ['R14', 'Viewer library-administration denial'],
    ['R15', 'Viewer catalogue isolation'], ['R16', 'Direct restricted-item denial'], ['R17', 'Direct restricted-stream denial'],
    ['R18', 'Real media byte range'], ['R19', 'Real media HEAD'], ['R20', 'Real transcoding PlaybackInfo'],
    ['R21', 'HLS playlists'], ['R22', 'HLS initialization bytes'], ['R23', 'HLS media segment bytes'],
    ['R24', 'Playing/progress events'], ['R25', 'Stopped event'], ['R26', 'Disabled viewer revocation'],
    ['R27', 'Viewer restoration'], ['R30', 'Logout accepted'], ['R31', 'Logout cookie revocation'],
  ];
  if (opt?.['password-test']) requiredChecks.push(['R28-1', 'First prior session revoked by password rotation'], ['R28-2', 'Second prior session revoked by password rotation'], ['R29', 'New password authenticates']);
  for (const [id, name] of requiredChecks) if (!report.checks.some(value => value.id === id)) pending(id, name);
  for (const [id, name] of [['P-CLOUD', 'Real encrypted cloud mount and cloud playback'], ['P-TORRENT', 'Real completed torrent and downloaded-media playback'], ['P-MAC', 'macOS native deployment and browser playback'], ['P-WINDOWS', 'Windows native deployment and browser playback'], ['P-RESTORE', 'Independent backup restoration'], ['P-PUBLIC', 'External public DNS and trusted TLS reachability'], ['P-BROWSER', 'Visual browser playback, seek, subtitles and quality selection']]) pending(id, name);
  report.finishedAt = new Date().toISOString();
  report.summary = { passed: report.checks.filter(value => value.status === 'APROBADA').length, failed: report.checks.filter(value => value.status === 'FALLIDA').length, pending: report.checks.filter(value => value.status === 'PENDIENTE').length };
  if (out) {
    try { await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); if (process.platform !== 'win32') await chmod(out, 0o600); }
    catch { console.error('FALLIDA: no se pudo guardar el informe privado.'); process.exitCode = 1; }
  }
  console.log(`Real acceptance: ${report.summary.passed} aprobadas, ${report.summary.failed} fallidas, ${report.summary.pending} pendientes. No equivale a aprobación general.`);
  if (report.summary.failed) process.exitCode = 1;
}
