const $ = id => document.getElementById(id);
const video = $('tv-video');
let secret; let ack = 0; let timer; let expiresAt = 0; let media = null; let hls; let pendingSeek = 0; let status = 'ready'; let generation = 0;
async function request(path, data) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'No se pudo conectar con JRPlex.'); error.status = response.status; throw error; }
    return result;
  } finally { clearTimeout(timeout); }
}
function clearVideo() {
  hls?.destroy(); hls = null; media = null; status = 'ready'; pendingSeek = 0;
  video.pause(); video.removeAttribute('src'); video.load(); $('tv-player').hidden = true; $('tv-play').hidden = true;
}
async function play() {
  try { await video.play(); $('tv-play').hidden = true; }
  catch (error) {
    if (error.name === 'NotAllowedError') { status = 'blocked'; $('tv-play').hidden = false; $('tv-status').textContent = 'Pulsa Reproducir en esta pantalla para autorizar el vídeo.'; }
    else { status = 'error'; video.dataset.playbackError = error.name; $('tv-status').textContent = 'No se pudo reproducir el vídeo. Revisa la conexión y vuelve a enviarlo.'; }
  }
}
async function apply(command) {
  if (command.command === 'play') {
    const url = new URL(command.media.url);
    if (url.origin !== location.origin || !/^\/cast\/media\/[A-Za-z0-9_-]{43}\//.test(url.pathname)) throw new Error('Fuente de TV no válida.');
    clearVideo(); media = command.media; pendingSeek = media.canSeek ? command.position : 0; status = 'buffering';
    $('tv-title').textContent = media.title; $('tv-pairing').hidden = true; $('tv-player').hidden = false;
    $('tv-status').textContent = 'Preparando el vídeo recibido…';
    if (/mpegurl/i.test(media.contentType) && window.Hls?.isSupported()) {
      hls = new window.Hls({ startPosition: pendingSeek || -1 });
      hls.on(window.Hls.Events.ERROR, (_event, data) => { if (data.fatal) { status = 'error'; video.dataset.playbackError = data.details; $('tv-status').textContent = 'La transmisión se interrumpió. Vuelve a enviar el vídeo desde JRPlex.'; } });
      hls.loadSource(url.href); hls.attachMedia(video);
    } else {
      if (/mpegurl/i.test(media.contentType) && !video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('Este navegador de TV no admite el formato HLS.');
      video.src = url.href;
    }
    void play();
  } else if (command.command === 'pause') video.pause();
  else if (command.command === 'resume') await play();
  else if (command.command === 'seek' && media?.canSeek && Number.isFinite(video.duration)) video.currentTime = Math.min(command.position, Math.max(0, video.duration - 0.1));
  else if (command.command === 'stop') { clearVideo(); $('tv-status').textContent = 'Pantalla vinculada. Elige otro vídeo en JRPlex para enviarlo aquí.'; }
}
async function poll(run) {
  if (!secret || run !== generation) return;
  try {
    const result = await request('/cast/receiver/poll', { secret, ack, state: { mediaId: media?.id || null, status, position: Number.isFinite(video.currentTime) ? video.currentTime : 0, duration: Number.isFinite(video.duration) ? video.duration : 0, paused: video.paused } });
    if (run !== generation) return;
    if (result.paired && !media) { $('tv-pairing').hidden = true; $('tv-status').textContent = 'Pantalla vinculada. Ya puedes enviar el vídeo desde JRPlex.'; }
    for (const command of result.commands) {
      if (command.sequence <= ack) continue;
      try { await apply(command); } catch (error) { status = 'error'; video.dataset.playbackError = error.message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 180); $('tv-status').textContent = error.message; }
      ack = command.sequence;
    }
  } catch (error) {
    if (run !== generation) return;
    if ([401, 403].includes(error.status)) { secret = null; clearVideo(); $('tv-pairing').hidden = false; $('tv-code').textContent = '------'; $('tv-status').textContent = 'La vinculación terminó. Genera un nuevo código para volver a conectar.'; return; }
    $('tv-status').textContent = 'Se perdió la conexión de control. Intentando conectar de nuevo…';
  }
  if (run === generation) timer = setTimeout(() => void poll(run), 1000);
}
async function start() {
  const run = ++generation; clearTimeout(timer); secret = null; clearVideo(); ack = 0; $('tv-pairing').hidden = false;
  try {
    const result = await request('/cast/receiver/start', { name: $('tv-name').value });
    if (run !== generation) return;
    secret = result.secret; expiresAt = result.expiresAt; $('tv-code').textContent = result.code; $('tv-status').textContent = 'Esperando vinculación desde JRPlex…'; void poll(run);
  } catch (error) { $('tv-status').textContent = error.message; }
}
video.addEventListener('loadedmetadata', () => { if (media?.canSeek && pendingSeek > 0 && Number.isFinite(video.duration)) { video.currentTime = Math.min(pendingSeek, Math.max(0, video.duration - 0.1)); pendingSeek = 0; } });
video.addEventListener('playing', () => { if (!media) return; status = 'playing'; $('tv-status').textContent = 'Reproduciendo en esta pantalla'; $('tv-play').hidden = true; });
video.addEventListener('pause', () => { if (media && !['blocked', 'ended', 'error'].includes(status)) status = 'paused'; });
video.addEventListener('waiting', () => { if (media && !['blocked', 'error'].includes(status)) status = 'buffering'; });
video.addEventListener('ended', () => { if (media) status = 'ended'; });
video.addEventListener('error', () => { if (media) { status = 'error'; video.dataset.playbackError = `media-${video.error?.code}: ${video.error?.message || ''}`.slice(0, 180); $('tv-status').textContent = 'La TV no pudo leer el vídeo. Comprueba la conexión o vuelve a enviarlo.'; } });
$('tv-play').addEventListener('click', () => void play());
$('tv-name-form').addEventListener('submit', event => { event.preventDefault(); void start(); });
$('tv-fullscreen').addEventListener('click', () => { const target = media ? video : document.documentElement; void target.requestFullscreen?.().catch(() => { $('tv-status').textContent = 'Usa el control de pantalla completa de tu navegador o del vídeo.'; }); });
setInterval(() => { const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); $('tv-expiry').textContent = left ? `Código válido durante ${Math.ceil(left / 60)} min` : 'El código caducó. Genera uno nuevo.'; }, 1000);
void start();
