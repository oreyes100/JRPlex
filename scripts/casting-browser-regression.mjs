import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, loadConfig } from '../server.mjs';

const { chromium } = await import(pathToFileURL(process.env.JRP_PLAYWRIGHT_MODULE).href);
const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-casting-'));
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'fixture.key'), '-out', path.join(root, 'fixture.crt'), '-subj', '/CN=127.0.0.1', '-days', '1']);
assert.equal(certificate.status, 0, 'generate a temporary certificate for the isolated HTTPS fixture');
const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path.join(root, 'movie.mp4')]);
assert.equal(generated.status, 0, generated.stderr?.toString());
const segmented = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(root, 'movie.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(root, 'segment%d.m4s'), path.join(root, 'stream.m3u8')]);
assert.equal(segmented.status, 0, segmented.stderr?.toString());
const video = await readFile(path.join(root, 'movie.mp4'));
const streams = [{ Type: 'Video', Codec: 'h264', BitDepth: 8, Level: 40 }];
const source = { Id: 'source', Container: 'mp4', SupportsDirectPlay: true, MediaStreams: streams };
const item = { Id: 'movie', Name: 'Casting fixture', Type: 'Movie', MediaType: 'Video', MediaStreams: streams, MediaSources: [source], RunTimeTicks: 600000000, UserData: {} };
const user = { Id: 'fixture', Name: 'Fixture', Policy: { IsAdministrator: true, EnableMediaPlayback: true } };
const media = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/Users/AuthenticateByName') return json({ AccessToken: 'FIXTURE_PRIVATE_TOKEN', User: user });
  if (url.pathname === '/Users/Me') return json(user);
  if (url.pathname === '/Items' || url.pathname === '/Users/fixture/Items') return json({ Items: [item], TotalRecordCount: 1 });
  if (url.pathname === '/Users/fixture/Views') return json({ Items: [{ Id: 'library', Name: 'Films', CollectionType: 'movies' }] });
  if (url.pathname === '/UserItems/Resume') return json({ Items: [] });
  if (url.pathname === '/Users/fixture/Items/movie' || url.pathname === '/Items/movie') return json(item);
  if (url.pathname === '/Items/movie/PlaybackInfo') { const tv = JSON.parse(raw || '{}').DeviceProfile?.Name === 'JRPlex TV'; return json({ PlaySessionId: 'play_fixture', MediaSources: [tv ? { ...source, SupportsDirectPlay: false, TranscodingUrl: '/videos/movie/stream.m3u8?api_key=FIXTURE_PRIVATE_TOKEN', TranscodingContainer: 'mp4' } : source] }); }
  if (url.pathname.startsWith('/Sessions/')) { res.writeHead(204); return res.end(); }
  const asset = url.pathname.match(/^\/Videos\/movie\/(stream\.m3u8|init\.mp4|segment\d+\.m4s)$/)?.[1];
  if (url.pathname === '/Videos/movie/stream.mp4' || asset) {
    const bytes = asset ? await readFile(path.join(root, asset)) : video;
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/); const start = match ? Number(match[1]) : 0; const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(match ? 206 : 200, { 'content-type': asset?.endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
  }
  return json({});
});
const start = async (server, scheme = 'http') => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `${scheme}://127.0.0.1:${server.address().port}`; };
const upstream = await start(media);
const config = loadConfig({ JELLYFIN_URL: upstream, PUBLIC_URL: 'https://127.0.0.1' });
const app = createApp(config);
const gateway = https.createServer({ key: await readFile(path.join(root, 'fixture.key')), cert: await readFile(path.join(root, 'fixture.crt')) }, app.handler);
const base = await start(gateway, 'https'); config.publicUrl = base;
const sdk = `
window.castTest={mode:'ok',request:null,ended:0};
const callbacks=new Set();
const remote={currentTime:10,playerState:'PLAYING',media:{duration:60},getEstimatedTime(){return this.currentTime},pause(_r,ok){this.playerState='PAUSED';ok()},play(_r,ok){this.playerState='PLAYING';ok()},seek(r,ok){this.currentTime=r.currentTime;ok()}};
const session={getMediaSession:()=>remote,getCastDevice:()=>({friendlyName:'Fixture Chromecast'}),loadMedia:async r=>{window.castTest.request=r;if(window.castTest.mode==='fail')throw Error('load failed');if(window.castTest.mode==='delayed')await new Promise(resolve=>window.castTest.resolveLoad=resolve);remote.currentTime=r.currentTime;remote.playerState='PLAYING'},endSession(){window.castTest.ended++;if(window.castTest.endThrows)throw Error('device disconnected');for(const callback of callbacks)callback({sessionState:'ENDED'})}};
const context={setOptions(options){window.castTest.options=options},requestSession:async()=>{if(window.castTest.mode==='cancel')throw Error('cancel')},getCurrentSession:()=>session,addEventListener(_e,cb){callbacks.add(cb)},removeEventListener(_e,cb){callbacks.delete(cb)}};
window.chrome.cast={isAvailable:true,AutoJoinPolicy:{TAB_AND_ORIGIN_SCOPED:'tab'},media:{DEFAULT_MEDIA_RECEIVER_APP_ID:'CC1AD845',StreamType:{BUFFERED:'BUFFERED'},HlsSegmentFormat:{FMP4:'fmp4'},HlsVideoSegmentFormat:{FMP4:'fmp4'},MediaInfo:class{constructor(contentId,contentType){this.contentId=contentId;this.contentType=contentType}},GenericMediaMetadata:class{},LoadRequest:class{constructor(media){this.media=media}},PlayRequest:class{},PauseRequest:class{},SeekRequest:class{}}};
window.cast={framework:{CastContext:{getInstance:()=>context},CastContextEventType:{SESSION_STATE_CHANGED:'changed'},SessionState:{SESSION_ENDED:'ENDED'}}};
setTimeout(()=>window.__onGCastApiAvailable(true),0);
`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  // Only this generated loopback fixture uses a self-signed certificate.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: true });
  await context.route('https://www.gstatic.com/**', route => route.fulfill({ contentType: 'text/javascript', body: sdk }));
  const sender = await context.newPage(); const errors = []; sender.on('pageerror', error => errors.push(error.message));
  await sender.goto(base + '/app'); await sender.getByLabel('Usuario', { exact: true }).fill('fixture'); await sender.getByLabel('Contraseña', { exact: true }).fill('fixture'); await sender.locator('#login-form button[type=submit]').click();
  await sender.getByRole('button', { name: '▷ Reproducir', exact: true }).first().click();
  await sender.waitForFunction(() => document.getElementById('video').currentTime > 0.2);
  await sender.locator('.cast-panel summary').click();
  const receiver = await context.newPage(); receiver.on('pageerror', error => errors.push(error.message));
  await receiver.addInitScript(() => { const original = HTMLMediaElement.prototype.play; window.allowFixturePlayback = false; HTMLMediaElement.prototype.play = function() { return window.allowFixturePlayback ? original.call(this) : Promise.reject(new DOMException('Fixture autoplay blocked', 'NotAllowedError')); }; });
  await receiver.goto(base + '/tv'); await receiver.waitForFunction(() => /^\d{6}$/.test(document.getElementById('tv-code').textContent));
  const code = await receiver.locator('#tv-code').textContent();
  await sender.getByLabel('Código de la TV').fill(code); await sender.getByRole('button', { name: 'Vincular TV / Fire TV y enviar', exact: true }).click();
  await receiver.getByRole('button', { name: 'Reproducir en esta pantalla', exact: true }).waitFor();
  await sender.waitForFunction(() => document.querySelector('.cast-status').textContent.includes('Pulsa Reproducir en la TV'), null, { timeout: 10000 }).catch(async error => { console.error('Autoplay diagnostic', JSON.stringify({ sender: await sender.locator('.cast-status').textContent(), receiver: await receiver.locator('#tv-status').textContent(), video: await receiver.locator('#tv-video').evaluate(video => ({ readyState: video.readyState, error: video.error?.code, detail: video.dataset.playbackError, paused: video.paused, time: video.currentTime })) })); throw error; });
  assert.equal(await sender.locator('#video').evaluate(element => element.paused), false);
  await receiver.evaluate(() => { window.allowFixturePlayback = true; }); await receiver.getByRole('button', { name: 'Reproducir en esta pantalla', exact: true }).click();
  await receiver.waitForFunction(() => document.getElementById('tv-video').currentTime > 0.3);
  await sender.waitForFunction(() => document.getElementById('video').paused);
  assert.equal(await receiver.locator('#tv-title').textContent(), item.Name);
  await sender.getByRole('button', { name: 'Pausar en TV', exact: true }).click(); await receiver.waitForFunction(() => document.getElementById('tv-video').paused);
  await sender.getByLabel('Posición en la TV').fill('8'); await sender.getByLabel('Posición en la TV').dispatchEvent('change');
  await receiver.waitForFunction(() => document.getElementById('tv-video').currentTime >= 7.8);
  await sender.getByRole('button', { name: 'Continuar en TV', exact: true }).click(); await receiver.waitForFunction(() => !document.getElementById('tv-video').paused);
  await receiver.screenshot({ path: '.gauntlet/casting/receiver.png', fullPage: true });
  await sender.getByRole('button', { name: 'Volver a este dispositivo', exact: true }).click();
  await sender.waitForFunction(() => !document.getElementById('video').paused && document.getElementById('video').currentTime >= 7.8);
  await receiver.waitForFunction(() => !document.getElementById('tv-video').hasAttribute('src'));
  console.log('PASS TV/Fire TV web receiver: autoplay blocked preserves local playback; real HLS/fMP4 frames after consent, pairing, pause, seek, resume, return at position');

  await sender.evaluate(() => { window.castTest.mode = 'cancel'; });
  await sender.getByRole('button', { name: 'Chromecast / Google TV', exact: true }).click();
  await sender.waitForFunction(() => document.querySelector('.cast-status').textContent.includes('No se seleccionó'));
  assert.equal(await sender.locator('#video').evaluate(element => element.paused), false);
  await sender.evaluate(() => { window.castTest.mode = 'fail'; }); await sender.getByRole('button', { name: 'Chromecast / Google TV', exact: true }).click();
  await sender.waitForFunction(() => document.querySelector('.cast-status').textContent.includes('no pudo abrir'));
  const failedUrl = await sender.evaluate(() => window.castTest.request.media.contentId); assert.equal((await context.request.get(failedUrl)).status(), 401);
  assert.equal(await sender.locator('#video').evaluate(element => element.paused), false);
  await sender.evaluate(() => { window.castTest.mode = 'ok'; }); await sender.getByRole('button', { name: 'Chromecast / Google TV', exact: true }).click();
  await sender.waitForFunction(() => document.getElementById('video').paused && document.querySelector('.cast-remote').hidden === false);
  const castRequest = await sender.evaluate(() => window.castTest.request);
  assert.match(castRequest.media.contentType, /mpegurl/); assert.equal(castRequest.media.hlsVideoSegmentFormat, 'fmp4'); assert.equal(castRequest.media.hlsSegmentFormat, 'fmp4'); assert.ok(castRequest.currentTime > 0); assert.doesNotMatch(castRequest.media.contentId, /PRIVATE_TOKEN|api_key/);
  const castPlaylist = await context.request.get(castRequest.media.contentId); assert.equal(castPlaylist.status(), 200);
  const init = (await castPlaylist.text()).match(/URI="([^"]+)"/)[1];
  const castVideo = await context.request.get(init, { headers: { Range: 'bytes=0-511' } }); assert.equal(castVideo.status(), 206); assert.equal((await castVideo.body()).length, 512);
  await sender.getByRole('button', { name: 'Pausar en TV', exact: true }).click();
  await sender.waitForFunction(() => document.querySelector('.cast-remote button').textContent === 'Continuar en TV');
  await sender.evaluate(() => { window.castTest.endThrows = true; });
  await sender.getByRole('button', { name: 'Volver a este dispositivo', exact: true }).click();
  await sender.waitForFunction(() => !document.getElementById('video').paused);
  assert.equal((await context.request.get(castRequest.media.contentId)).status(), 401);
  console.log('PASS Cast sender (SDK simulated): MIME/position, media transfer without cookies, cancellation/load failure recovery, controls and revocation');

  await sender.setViewportSize({ width: 390, height: 844 });
  assert.ok(await sender.locator('.cast-panel').evaluate(element => element.getBoundingClientRect().right <= innerWidth));
  await sender.evaluate(() => { window.castTest.endThrows = false; window.castTest.mode = 'delayed'; }); await sender.getByRole('button', { name: 'Chromecast / Google TV', exact: true }).click();
  await sender.waitForFunction(() => !!window.castTest.resolveLoad);
  const pendingUrl = await sender.evaluate(() => window.castTest.request.media.contentId);
  await sender.locator('#close-player').click(); await sender.waitForFunction(() => !document.getElementById('player-dialog').open);
  assert.equal((await context.request.get(pendingUrl)).status(), 401); await sender.evaluate(() => window.castTest.resolveLoad());
  await sender.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await receiver.waitForFunction(() => document.getElementById('tv-status').textContent.includes('vinculación terminó'));
  assert.deepEqual(errors, []);
  console.log('PASS responsive controls, closing player cancels pending Cast load, logout unpairs receiver, no browser JavaScript errors');
  if (process.env.JRP_CAST_SDK_SMOKE === '1') {
    const realContext = await browser.newContext({ ignoreHTTPSErrors: true }); const realPage = await realContext.newPage(); const sdkErrors = []; let sdkLoaded = false;
    realPage.on('pageerror', error => sdkErrors.push(error.message));
    realPage.on('response', response => { if (response.url().startsWith('https://www.gstatic.com/cv/js/sender/') && response.status() === 200) sdkLoaded = true; });
    await realPage.addInitScript(() => { window.castPolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.castPolicyViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI })); });
    await realPage.goto(base + '/app'); await realPage.getByLabel('Usuario', { exact: true }).fill('fixture'); await realPage.getByLabel('Contraseña', { exact: true }).fill('fixture'); await realPage.locator('#login-form button[type=submit]').click();
    await realPage.getByRole('button', { name: '▷ Reproducir', exact: true }).first().click(); await realPage.locator('.cast-panel summary').click();
    await realPage.waitForFunction(() => !document.querySelector('.cast-actions button').textContent.includes('Preparando'), null, { timeout: 20000 });
    assert.equal(sdkLoaded, true, 'official Google SDK must load over HTTPS'); assert.deepEqual(sdkErrors, []); assert.deepEqual(await realPage.evaluate(() => window.castPolicyViolations), []);
    console.log('PASS official Google Cast SDK HTTPS load and CSP, no hardware session requested');
    await realContext.close();
  }
} finally {
  await browser?.close(); app.close(); gateway.closeAllConnections(); media.closeAllConnections();
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => media.close(resolve))]); await rm(root, { recursive: true, force: true });
}
