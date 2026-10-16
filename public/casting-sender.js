let sdkPromise;
function castSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const finish = available => {
      clearTimeout(timer);
      if (!available || !window.cast?.framework || !window.chrome?.cast) { reject(new Error('Usa Chrome compatible con Cast o vincula la TV con un código.')); return; }
      try {
        const context = window.cast.framework.CastContext.getInstance();
        context.setOptions({ receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED, resumeSavedSession: false });
        resolve(context);
      } catch { reject(new Error('Chromecast no está disponible en este navegador. Vincula la TV con un código.')); }
    };
    const timer = setTimeout(() => finish(false), 12000);
    if (window.cast?.framework && window.chrome?.cast?.isAvailable) { finish(true); return; }
    window.__onGCastApiAvailable = finish;
    const script = document.createElement('script'); script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'; script.async = true;
    script.onerror = () => finish(false); document.head.append(script);
  });
  return sdkPromise;
}
const node = (tag, text, properties = {}) => { const value = document.createElement(tag); if (text) value.textContent = text; Object.assign(value, properties); return value; };
const time = value => { const total = Math.max(0, Math.floor(value || 0)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
const endGoogle = session => { try { session.endSession(true); } catch {} };

export function createCastControls({ video, api, source, isAuthenticated = () => true, onChange = () => {} }) {
  const element = node('details', '', { className: 'cast-panel' });
  const summary = node('summary', '▣ Enviar a TV'); element.append(summary);
  const status = node('p', 'Elige Chromecast o vincula tu TV / Fire TV con un código.', { className: 'cast-status' }); status.setAttribute('role', 'status');
  const actions = node('div', '', { className: 'cast-actions' });
  const google = node('button', 'Preparando Chromecast…', { type: 'button', className: 'secondary', disabled: true });
  const refreshButton = node('button', 'Actualizar pantallas', { type: 'button', className: 'small-button' });
  const screens = node('select'); screens.setAttribute('aria-label', 'Pantalla vinculada');
  const send = node('button', 'Enviar a la pantalla', { type: 'button', className: 'secondary', disabled: true });
  actions.append(google, refreshButton, screens, send);
  const instructions = node('p', 'TV / Fire TV: abre ', { className: 'cast-note' });
  instructions.append(node('a', `${location.origin}/tv`, { href: '/tv', target: '_blank', rel: 'noopener' }), document.createTextNode(' en el navegador del televisor (Silk en Fire TV). Introduce aquí el código mostrado.'));
  const form = node('form', '', { className: 'cast-pair' });
  const code = node('input', '', { type: 'text', inputMode: 'numeric', maxLength: 6, pattern: '[0-9]{6}', required: true, placeholder: '123456', autocomplete: 'off' }); code.setAttribute('aria-label', 'Código de la TV');
  const pair = node('button', 'Vincular TV / Fire TV y enviar', { type: 'submit', className: 'secondary' }); form.append(code, pair);
  const remote = node('div', '', { className: 'cast-remote', hidden: true });
  const pause = node('button', 'Pausar en TV', { type: 'button', className: 'small-button' });
  const seek = node('input', '', { type: 'range', min: 0, max: 0, step: 1, value: 0 }); seek.setAttribute('aria-label', 'Posición en la TV');
  const progress = node('span', '0:00');
  const back = node('button', 'Volver a este dispositivo', { type: 'button', className: 'small-button' }); remote.append(pause, seek, progress, back);
  element.append(actions, instructions, form, remote, status);
  let disposed = false; let active = null; let context; let interval; let pending = false; let operation = 0; let contact = Date.now(); let castingListener; let sdkStarted = false; let loadingGoogle = null;
  function playback() {
    if (!active?.started) return null;
    if (active.kind === 'google') {
      const media = active.session.getMediaSession();
      return { position: media?.getEstimatedTime?.() ?? media?.currentTime ?? active.position, duration: media?.media?.duration || 0, paused: media?.playerState === 'PAUSED', canSeek: active.media.canSeek, ...active.media };
    }
    return { ...active.state, canSeek: active.media.canSeek, ...active.media };
  }
  function paint() {
    remote.hidden = !active; google.disabled = pending || !context || active?.kind === 'google'; send.disabled = pending || !screens.value; pair.disabled = pending;
    if (!active) { summary.textContent = '▣ Enviar a TV'; return; }
    summary.textContent = `▣ Enviando a ${active.name}`;
    const state = playback();
    if (state) {
      pause.textContent = state.paused ? 'Continuar en TV' : 'Pausar en TV';
      seek.disabled = !state.canSeek || !Number.isFinite(state.duration) || state.duration <= 0;
      seek.max = String(state.duration || 0); if (document.activeElement !== seek) seek.value = String(state.position || 0);
      progress.textContent = `${time(state.position)} / ${time(state.duration)}`;
    } else { seek.disabled = true; pause.disabled = true; }
    if (state) pause.disabled = false;
  }
  async function revoke(media) { if (media?.id && isAuthenticated()) await api(`/api/cast/media/${media.id}`, { method: 'DELETE', body: {} }).catch(() => {}); }
  async function stop({ resume = true, ended = false } = {}) {
    ++operation; const previous = active; const state = playback(); active = null; paint();
    const loading = loadingGoogle; loadingGoogle = null;
    if (loading) { endGoogle(loading.session); await revoke(loading.media); }
    if (!previous) return;
    if (previous.kind === 'google') { if (!ended) endGoogle(previous.session); }
    else if (isAuthenticated()) await api(`/api/cast/receivers/${previous.receiverId}/command`, { method: 'POST', body: { command: 'stop' } }).catch(() => {});
    await revoke(previous.media);
    if (state?.canSeek && Number.isFinite(video.duration)) { try { video.currentTime = Math.min(state.position || 0, Math.max(0, video.duration - 0.1)); } catch {} }
    status.textContent = 'El envío a TV terminó.'; if (!disposed) onChange(null);
    if (resume && !disposed) {
      await video.play().catch(() => { status.textContent = 'Pulsa reproducir para continuar en este dispositivo.'; });
    }
  }
  function started() {
    if (!active || active.started) return;
    active.started = true; video.pause();
    status.textContent = `Reproduciendo en ${active.name}.${active.media.canSeek ? '' : ' Este torrent convertido se reproduce desde el principio y no permite adelantar.'}`;
    onChange(playback());
  }
  async function refresh() {
    if (disposed || !isAuthenticated() || (!element.open && !active)) return;
    try {
      const result = await api('/api/cast/receivers', { signal: AbortSignal.timeout(10000) });
      if (disposed) return;
      const selected = screens.value; screens.replaceChildren(node('option', result.receivers.length ? 'Elige una pantalla' : 'No hay pantallas vinculadas', { value: '' }));
      for (const receiver of result.receivers) screens.append(node('option', receiver.name, { value: receiver.id }));
      if (result.receivers.some(receiver => receiver.id === selected)) screens.value = selected;
      if (active?.kind === 'tv') {
        const receiver = result.receivers.find(receiver => receiver.id === active.receiverId);
        if (!receiver || !receiver.online) { const error = new Error('La pantalla dejó de responder. Abre JRPlex /tv y vuelve a vincularla.'); error.status = 404; throw error; }
        contact = Date.now();
        if (receiver.state.mediaId === active.media.id) {
          active.state = receiver.state;
          if (receiver.state.status === 'playing') started();
          if (receiver.state.status === 'blocked') status.textContent = 'Pulsa Reproducir en la TV para autorizar el vídeo. La reproducción local continúa mientras tanto.';
          if (receiver.state.status === 'error') { await stop(); status.textContent = 'La TV no pudo reproducir este vídeo. Se conserva la reproducción local.'; }
          if (receiver.state.status === 'ended') { await stop({ resume: false }); status.textContent = 'El vídeo terminó en la TV.'; }
          if (active && !active.started && Date.now() - active.created > 90000) { await stop(); status.textContent = 'La TV no inició el vídeo en 90 segundos. Comprueba la pantalla y vuelve a enviarlo.'; }
        }
      }
    } catch (error) {
      if (disposed) return;
      status.textContent = error.message;
      if (active?.kind === 'tv' && (error.status === 404 || Date.now() - contact > 15000)) { await stop(); status.textContent = error.message; }
    }
    if (active?.kind === 'google') {
      const media = active.session.getMediaSession();
      if (media?.playerState === 'IDLE' && media.idleReason === 'ERROR') { await stop(); status.textContent = 'Chromecast no pudo leer el vídeo. La reproducción local sigue disponible.'; }
      else if (media?.playerState === 'IDLE' && media.idleReason === 'FINISHED') { await stop({ resume: false }); status.textContent = 'El vídeo terminó en Chromecast.'; }
    }
    paint();
  }
  async function run(action) {
    if (pending || disposed) return; pending = true; paint();
    try { await action(); } catch (error) { if (!disposed) status.textContent = error.message || 'No se pudo enviar a la TV.'; }
    finally { pending = false; if (!disposed) paint(); }
  }
  async function sendTv(id) {
    if (disposed) return;
    await stop({ resume: false }); const intent = ++operation;
    status.textContent = 'Preparando el vídeo para la TV…';
    const result = await api(`/api/cast/receivers/${id}/play`, { method: 'POST', body: { ...source(), position: video.currentTime || 0 } });
    if (disposed || intent !== operation) { if (isAuthenticated()) await api(`/api/cast/receivers/${id}/command`, { method: 'POST', body: { command: 'stop' } }).catch(() => {}); await revoke(result.media); return; }
    active = { kind: 'tv', receiverId: id, media: result.media, state: result.receiver.state, name: result.receiver.name, started: false, created: Date.now() }; contact = Date.now();
    status.textContent = 'Esperando que la TV confirme la reproducción…'; paint(); void refresh();
  }
  google.addEventListener('click', () => void run(async () => {
    if (!context) throw new Error('Usa Chrome con Cast o la vinculación por código.');
    try { await context.requestSession(); } catch { status.textContent = 'No se seleccionó un Chromecast. La reproducción local continúa.'; return; }
    if (disposed) return;
    await stop({ resume: false }); const intent = ++operation;
    const session = context.getCurrentSession(); if (!session) throw new Error('No se pudo conectar con Chromecast.');
    status.textContent = 'Preparando el vídeo para Chromecast…';
    const media = await api('/api/cast/media', { method: 'POST', body: source() });
    if (disposed || intent !== operation) { await revoke(media); return; }
    loadingGoogle = { session, media };
    try {
      const info = new window.chrome.cast.media.MediaInfo(media.url, media.contentType);
      info.metadata = new window.chrome.cast.media.GenericMediaMetadata(); info.metadata.title = media.title;
      info.streamType = media.canSeek ? window.chrome.cast.media.StreamType.BUFFERED : window.chrome.cast.media.StreamType.LIVE;
      if (media.hlsFormat === 'fmp4') { info.hlsSegmentFormat = window.chrome.cast.media.HlsSegmentFormat.FMP4; info.hlsVideoSegmentFormat = window.chrome.cast.media.HlsVideoSegmentFormat.FMP4; }
      const request = new window.chrome.cast.media.LoadRequest(info); request.currentTime = media.canSeek ? video.currentTime || 0 : 0; request.autoplay = true;
      let timeout;
      try { await Promise.race([session.loadMedia(request), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cast timeout')), 65000); })]); }
      finally { clearTimeout(timeout); }
      loadingGoogle = null;
      if (disposed || intent !== operation) { endGoogle(session); await revoke(media); return; }
      active = { kind: 'google', session, media, name: session.getCastDevice()?.friendlyName || 'Chromecast', started: false, position: request.currentTime };
      started(); paint();
    } catch { loadingGoogle = null; endGoogle(session); await revoke(media); throw new Error('Chromecast no pudo abrir el vídeo. Revisa que la TV tenga acceso a este servidor.'); }
  }));
  form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
    const receiver = await api('/api/cast/pair', { method: 'POST', body: { code: code.value.trim() } }); code.value = ''; await sendTv(receiver.id);
  }); });
  send.addEventListener('click', () => void run(() => sendTv(screens.value)));
  screens.addEventListener('change', paint);
  refreshButton.addEventListener('click', () => void refresh());
  element.addEventListener('toggle', () => { if (element.open) { prepareGoogle(); void refresh(); } });
  const googleCommand = (method, request) => new Promise((resolve, reject) => {
    const media = active?.session.getMediaSession(); if (!media) { reject(new Error('Chromecast no tiene una reproducción activa.')); return; }
    media[method](request, resolve, () => reject(new Error('Chromecast no respondió al control.')));
  });
  pause.addEventListener('click', () => void run(async () => {
    const state = playback(); if (!active || !state) return;
    if (active.kind === 'tv') await api(`/api/cast/receivers/${active.receiverId}/command`, { method: 'POST', body: { command: state.paused ? 'resume' : 'pause' } });
    else await googleCommand(state.paused ? 'play' : 'pause', state.paused ? new window.chrome.cast.media.PlayRequest() : new window.chrome.cast.media.PauseRequest());
    void refresh();
  }));
  seek.addEventListener('change', () => void run(async () => {
    if (!active || !active.media.canSeek) return;
    const position = Number(seek.value);
    if (active.kind === 'tv') await api(`/api/cast/receivers/${active.receiverId}/command`, { method: 'POST', body: { command: 'seek', position } });
    else { const request = new window.chrome.cast.media.SeekRequest(); request.currentTime = position; await googleCommand('seek', request); }
  }));
  back.addEventListener('click', () => void run(() => stop()));
  interval = setInterval(() => void refresh(), 2000);
  function prepareGoogle() {
    if (sdkStarted) return; sdkStarted = true;
    void castSdk().then(value => {
    if (disposed) return; context = value; google.textContent = 'Chromecast / Google TV'; paint();
    castingListener = event => { if (active?.kind === 'google' && event.sessionState === window.cast.framework.SessionState.SESSION_ENDED) void stop({ ended: true }); };
    context.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, castingListener);
    }, error => { if (!disposed) { google.textContent = 'Chromecast no disponible'; google.title = error.message; } });
  }
  paint();
  return { element, playback, get active() { return !!active; }, async dispose() { if (disposed) return; disposed = true; clearInterval(interval); if (castingListener) context.removeEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, castingListener); await stop({ resume: false }); element.remove(); } };
}
