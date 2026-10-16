import { hasPlayableMedia, isDisplayableItem, isPhotoFolder, isPhotoItem, isTypeScriptDeclaration } from './media-eligibility.js';

'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { session: null, view: 'home', search: '', generation: 0, adminTab: 'users', poll: null, player: null, torrentStop: null, playerGeneration: 0, detailGeneration: 0, photoTimer: null, photos: null };
  const cloudReturn = new URLSearchParams(window.location.search).get('cloud');
  if (['google-linked', 'google-error', 'google-cancelled'].includes(cloudReturn)) window.history.replaceState(null, '', window.location.pathname);
  let toastTimer; let playIntent = 0;
  window.addEventListener('error', () => { if ($('login-screen')?.hidden && $('app-screen')?.hidden) showLogin('No se pudo iniciar la interfaz. Recarga la página para intentarlo de nuevo.'); else notify('Se produjo un error en la interfaz. Recarga la vista si no responde.', true); });
  window.addEventListener('unhandledrejection', event => { event.preventDefault(); if ($('login-screen')?.hidden && $('app-screen')?.hidden) showLogin('No se pudo conectar con la biblioteca. Recarga la página para intentarlo de nuevo.'); else notify('No se pudo completar una operación. Inténtalo otra vez.', true); });
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }
  const button = (label, action, cls = 'secondary') => el('button', { type: 'button', class: cls, onclick: () => void busy(null, action) }, label);
  const title = (name, subtitle = '') => el('div', { class: 'page-title' }, el('div', {}, el('h1', {}, name), el('p', {}, subtitle)));
  const empty = (heading, copy) => el('div', { class: 'empty' }, el('span', { class: 'empty-symbol', 'aria-hidden': 'true' }, '◈'), el('h3', {}, heading), el('p', {}, copy));
  const heading = (name, detail = '') => el('div', { class: 'section-heading' }, el('h2', {}, name), el('small', {}, detail));
  const ticks = (seconds) => Math.max(0, Math.round((Number(seconds) || 0) * 10000000));
  const seconds = (value) => Math.max(0, (Number(value) || 0) / 10000000);
  const runtime = (value) => value ? `${Math.max(1, Math.round(seconds(value) / 60))} min` : '';
  const formatBytes = (value) => { const size = Math.max(0, Number(value) || 0); const unit = size >= 1024 ** 3 ? 'GB' : size >= 1024 ** 2 ? 'MB' : 'KB'; const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024; return `${(size / divisor).toFixed(1)} ${unit}`; };
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const isAudio = (item) => item?.MediaType === 'Audio' || item?.Type === 'Audio';
  const isContainer = (item) => ['Series', 'Season', 'MusicAlbum', 'MusicArtist', 'Folder', 'CollectionFolder', 'BoxSet'].includes(item?.Type) || item?.IsFolder;
  const isAdministrator = () => !!state.session?.user?.Policy?.IsAdministrator;
  function sourcePath(item, source) { return typeof source?.Path === 'string' ? source.Path : typeof item?.Path === 'string' ? item.Path : ''; }
  function sourceFileName(value) { const parts = String(value || '').replace(/\\/g, '/').split('/'); return parts.at(-1) || ''; }
  function sourceDiagnosticsText(item, source) {
    if (!isAdministrator()) return '';
    const fullPath = sourcePath(item, source); const streams = source?.MediaStreams || item?.MediaStreams || [];
    const tracks = streams.map(stream => `${stream.Type || 'Pista'}${stream.Codec ? `: ${stream.Codec}` : ''}`).join(', ') || 'Sin pistas indexadas';
    const size = Number(source?.Size || item?.Size);
    return [`Archivo: ${sourceFileName(fullPath) || item.Name || 'No informado'}`, fullPath ? `Ruta: ${fullPath}` : '', `Tipo: ${item.MediaType || item.Type || 'Sin clasificar'}`, `Contenedor: ${source?.Container || item.Container || item.JRPlexMediaExtension || 'No detectado'}`, size > 0 ? `Tamaño: ${formatBytes(size)}` : '', `Pistas: ${tracks}`].filter(Boolean).join('\n');
  }
  function sourceDiagnostics(item) {
    if (!isAdministrator()) return null;
    const source = (item.MediaSources || []).find(candidate => typeof candidate.Path === 'string') || null;
    const fullPath = sourcePath(item, source); const streams = source?.MediaStreams || item.MediaStreams || [];
    const rows = [
      ['Nombre completo del archivo', sourceFileName(fullPath) || item.Name || 'No informado'],
      ['Ruta en el servidor', fullPath || 'Jellyfin no devolvió la ruta'],
      ['Tipo / contenedor', `${item.MediaType || item.Type || 'Sin clasificar'} · ${source?.Container || item.Container || item.JRPlexMediaExtension || 'Sin detectar'}`],
      ['Tamaño', Number(source?.Size || item.Size) > 0 ? formatBytes(source?.Size || item.Size) : 'No informado'],
      ['Pistas de audio y vídeo', streams.length ? streams.map(stream => `${stream.Type || 'Pista'}${stream.Codec ? `: ${stream.Codec}` : ''}`).join(' · ') : 'Ninguna indexada'],
    ];
    return el('section', { class: 'source-diagnostics' }, el('h3', {}, 'Datos del archivo · diagnóstico de administrador'), el('dl', {}, rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)])));
  }
  const isCatalogItem = isDisplayableItem;
  function notify(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; $('toast').setAttribute('role', error ? 'alert' : 'status');
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
  }
  async function busy(control, action) {
    if (control) control.disabled = true;
    try { return await action(); } catch (error) { if (error.status !== 401) notify(error.message || 'No se pudo completar la operación.', true); }
    finally { if (control?.isConnected) control.disabled = false; }
  }
  async function api(route, { method = 'GET', body, signal, keepalive = false } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Ruta de servidor inválida.');
    const mutates = !['GET', 'HEAD'].includes(method);
    let response;
    try {
      response = await fetch(route, { method, credentials: 'same-origin', redirect: 'error', signal, keepalive,
        headers: { Accept: 'application/json', ...(mutates ? { 'Content-Type': 'application/json', ...(state.session?.csrfToken ? { 'X-CSRF-Token': state.session.csrfToken } : {}) } : {}) },
        ...(mutates ? { body: JSON.stringify(body ?? {}) } : {}) });
    } catch { throw new Error('No se puede conectar con el servidor. Revisa la conexión e inténtalo otra vez.'); }
    if (response.status === 401) { showLogin('La sesión ha terminado. Vuelve a entrar.'); const error = new Error('Sesión terminada.'); error.status = 401; throw error; }
    if (!response.ok) {
      const messages = { 400: 'Revisa los datos introducidos.', 403: 'No tienes permiso para esta acción o el servidor rechazó la solicitud.', 404: 'El elemento ya no está disponible.', 409: 'Este enlace ya está agregado al servicio de torrents y JRPlex no modificó esa descarga. Si ya aparece en JRPlex, abre su sesión activa.', 413: 'El archivo supera el tamaño permitido.', 429: 'Se han realizado demasiados intentos. Espera un momento.', 502: 'El servidor multimedia o qBittorrent no está disponible.', 503: 'Este servicio todavía no está configurado o no está disponible.', 504: 'El torrent no entregó metadatos o piezas a tiempo. Comprueba que tenga pares activos e inténtalo de nuevo.' };
      const error = new Error(messages[response.status] || `No se pudo completar la operación (${response.status}).`); error.status = response.status; throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error('El servidor devolvió una respuesta inesperada.'); }
  }
  function stopPolling() { clearInterval(state.poll); state.poll = null; }
  function stopPhotoSlideshow() { clearInterval(state.photoTimer); state.photoTimer = null; }
  function showLogin(message = '') {
    state.session = null; state.generation++; state.detailGeneration++; stopPolling();
    if (state.torrentStop) void state.torrentStop();
    void stopPlayer(false); if ($('detail-dialog').open) $('detail-dialog').close();
    if ($('password-dialog').open) $('password-dialog').close();
    $('password-form').reset();
    $('app-screen').hidden = true; $('login-screen').hidden = false; $('login-error').textContent = message; $('password').value = '';
  }
  async function signedIn(session) {
    if (!session?.user?.Id || !session.csrfToken) throw new Error('La sesión recibida no es válida.');
    state.session = session; $('user-name').textContent = session.user.Name || 'Usuario'; $('user-initial').textContent = Array.from(session.user.Name || 'U')[0].toUpperCase();
    $('admin-nav').hidden = !session.user.Policy?.IsAdministrator; $('login-screen').hidden = true; $('app-screen').hidden = false;
    state.search = ''; $('search-input').value = ''; await navigate('home');
  }
  function poster(item) {
    const node = el('div', { class: 'poster' }, el('span', { class: 'poster-placeholder' }, item.Name || 'Sin título'));
    if (validId(item.Id)) {
      const image = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
      image.addEventListener('load', () => { node.querySelector('.poster-placeholder')?.remove(); });
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = `/jellyfin/Items/${item.Id}/Images/Primary?maxWidth=420&quality=85`; node.append(image);
    }
    return node;
  }
  function card(item) {
    const image = poster(item);
    image.append(el('span', { class: 'poster-play', 'aria-hidden': 'true' }, '▷'));
    if (item.UserData?.IsFavorite) image.append(el('span', { class: 'favorite-badge', 'aria-label': 'Favorito' }, '♥'));
    const position = Number(item.UserData?.PlaybackPositionTicks) || 0;
    if (position > 0 && item.RunTimeTicks > 0) image.append(el('div', { class: 'progress-track' }, el('progress', { max: 100, value: Math.min(100, position / item.RunTimeTicks * 100), 'aria-label': 'Progreso de reproducción' })));
    return el('button', { type: 'button', class: 'media-card', onclick: () => void busy(null, () => detail(item)), 'aria-label': `Ver ${item.Name || 'contenido'}` }, image,
      el('span', { class: 'card-title' }, item.Name || 'Sin título'), el('span', { class: 'card-meta' }, el('span', {}, item.ProductionYear || item.SeriesName || item.AlbumArtist || ''), el('span', {}, item.UserData?.Played ? 'Visto' : runtime(item.RunTimeTicks))));
  }
  function hero(item) {
    const node = el('section', { class: 'hero' });
    if (item && validId(item.Id)) {
      const image = el('img', { class: 'hero-background', alt: '', decoding: 'async' }); image.addEventListener('error', () => image.remove(), { once: true });
      image.src = `/jellyfin/Items/${item.Id}/Images/Backdrop/0?maxWidth=1600&quality=85`; node.append(image);
    }
    const copy = el('div', { class: 'hero-copy' }, el('span', { class: 'eyebrow' }, item ? 'DE TU BIBLIOTECA' : 'TU PRÓXIMA HISTORIA'),
      el('h1', {}, item?.Name || 'Tu biblioteca empieza contigo.'), el('p', {}, item?.Overview || (item ? 'Descubre este título de tu colección personal.' : 'Aquí aparecerán tus películas, series y música cuando tu administrador conecte una biblioteca.')));
    if (item) copy.append(el('div', { class: 'hero-actions' }, button(isContainer(item) ? 'Explorar' : '▷ Reproducir', () => isContainer(item) ? detail(item) : play(item), 'primary'), button('Más información', () => detail(item))));
    else if (state.session?.user.Policy?.IsAdministrator) copy.append(el('div', { class: 'hero-actions' }, button('Conectar una biblioteca ↗', () => { state.adminTab = 'libraries'; return navigate('admin'); }, 'primary')));
    node.append(copy, el('span', { class: 'hero-watermark', 'aria-hidden': 'true' }, '▷')); return node;
  }
  async function navigate(view) {
    stopPolling(); if (state.torrentStop) void state.torrentStop(); state.view = view; const generation = ++state.generation;
    stopPhotoSlideshow(); state.photos = null; if ($('photos-dialog')?.open) $('photos-dialog').close();
    for (const node of document.querySelectorAll('[data-view]')) { node.classList.toggle('active', node.dataset.view === view); node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false'); }
    $('content').replaceChildren(el('div', { class: 'loading', role: 'status' }, 'Cargando tu biblioteca…'));
    try {
      if (view === 'admin') { if (!state.session?.user.Policy?.IsAdministrator) throw new Error('Se necesita una cuenta administradora.'); await renderAdmin(generation); }
      else if (view === 'photos') await renderPhotos(generation);
      else if (view === 'folders') await renderFolders(generation);
      else await renderCatalogue(generation);
    } catch (error) {
      if (generation === state.generation && state.session) $('content').replaceChildren(empty('No se pudo cargar esta vista', error.message), button('Volver a intentar', () => navigate(view)));
    }
  }
  async function renderFolders(generation) {
    const userId = state.session?.user?.Id;
    if (!validId(userId)) throw new Error('La sesión no tiene un usuario válido.');
    const response = await api(`/Users/${userId}/Views`);
    if (generation !== state.generation) return;
    const libraries = (response?.Items || []).filter(view => validId(view?.Id));
    const content = $('content');
    const renderLibraryList = () => {
      content.replaceChildren(title('Carpetas', 'Busca y explora las bibliotecas locales y de Google Drive autorizadas para tu cuenta.'));
      if (!libraries.length) { content.append(empty('No hay bibliotecas disponibles', 'El administrador debe conectar una carpeta local o de Google Drive.')); return; }
      const list = el('div', { class: 'folder-library-list', role: 'group', 'aria-label': 'Bibliotecas disponibles' });
      for (const library of libraries) list.append(button(`▰ ${library.Name || 'Biblioteca'}`, () => void busy(null, () => browse(library)), 'folder-card'));
      content.append(list);
    };
    const browse = async (library, parentId = library.Id, stack = [], search = '', startIndex = 0, target = content) => {
      const query = new URLSearchParams({ ParentId: parentId, Recursive: search ? 'true' : 'false', Limit: '100', StartIndex: String(startIndex), SortBy: 'SortName', SortOrder: 'Ascending', IncludeItemTypes: 'Folder,CollectionFolder,Series,Season,MusicAlbum,MusicArtist,Movie,Video,Episode,Audio', Fields: 'Overview,Genres,MediaSources,MediaStreams', EnableUserData: 'true' });
      if (search) query.set('SearchTerm', search);
      const page = await api(`/Users/${userId}/Items?${query}`);
      if (generation !== state.generation) return;
      if (startIndex === 0) {
        target.replaceChildren(title('Carpetas', `${library.Name || 'Biblioteca'} · busca en esta carpeta y sus subcarpetas.`));
        const breadcrumbs = el('div', { class: 'folder-breadcrumbs', 'aria-label': 'Ruta de carpetas' });
        breadcrumbs.append(button('Bibliotecas', renderLibraryList, 'small-button'), el('span', { 'aria-hidden': 'true' }, '›'), button(library.Name || 'Biblioteca', () => browse(library), 'small-button'));
        stack.forEach((folder, index) => breadcrumbs.append(el('span', { 'aria-hidden': 'true' }, '›'), button(folder.name, () => browse(library, folder.id, stack.slice(0, index + 1)), 'small-button')));
        const form = el('form', { class: 'folder-search' });
        const searchBox = el('input', { type: 'search', maxLength: 160, placeholder: 'Buscar dentro de esta carpeta', value: search, 'aria-label': 'Buscar en esta carpeta' });
        const submit = el('button', { type: 'submit', class: 'secondary' }, 'Buscar'); form.append(searchBox, submit);
        form.addEventListener('submit', event => { event.preventDefault(); void busy(submit, () => browse(library, parentId, stack, searchBox.value.trim())); });
        const selector = el('div', { class: 'folder-library-list', role: 'group', 'aria-label': 'Bibliotecas disponibles' });
        for (const candidate of libraries) selector.append(button(candidate.Name || 'Biblioteca', () => browse(candidate), candidate.Id === library.Id ? 'active' : 'small-button'));
        target.append(breadcrumbs, selector, form);
      }
      const items = Array.isArray(page?.Items) ? page.Items : [];
      const grid = target.querySelector('.card-grid') || el('div', { class: 'card-grid' });
      if (!grid.isConnected) target.append(grid);
      const folders = items.filter(item => validId(item?.Id) && isContainer(item));
      const media = items.filter(item => validId(item?.Id) && isDisplayableItem(item));
      for (const folder of folders) grid.append(el('button', { type: 'button', class: 'folder-card', onclick: () => void busy(null, () => browse(library, folder.Id, [...stack, { id: folder.Id, name: folder.Name || 'Carpeta' }])) }, el('span', { 'aria-hidden': 'true' }, '▰'), el('span', {}, folder.Name || 'Carpeta')));
      grid.append(...media.map(card));
      const count = target.querySelector('.folder-result-count') || el('p', { class: 'folder-result-count', role: 'status' });
      count.textContent = `${grid.querySelectorAll('.folder-card').length} carpetas · ${grid.querySelectorAll('.media-card').length} archivos reproducibles`;
      if (!count.isConnected) target.insertBefore(count, grid);
      const total = Number(page?.TotalRecordCount) || startIndex + items.length;
      const oldMore = target.querySelector('.folder-load-more'); oldMore?.remove();
      if (startIndex + items.length < total) {
        const more = el('button', { type: 'button', class: 'secondary load-more folder-load-more' }, 'Cargar más');
        more.addEventListener('click', () => void busy(more, () => browse(library, parentId, stack, search, startIndex + items.length, target)));
        target.append(more);
      }
      if (!items.length && !total && startIndex === 0) target.append(empty(search ? 'Sin coincidencias' : 'Esta carpeta está vacía', search ? 'Prueba otro nombre de carpeta o archivo.' : 'Esta ubicación no contiene carpetas ni archivos indexados.'));
    };
    renderLibraryList();
  }

  async function renderCatalogue(generation) {
    const names = { home: 'Tu biblioteca', movies: 'Películas', series: 'Series', music: 'Música', favorites: 'Favoritos' };
    const query = new URLSearchParams({ Recursive: 'true', Limit: '100', StartIndex: '0', SortBy: 'SortName', SortOrder: 'Ascending', Fields: 'Overview,Genres,MediaSources,MediaStreams,Path', EnableUserData: 'true' });
    if (state.view === 'favorites') query.set('IsFavorite', 'true');
    else query.set('IncludeItemTypes', { home: 'Movie,Series,MusicAlbum,Audio,Video,Episode', movies: 'Movie,Video,Episode', series: 'Series', music: 'MusicAlbum,Audio' }[state.view] || 'Movie,Series,Audio');
    if (state.view === 'music') query.set('MediaTypes', 'Audio');
    else if (state.view === 'movies') query.set('MediaTypes', 'Video');
    if (state.search) query.set('SearchTerm', state.search);
    const [catalogue, resumable] = await Promise.all([api(`/jellyfin/Items?${query}`), state.view === 'home' && !state.search ? api('/jellyfin/Items/Resume?Limit=12&MediaTypes=Video&Fields=Overview,MediaSources,MediaStreams').catch(() => null) : Promise.resolve(null)]);
    if (generation !== state.generation || !state.session) return;
    if (!Array.isArray(catalogue?.Items)) throw new Error('El catálogo recibido no es válido.');
    const content = $('content'); content.replaceChildren();
    const visibleItems = catalogue.Items.filter(isCatalogItem);
    const visibleResumable = (resumable?.Items || []).filter(isDisplayableItem);
    if (state.view === 'home' && !state.search) content.append(hero(visibleItems.find(isDisplayableItem)));
    else content.append(title(state.search ? `Resultados de «${state.search}»` : names[state.view], state.view === 'favorites' ? 'Los títulos que quieres tener cerca.' : 'Tu colección personal, lista para descubrir.'));
    if (visibleResumable.length) content.append(heading('Continúa donde lo dejaste'), el('div', { class: 'card-grid' }, visibleResumable.map(card)));
    const listHeading = heading(state.search ? 'Encontrado en tu biblioteca' : names[state.view]);
    const grid = el('div', { class: 'card-grid' }); content.append(listHeading, grid);
    let playableCount = 0;
    let emptyNotice = null;
    const appendItems = items => {
      const visible = items.filter(isCatalogItem); playableCount += visible.length;
      grid.append(...visible.map(card));
      listHeading.querySelector('small').textContent = `${playableCount} reproducibles`;
      if (visible.length) emptyNotice?.remove();
    };
    appendItems(catalogue.Items);
    if (!visibleItems.length) { emptyNotice = empty(state.search ? 'No hay coincidencias reproducibles' : state.view === 'favorites' ? 'Guarda tus próximas historias' : 'Todavía no hay vídeos compatibles', state.search ? 'Prueba otro nombre o elige un archivo de vídeo o audio compatible.' : state.view === 'favorites' ? 'Abre un título y márcalo como favorito para encontrarlo aquí.' : 'Los vídeos se detectan por su formato y el servidor prepara la reproducción aunque todavía no haya analizado sus pistas.'); content.append(emptyNotice); }
    let index = catalogue.Items.length; const total = Number(catalogue.TotalRecordCount) || index;
    if (index < total) {
      const more = el('button', { type: 'button', class: 'secondary load-more' }, 'Cargar más');
      more.addEventListener('click', () => void busy(more, async () => {
        query.set('StartIndex', String(index)); const next = await api(`/jellyfin/Items?${query}`);
        if (generation !== state.generation) return;
        const items = Array.isArray(next?.Items) ? next.Items : []; appendItems(items); index += items.length;
        if (!items.length || index >= total) more.remove();
      })); content.append(more);
    }
  }
  async function renderPhotos(generation) {
    const userId = state.session?.user?.Id;
    if (!validId(userId)) throw new Error('La sesión no tiene un usuario válido.');
    const result = await api(`/Users/${userId}/Views`);
    if (generation !== state.generation) return;
    const libraries = (result?.Items || []).filter(view => String(view.CollectionType || '').toLowerCase() === 'photos');
    const content = $('content');
    if (!libraries.length) {
      content.replaceChildren(title('Fotografías', 'Tus álbumes y carpetas de imágenes.'));
      content.append(empty('Aún no hay una biblioteca de fotos', 'Pide al administrador que añada la carpeta de imágenes de Drive como biblioteca de tipo Fotografías.'));
      if (state.session.user.Policy?.IsAdministrator) content.append(button('Preparar fotos de Google Drive', async () => { state.adminTab = 'libraries'; await navigate('admin'); }, 'primary'));
      return;
    }
    await renderPhotoFolder(libraries[0], null, [], generation, libraries);
  }
  function photoCard(item, index) {
    const tile = el('button', { type: 'button', class: 'photo-card', 'aria-label': `Abrir fotografía ${item.Name || index + 1}`, onclick: () => openPhoto(index) });
    const image = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = `/jellyfin/Items/${item.Id}/Images/Primary?maxWidth=480&quality=82`;
    tile.append(image, el('span', { class: 'photo-name' }, item.Name || 'Fotografía'));
    return tile;
  }
  async function renderPhotoFolder(library, folderId, stack, generation, libraries = [library]) {
    if (!validId(library?.Id) || (folderId && !validId(folderId))) throw new Error('La carpeta de fotos no es válida.');
    stopPhotoSlideshow();
    const content = $('content');
    content.replaceChildren(title('Fotografías', 'Explora las carpetas y reproduce una secuencia de imágenes.'));
    if (libraries.length > 1) {
      const selector = el('div', { class: 'photo-library-list', role: 'group', 'aria-label': 'Bibliotecas de fotos' });
      for (const candidate of libraries) selector.append(button(candidate.Name || 'Fotos', () => renderPhotoFolder(candidate, null, [], generation, libraries), candidate.Id === library.Id ? 'active' : 'small-button'));
      content.append(selector);
    }
    const crumbs = el('div', { class: 'photo-breadcrumbs', 'aria-label': 'Ruta de carpetas' });
    crumbs.append(button(library.Name || 'Fotos', () => renderPhotoFolder(library, null, [], generation, libraries), 'small-button'));
    stack.forEach((folder, index) => {
      crumbs.append(el('span', { 'aria-hidden': 'true' }, '›'));
      crumbs.append(button(folder.name, () => renderPhotoFolder(library, folder.id, stack.slice(0, index + 1), generation, libraries), 'small-button'));
    });
    content.append(crumbs);
    const grid = el('div', { class: 'photo-grid' });
    const more = el('button', { type: 'button', class: 'secondary load-more', hidden: true }, 'Cargar más fotos');
    const count = el('p', { class: 'photo-count', role: 'status' });
    content.append(grid, count, more);
    const context = { library, parentId: folderId || library.Id, stack, libraries, generation, grid, more, count, cursor: 0, total: 0, items: [], photoIndex: 0, loading: false };
    state.photos = context;
    more.addEventListener('click', () => void busy(more, () => loadPhotoPage(context)));
    await loadPhotoPage(context);
  }
  async function loadPhotoPage(context) {
    if (context.loading || state.photos !== context || context.generation !== state.generation) return;
    context.loading = true; context.more.disabled = true; context.more.hidden = false; context.more.textContent = 'Cargando…';
    try {
      const query = new URLSearchParams({ ParentId: context.parentId, Recursive: 'false', Limit: '150', StartIndex: String(context.cursor), SortBy: 'SortName', SortOrder: 'Ascending', IncludeItemTypes: 'Photo,PhotoAlbum,Folder', Fields: 'Path', EnableUserData: 'false' });
      const result = await api(`/Users/${state.session.user.Id}/Items?${query}`);
      if (state.photos !== context || context.generation !== state.generation) return;
      const rows = Array.isArray(result?.Items) ? result.Items : [];
      context.cursor += rows.length; context.total = Number(result?.TotalRecordCount) || context.cursor;
      for (const item of rows) {
        if (!validId(item?.Id)) continue;
        if (isPhotoFolder(item)) {
          context.grid.append(el('button', { type: 'button', class: 'photo-folder', onclick: () => void busy(null, () => renderPhotoFolder(context.library, item.Id, [...context.stack, { id: item.Id, name: item.Name || 'Carpeta' }], context.generation, context.libraries)) }, el('span', { 'aria-hidden': 'true' }, '▰'), el('span', {}, item.Name || 'Carpeta')));
        } else if (isPhotoItem(item)) {
          const index = context.items.length; context.items.push(item); context.grid.append(photoCard(item, index));
        }
      }
      context.count.textContent = `${context.items.length} fotografías cargadas${context.total > context.cursor ? ' · hay más contenido en esta carpeta' : ''}`;
      context.more.hidden = context.cursor >= context.total || !rows.length;
      context.more.textContent = 'Cargar más fotos';
      if (!context.items.length && !context.grid.childElementCount) context.grid.append(empty('Esta carpeta está vacía', 'Abre otra carpeta o vuelve a la biblioteca de fotos.'));
    } finally { context.loading = false; context.more.disabled = false; }
  }
  function showPhoto() {
    const context = state.photos; const item = context?.items?.[context.photoIndex];
    if (!item || !validId(item.Id)) return;
    $('photo-slide-image').alt = item.Name || 'Fotografía';
    $('photo-slide-image').src = `/jellyfin/Items/${item.Id}/Images/Primary?maxWidth=2000&quality=90`;
    $('photo-slide-count').textContent = `${context.photoIndex + 1} de ${context.items.length}${context.cursor < context.total ? '+' : ''}`;
    $('photo-slide-title').textContent = item.Name || 'Fotografía';
  }
  function openPhoto(index) {
    const context = state.photos;
    if (!context || !context.items[index]) return;
    stopPhotoSlideshow(); context.photoIndex = index; showPhoto();
    if (!$('photos-dialog').open) $('photos-dialog').showModal();
  }
  async function movePhoto(direction) {
    const context = state.photos; if (!context?.items?.length) return;
    if (context.moving) return;
    context.moving = true;
    try {
      let next = context.photoIndex + direction;
      if (direction > 0 && next >= context.items.length && context.cursor < context.total) {
        await loadPhotoPage(context); next = context.photoIndex + 1;
      }
      if (next < 0) next = context.items.length - 1;
      if (next >= context.items.length) next = 0;
      context.photoIndex = next; showPhoto();
    } finally { context.moving = false; }
  }
  function togglePhotoSlideshow() {
    if (state.photoTimer) { stopPhotoSlideshow(); $('photo-slide-toggle').textContent = 'Iniciar secuencia'; return; }
    $('photo-slide-toggle').textContent = 'Pausar secuencia';
    state.photoTimer = setInterval(() => { void movePhoto(1); }, 4000);
  }
  async function detail(initial) {
    if (!validId(initial.Id)) throw new Error('El identificador del título no es válido.');
    const generation = ++state.detailGeneration;
    $('detail-content').replaceChildren(el('div', { class: 'loading' }, 'Cargando información…')); if (!$('detail-dialog').open) $('detail-dialog').showModal();
    try {
      const item = await api(`/jellyfin/Items/${initial.Id}?Fields=MediaSources,MediaStreams,Overview,Genres,Path`);
      if (generation !== state.detailGeneration || !state.session) return;
      const content = $('detail-content'); content.replaceChildren();
      const information = el('div', {}, el('span', { class: 'eyebrow' }, item.SeriesName || item.AlbumArtist || 'EN TU COLECCIÓN'), el('h1', {}, item.Name || 'Sin título'),
        el('div', { class: 'detail-meta' }, [item.ProductionYear, item.OfficialRating, runtime(item.RunTimeTicks)].filter(Boolean).map(value => el('span', {}, value))),
        el('div', {}, (item.Genres || []).map(genre => el('span', { class: 'genre' }, genre))), el('p', { class: 'detail-overview' }, item.Overview || 'Este título todavía no tiene sinopsis.'));
      const actions = el('div', { class: 'detail-actions' });
      if (!isContainer(item) && hasPlayableMedia(item)) actions.append(button(item.UserData?.PlaybackPositionTicks ? '▷ Continuar' : '▷ Reproducir', () => play(item), 'primary'));
      else if (!isContainer(item)) actions.append(el('span', { class: 'note' }, isTypeScriptDeclaration(item) ? 'La ruta termina en .d.ts: es una declaración de TypeScript, no un archivo de vídeo.' : 'Jellyfin no detecta una pista de vídeo o audio reproducible en este archivo.'));
      const favorite = button(item.UserData?.IsFavorite ? '♥ En favoritos' : '♡ Favorito', async () => {
        favorite.disabled = true;
        try { const data = await api(`/jellyfin/Users/${state.session.user.Id}/FavoriteItems/${item.Id}`, { method: item.UserData?.IsFavorite ? 'DELETE' : 'POST' }); item.UserData = { ...item.UserData, ...data }; favorite.textContent = item.UserData.IsFavorite ? '♥ En favoritos' : '♡ Favorito'; }
        finally { favorite.disabled = false; }
      }); actions.append(favorite);
      if (!isContainer(item)) actions.append(button(item.UserData?.Played ? '✓ Marcar no visto' : 'Marcar como visto', async () => {
        await api(`/jellyfin/Users/${state.session.user.Id}/PlayedItems/${item.Id}`, { method: item.UserData?.Played ? 'DELETE' : 'POST' }); await detail(item);
      }));
      information.append(actions); content.append(el('div', { class: 'detail-head' }, poster(item), information));
      const diagnostics = sourceDiagnostics(item); if (diagnostics) content.append(diagnostics);
      if (isContainer(item)) {
        const listing = el('div', {}, heading(item.Type === 'Series' || item.Type === 'Season' ? 'Episodios' : 'Contenido'), el('div', { class: 'loading' }, 'Cargando contenido…')); content.append(listing);
        const query = new URLSearchParams({ ParentId: item.Id, Recursive: 'true', Limit: '200', SortBy: 'ParentIndexNumber,IndexNumber,SortName', SortOrder: 'Ascending', Fields: 'MediaSources,MediaStreams,Path', EnableUserData: 'true', MediaTypes: 'Video,Audio' });
        if (['Series', 'Season'].includes(item.Type)) query.set('IncludeItemTypes', 'Episode'); else if (item.Type === 'MusicAlbum') query.set('IncludeItemTypes', 'Audio');
        const children = await api(`/jellyfin/Items?${query}`); if (generation !== state.detailGeneration) return;
        listing.replaceChildren(heading(['Series', 'Season'].includes(item.Type) ? 'Episodios' : 'Contenido'));
        const playableChildren = (children.Items || []).filter(isDisplayableItem);
        for (const child of playableChildren) listing.append(el('div', { class: 'episode' }, el('div', {}, el('span', {}, child.Name || 'Sin título'), el('small', {}, [child.ParentIndexNumber ? `Temporada ${child.ParentIndexNumber}` : '', child.IndexNumber ? `N.º ${child.IndexNumber}` : '', runtime(child.RunTimeTicks)].filter(Boolean).join(' · '))), button(isContainer(child) ? 'Abrir' : '▷ Reproducir', () => isContainer(child) ? detail(child) : play(child), 'small-button')));
        if (!playableChildren.length) listing.append(empty('Sin contenido reproducible', 'Se omiten elementos que no tienen una pista de vídeo o audio.'));
        if (children.TotalRecordCount > 200) listing.append(el('p', { class: 'note' }, 'Se muestran los primeros 200 elementos. Usa la búsqueda para localizar otros episodios o pistas.'));
      }
    } catch (error) { if (generation === state.detailGeneration && state.session) $('detail-content').replaceChildren(empty('No se pudo abrir el título', error.message)); }
  }

  function mediaUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/jellyfin/') || /[?&](?:api_?key|access_?token|token)=/i.test(value)) throw new Error('El servidor devolvió una ruta multimedia no válida.');
    const url = new URL(value, location.origin); if (url.origin !== location.origin || url.username || url.password) throw new Error('Se rechazó una fuente multimedia externa.'); return url.href;
  }
  function deviceProfile() {
    const video = $('video'); const direct = [];
    if (video.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')) direct.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' });
    for (const [mime, container, codec] of [['audio/mpeg', 'mp3', 'mp3'], ['audio/mp4; codecs="mp4a.40.2"', 'm4a,mp4', 'aac'], ['audio/flac', 'flac', 'flac'], ['audio/ogg; codecs="opus"', 'ogg,opus', 'opus']]) if (video.canPlayType(mime)) direct.push({ Container: container, Type: 'Audio', AudioCodec: codec });
    return { Name: 'JRPlex Web', MaxStreamingBitrate: $('quality').value === '4000000' ? 4000000 : 12000000, MaxStaticBitrate: 120000000, DirectPlayProfiles: direct,
      TranscodingProfiles: [{ Container: 'mp4', Type: 'Video', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2', MinSegments: 2, SegmentLength: 6, BreakOnNonKeyFrames: false }, { Container: 'mp3', Type: 'Audio', Protocol: 'http', Context: 'Streaming', AudioCodec: 'mp3', MaxAudioChannels: '2' }], CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }, { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '51', IsRequired: false }] }], SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }] };
  }
  function directCompatible(item, source) {
    const streams = source.MediaStreams || item.MediaStreams || []; const videoStream = streams.find(stream => stream.Type === 'Video'); const codec = videoStream?.Codec; const audio = streams.find(stream => stream.Type === 'Audio')?.Codec;
    if (isAudio(item)) return Boolean($('video').canPlayType({ mp3: 'audio/mpeg', aac: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg; codecs="opus"' }[audio] || ''));
    return /^(mp4|m4v)$/i.test(source.Container || '') && codec === 'h264' && (!videoStream?.BitDepth || videoStream.BitDepth <= 8) && (!audio || ['aac', 'mp3'].includes(audio)) && Boolean($('video').canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'));
  }
  async function reportPlayback(event, keepalive = false) {
    const player = state.player; if (!player?.source || !state.session) return;
    const video = $('video');
    await api(`/jellyfin/Sessions/Playing${event ? `/${event}` : ''}`, { method: 'POST', keepalive, body: { ItemId: player.item.Id, MediaSourceId: player.source.Id, PlaySessionId: player.playSessionId, PositionTicks: ticks(video.currentTime), CanSeek: true, IsPaused: video.paused, IsMuted: video.muted, VolumeLevel: Math.round(video.volume * 100), PlayMethod: player.method, EventName: event === 'Progress' ? 'TimeUpdate' : undefined } });
  }
  async function stopPlayer(report = true, cancelIntent = true) {
    if (cancelIntent) playIntent++;
    ++state.playerGeneration; const player = state.player;
    if (!player) { $('player-source-info').textContent = ''; $('player-source-info').hidden = true; if ($('player-dialog').open) $('player-dialog').close(); return; }
    clearInterval(player.timer);
    if (report && player.source) await reportPlayback('Stopped', true).catch(() => {});
    if (state.player !== player) return;
    state.player = null; player.hls?.destroy(); $('video').pause(); $('video').removeAttribute('src'); $('video').replaceChildren(); $('video').load();
    $('player-source-info').textContent = ''; $('player-source-info').hidden = true;
    if ($('player-dialog').open) $('player-dialog').close();
  }
  async function play(item, position) {
    if (isContainer(item)) return detail(item);
    if (!validId(item.Id)) throw new Error('El identificador del título no es válido.');
    if (!hasPlayableMedia(item)) throw new Error('Este archivo no tiene un formato de vídeo o audio compatible.');
    const intent = ++playIntent; await stopPlayer(true, false); if (intent !== playIntent || !state.session) return;
    $('detail-dialog').close(); const generation = ++state.playerGeneration;
    $('player-title').textContent = item.Name || 'Reproducción'; $('player-state').textContent = 'Preparando reproducción…'; $('player-error').textContent = ''; $('quality').disabled = isAudio(item);
    const initialSourceInfo = sourceDiagnosticsText(item); $('player-source-info').textContent = initialSourceInfo; $('player-source-info').hidden = !initialSourceInfo;
    if (!$('player-dialog').open) $('player-dialog').showModal();
    const player = { item, generation, pendingSeek: position ?? seconds(item.UserData?.PlaybackPositionTicks), source: null, timer: null, method: 'DirectPlay', started: false }; state.player = player;
    try {
      const direct = $('quality').value === 'direct';
      const result = await api(`/jellyfin/Items/${item.Id}/PlaybackInfo`, { method: 'POST', body: { UserId: state.session.user.Id, IsPlayback: true, AutoOpenLiveStream: false, StartTimeTicks: 0, MaxStreamingBitrate: $('quality').value === '4000000' ? 4000000 : 12000000, EnableDirectPlay: true, EnableDirectStream: !direct, EnableTranscoding: !direct, DeviceProfile: deviceProfile() } });
      if (generation !== state.playerGeneration || !state.session) return;
      if (result.ErrorCode) throw new Error('El servidor no puede preparar este formato para tu navegador.');
      const sources = (result.MediaSources || []).filter(source => !source.RequiresOpening && !source.RequiresClosing);
      const source = sources.find(candidate => candidate.SupportsDirectPlay && directCompatible(item, candidate)) || sources.find(candidate => candidate.TranscodingUrl) || sources[0];
      if (!source) throw new Error('No hay una fuente reproducible disponible.');
      const selectedSourceInfo = sourceDiagnosticsText(item, source); $('player-source-info').textContent = selectedSourceInfo; $('player-source-info').hidden = !selectedSourceInfo;
      let url;
      if ((direct || source.SupportsDirectPlay) && directCompatible(item, source)) url = source.DirectStreamUrl || `/jellyfin/${isAudio(item) ? 'Audio' : 'Videos'}/${item.Id}/stream${isAudio(item) ? '' : '.mp4'}?Static=true&MediaSourceId=${encodeURIComponent(source.Id)}`;
      else if (!direct && source.TranscodingUrl) { url = source.TranscodingUrl; player.method = 'Transcode'; }
      else if (!direct && source.SupportsDirectStream && source.DirectStreamUrl) { url = source.DirectStreamUrl; player.method = 'DirectStream'; }
      else throw new Error('El archivo original no es compatible con este navegador. Selecciona calidad automática para transcodificarlo.');
      const src = mediaUrl(url); player.source = source; player.playSessionId = result.PlaySessionId;
      for (const subtitle of source.MediaStreams || []) if (subtitle.Type === 'Subtitle' && subtitle.IsExternal && Number.isInteger(subtitle.Index) && subtitle.Index >= 0 && ['webvtt', 'vtt'].includes(String(subtitle.Codec).toLowerCase())) {
        const track = el('track', { kind: 'subtitles', label: subtitle.DisplayTitle || subtitle.Language || 'Subtítulos', srclang: /^[a-z]{2,3}$/i.test(subtitle.Language || '') ? subtitle.Language : 'und', default: subtitle.Index === source.DefaultSubtitleStreamIndex });
        track.src = `/jellyfin/Videos/${item.Id}/${encodeURIComponent(source.Id)}/Subtitles/${Number(subtitle.Index)}/Stream.vtt`; $('video').append(track);
      }
      const hls = /\.m3u8(?:[?#]|$)/i.test(src);
      if (hls && !$('video').canPlayType('application/vnd.apple.mpegurl')) {
        if (!window.Hls?.isSupported()) throw new Error('Este navegador no admite la reproducción HLS requerida.');
        const engine = new window.Hls({ startPosition: player.pendingSeek || -1 }); player.hls = engine;
        engine.on(window.Hls.Events.ERROR, (_event, data) => { if (state.player !== player) return; if (data.response?.code === 401) { showLogin('La sesión ha terminado. Vuelve a entrar.'); return; } if (data.fatal) { $('player-error').textContent = 'La reproducción se ha interrumpido. Vuelve a abrir el título o prueba otra calidad.'; engine.destroy(); } });
        engine.loadSource(src); engine.attachMedia($('video'));
      } else $('video').src = src;
      $('player-state').textContent = player.method === 'Transcode' ? 'Adaptando el vídeo para tu navegador' : player.method === 'DirectStream' ? 'Reproducción adaptada' : 'Reproducción directa';
      await $('video').play().catch(() => { if (state.player === player) $('player-state').textContent = 'Pulsa reproducir para empezar.'; });
      if (generation !== state.playerGeneration || state.player !== player) return;
      player.timer = setInterval(() => { if (state.player === player && !document.hidden) void reportPlayback('Progress').catch(() => {}); }, 10000);
    } catch (error) { if (generation === state.playerGeneration && state.session) { $('player-error').textContent = error.message; $('player-state').textContent = 'No se pudo iniciar la reproducción.'; } }
  }

  function inputField(form, label, options = {}) {
    const id = `field-${Math.random().toString(36).slice(2)}`; const { tag = 'input', ...properties } = options; const input = el(tag, { id, ...properties }); form.append(el('label', { htmlFor: id }, label), input); return input;
  }
  function panel(name, ...children) { return el('section', { class: 'panel' }, el('h2', {}, name), ...children); }
  async function renderAdmin(generation) {
    const content = $('content'); content.replaceChildren(title('Administración', 'Tu servidor, tus usuarios y tus bibliotecas.'));
    const tabs = el('div', { class: 'admin-tabs', role: 'tablist', 'aria-label': 'Administración' });
    for (const [key, name] of [['users', 'Usuarios'], ['libraries', 'Bibliotecas y nube'], ['torrents', 'Descargas'], ['system', 'Sistema']]) {
      const tab = button(name, async () => { state.adminTab = key; await navigate('admin'); }, state.adminTab === key ? 'active' : ''); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.adminTab === key)); tabs.append(tab);
    }
    const body = el('div', { role: 'tabpanel' }); content.append(tabs, body);
    if (state.adminTab === 'users') await adminUsers(body, generation);
    if (state.adminTab === 'libraries') await adminLibraries(body, generation);
    if (state.adminTab === 'torrents') await adminTorrents(body, generation);
    if (state.adminTab === 'system') await adminSystem(body, generation);
  }
  async function adminUsers(body, generation) {
    const [users, libraries] = await Promise.all([api('/jellyfin/Users'), api('/jellyfin/Library/VirtualFolders')]); if (generation !== state.generation) return;
    const listing = panel('Usuarios autorizados');
    for (const user of users || []) {
      const policy = user.Policy || {}; const row = el('div', { class: 'list-row' }, el('div', { class: 'row-copy' }, user.Name || 'Usuario', el('small', {}, policy.IsAdministrator ? 'Administrador' : policy.EnableAllFolders ? 'Acceso a todas las bibliotecas' : `${policy.EnabledFolders?.length || 0} bibliotecas autorizadas`)), el('span', { class: `pill${policy.IsDisabled ? ' off' : ''}` }, policy.IsDisabled ? 'Desactivado' : 'Activo'));
      if (!policy.IsAdministrator) row.append(button(policy.IsDisabled ? 'Activar' : 'Revocar', async () => { await api(`/jellyfin/Users/${user.Id}/Policy`, { method: 'POST', body: { ...policy, IsDisabled: !policy.IsDisabled } }); notify('Permisos actualizados.'); await navigate('admin'); }, 'small-button'));
      listing.append(row);
    }
    const form = el('form', { class: 'stack' }); const name = inputField(form, 'Nombre de usuario', { required: true, maxLength: 64, autoComplete: 'off' });
    const password = inputField(form, 'Contraseña única · mínimo 16 caracteres', { type: 'password', required: true, minLength: 16, maxLength: 256, autoComplete: 'new-password' });
    const all = el('input', { type: 'checkbox' }); form.append(el('label', { class: 'checkbox-row' }, all, 'Autorizar todas las bibliotecas'));
    const choices = []; for (const library of libraries || []) { const checkbox = el('input', { type: 'checkbox', value: library.ItemId }); choices.push(checkbox); form.append(el('label', { class: 'checkbox-row' }, checkbox, library.Name || 'Biblioteca')); }
    all.addEventListener('change', () => choices.forEach(choice => { choice.disabled = all.checked; }));
    const errorBox = el('p', { class: 'form-error', role: 'alert' }); const submit = el('button', { type: 'submit', class: 'primary' }, 'Crear usuario autorizado'); form.append(errorBox, submit);
    form.addEventListener('submit', event => { event.preventDefault(); void busy(submit, async () => {
      errorBox.textContent = ''; if (password.value.length < 16) throw new Error('La contraseña debe tener al menos 16 caracteres.');
      const folders = choices.filter(choice => choice.checked).map(choice => choice.value).filter(validId);
      if (!all.checked && !folders.length) throw new Error('Selecciona al menos una biblioteca o autoriza todas explícitamente.');
      let user;
      try {
        user = await api('/jellyfin/Users/New', { method: 'POST', body: { Name: name.value.trim(), Password: password.value } }); password.value = '';
        await api(`/jellyfin/Users/${user.Id}/Policy`, { method: 'POST', body: { ...user.Policy, IsAdministrator: false, IsHidden: true, IsDisabled: false, EnableMediaPlayback: true, EnableContentDeletion: false, EnableContentDownloading: false, EnableAllFolders: all.checked, EnabledFolders: all.checked ? [] : folders } });
        notify('Usuario creado con sus bibliotecas autorizadas.'); await navigate('admin');
      } catch (error) {
        password.value = '';
        if (validId(user?.Id)) {
          try { await api(`/jellyfin/Users/${user.Id}/Policy`, { method: 'POST', body: { ...user.Policy, IsAdministrator: false, IsHidden: true, IsDisabled: true, EnableAllFolders: false, EnabledFolders: [] } }); error.message = 'No se pudieron asignar los permisos. La cuenta creada quedó desactivada.'; }
          catch { try { await api(`/jellyfin/Users/${user.Id}`, { method: 'DELETE' }); error.message = 'No se pudieron asignar los permisos. La cuenta incompleta se eliminó.'; } catch { error.message = 'No se pudo asegurar la cuenta incompleta. Revoca su acceso desde el servidor antes de compartir sus credenciales.'; } }
        }
        errorBox.textContent = error.message; throw error;
      }
    }); });
    body.append(el('div', { class: 'admin-grid' }, listing, panel('Crear usuario', el('p', {}, 'Las cuentas nuevas son de reproducción y no tienen acceso administrativo. Comparte la contraseña por un medio privado después de confirmar sus permisos.'), form)));
  }
  async function adminLibraries(body, generation) {
    const libraries = await api('/jellyfin/Library/VirtualFolders'); if (generation !== state.generation) return;
    const listing = panel('Bibliotecas del servidor');
    for (const library of libraries || []) listing.append(el('div', { class: 'list-row' }, el('div', { class: 'row-copy' }, library.Name || 'Biblioteca', el('small', {}, (library.Locations || []).join(' · ') || 'Sin ruta declarada')), el('span', { class: 'pill' }, 'Configurada')));
    if (!libraries?.length) listing.append(el('p', {}, 'Todavía no hay bibliotecas configuradas.'));
    listing.append(button('Buscar contenido nuevo', async () => { await api('/jellyfin/Library/Refresh', { method: 'POST' }); notify('Exploración solicitada al servidor.'); }, 'small-button'));
    const form = el('form', { class: 'stack' }); const name = inputField(form, 'Nombre de la biblioteca', { required: true, maxLength: 80 });
    const type = inputField(form, 'Contenido', { tag: 'select' }); for (const [value, label] of [['movies', 'Películas'], ['tvshows', 'Series'], ['music', 'Música'], ['photos', 'Fotografías'], ['homevideos', 'Vídeos personales'], ['', 'Contenido mixto']]) type.append(el('option', { value }, label));
    const path = inputField(form, 'Ruta absoluta que ve el servidor', { required: true, maxLength: 1024, placeholder: '/media/local/peliculas' });
    const picker = el('section', { class: 'folder-picker', 'aria-label': 'Explorador de carpetas disponibles' });
    const source = el('select', { 'aria-label': 'Origen' }, el('option', { value: 'local' }, 'Disco local'), el('option', { value: 'cloud' }, 'Google Drive'));
    const folderSearch = el('input', { type: 'search', maxLength: 160, placeholder: 'Filtrar carpetas', 'aria-label': 'Filtrar carpetas' });
    const folderList = el('div', { class: 'folder-picker-list' }); const folderStatus = el('p', { class: 'note', role: 'status' });
    const useFolder = el('button', { type: 'button', class: 'small-button' }, 'Usar esta carpeta');
    let currentRelative = ''; let currentAbsolute = '';
    const loadFolders = async () => {
      const query = new URLSearchParams({ source: source.value, path: currentRelative, search: folderSearch.value.trim() });
      const listing = await api(`/api/admin/folders?${query}`); currentAbsolute = listing.currentPath;
      folderStatus.textContent = `Carpeta actual: ${currentAbsolute}`;
      folderList.replaceChildren();
      const parent = currentRelative.split('/').filter(Boolean).slice(0, -1).join('/');
      if (currentRelative) folderList.append(button('↑ Carpeta superior', async () => { currentRelative = parent; await loadFolders(); }, 'small-button'));
      for (const folder of listing.folders || []) folderList.append(button(`▰ ${folder}`, async () => { currentRelative = currentRelative ? `${currentRelative}/${folder}` : folder; await loadFolders(); }, 'small-button'));
      if (!listing.folders?.length) folderList.append(el('span', { class: 'note' }, 'No hay subcarpetas que coincidan.'));
    };
    source.addEventListener('change', () => { currentRelative = ''; void busy(null, loadFolders); });
    folderSearch.addEventListener('change', () => void busy(null, loadFolders));
    useFolder.addEventListener('click', () => { path.value = currentAbsolute; path.focus(); notify('Ruta seleccionada para la biblioteca.'); });
    picker.append(el('h3', {}, 'Elegir una carpeta'), el('p', { class: 'note' }, 'El selector solo muestra carpetas legibles bajo las raíces montadas en el servidor.'), source, folderSearch, folderStatus, folderList, useFolder);
    void busy(null, loadFolders);
    form.append(picker);
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Conectar biblioteca'); form.append(submit);
    form.addEventListener('submit', event => { event.preventDefault(); void busy(submit, async () => {
      const value = path.value.trim(); if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) throw new Error('Introduce una ruta absoluta accesible por Jellyfin.');
      const query = new URLSearchParams({ name: name.value.trim(), refreshLibrary: 'true' }); if (type.value) query.set('collectionType', type.value);
      await api(`/jellyfin/Library/VirtualFolders?${query}`, { method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: value }], EnableRealtimeMonitor: false, SaveLocalMetadata: false } } });
      notify('Biblioteca añadida. El contenido aparecerá tras la exploración.'); await navigate('admin');
    }); });
    const cloudRoot = '/media/cloud';
    const cloudRegistered = (libraries || []).some(library => (library.Locations || []).some(location => location === cloudRoot || location.startsWith(`${cloudRoot}/`)));
    const cloudPhotosRegistered = (libraries || []).some(library => String(library.CollectionType || '').toLowerCase() === 'photos' && (library.Locations || []).some(location => location === cloudRoot || location.startsWith(`${cloudRoot}/`)));
    const driveStatus = await api('/api/admin/google-drive/status');
    const connectDrive = button(driveStatus.linked ? 'Volver a vincular Google Drive' : 'Vincular Google Drive', async () => {
      const result = await api('/api/admin/google-drive/connect', { method: 'POST', body: {} });
      const destination = new URL(result?.url || '');
      if (destination.protocol !== 'https:' || destination.hostname !== 'accounts.google.com') throw new Error('Google devolvió una dirección de autorización no válida.');
      window.location.assign(destination.href);
    }, 'primary');
    connectDrive.disabled = !driveStatus.configured;
    const prepareCloud = button('Preparar ruta /media/cloud', () => {
      name.value = 'Google Drive'; type.value = 'movies'; path.value = cloudRoot; path.focus();
      notify('Ruta preparada. Conecta la biblioteca cuando el montaje de solo lectura esté activo.');
    }, 'small-button');
    const preparePhotos = button(cloudPhotosRegistered ? 'Buscar fotos nuevas' : 'Preparar fotos de Google Drive', async () => {
      if (!cloudPhotosRegistered) {
        const query = new URLSearchParams({ name: 'Fotos de Google Drive', collectionType: 'photos', refreshLibrary: 'true' });
        await api(`/jellyfin/Library/VirtualFolders?${query}`, { method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: cloudRoot }], EnablePhotos: true, EnableRealtimeMonitor: false, SaveLocalMetadata: false } } });
      } else await api('/jellyfin/Library/Refresh', { method: 'POST' });
      notify('Exploración de fotos solicitada. Las carpetas aparecerán cuando Jellyfin termine de indexarlas.');
      await navigate('admin');
    }, 'primary');
    const cloud = panel('Contenido en la nube',
      el('p', { class: 'note' }, 'Vincula Google desde su página oficial. JRPlex nunca solicita tu contraseña; guarda la autorización cifrada en el servidor. El montaje de rclone debe permanecer en solo lectura y se verifica por separado antes de compartir la biblioteca.'),
      el('div', { class: 'cloud-state' },
        el('span', { class: `pill${driveStatus.linked ? ' cloud-configured' : ''}` }, driveStatus.linked ? 'Cuenta Google vinculada' : 'Cuenta Google sin vincular'),
        el('span', { class: `pill${cloudRegistered ? ' cloud-configured' : ''}` }, cloudRegistered ? 'Ruta registrada' : 'Ruta sin registrar'),
        el('span', { class: `pill${driveStatus.mountVerified ? ' cloud-configured' : ' cloud-pending'}` }, driveStatus.mountVerified ? 'Montaje rclone de solo lectura activo' : 'Montaje no verificado'),
        el('span', { class: 'pill cloud-pending' }, 'Reproducción por verificar'),
        el('span', {}, driveStatus.mountVerified ? 'Drive está montado en solo lectura; comprueba la reproducción de un vídeo real antes de compartirlo.' : cloudRegistered ? 'La ruta aparece en el catálogo, pero eso no confirma que Drive esté montado ni que un vídeo se pueda reproducir.' : 'La ruta guardada no demuestra que Drive esté montado ni que un archivo se pueda reproducir.')),
      !driveStatus.configured ? el('p', { class: 'note' }, 'El servidor aún no tiene listo el cliente de Google, su clave privada y el almacenamiento cifrado.') : null,
      connectDrive,
      el('p', { class: 'note' }, 'Aviso de privacidad: para mostrar y reproducir el contenido, JRPlex lee los nombres, metadatos y archivos visibles en el Drive vinculado. La autorización se limita a lectura; el servidor conserva los tokens cifrados. ', el('a', { href: '/privacy' }, 'Consulta cómo se usan, protegen y eliminan estos datos.')),
      el('p', { class: 'note' }, 'Se solicita solo lectura. Usa una cuenta de Google dedicada que tenga acceso únicamente a tus medios; el permiso cubre los archivos visibles para esa cuenta.'),
      prepareCloud,
      el('p', { class: 'note' }, cloudPhotosRegistered ? 'La biblioteca de fotos de Drive ya está registrada.' : 'Añade una biblioteca independiente de tipo Fotografías para recorrer carpetas y ver presentaciones; no reemplaza la biblioteca de películas.'),
      preparePhotos);
    body.append(el('div', { class: 'admin-grid' }, listing, panel('Conectar una carpeta', form)), cloud);
  }
  async function adminTorrents(body, generation) {
    const form = el('form', { class: 'stack' }); const magnet = inputField(form, 'Enlace magnet', { placeholder: 'magnet:?xt=urn:btih:…', maxLength: 8192 });
    const file = inputField(form, 'O archivo .torrent · máximo 1 MiB', { type: 'file', accept: '.torrent,application/x-bittorrent' }); const submit = el('button', { type: 'submit', class: 'primary' }, 'Buscar vídeo en el torrent'); form.append(submit);
    const list = panel('Vídeos disponibles', el('p', {}, 'Añade un enlace para ver sus vídeos reproducibles.')); const playerArea = el('div', {});
    body.append(panel('Reproducir desde torrent', el('p', { class: 'note' }, 'El vídeo empieza mientras llegan sus piezas; no se espera a que termine la descarga ni se agrega a tu biblioteca. JRPlex usa una caché temporal de piezas y la borra al detener la reproducción o cuando la sesión queda inactiva.'), form), list, playerArea);
    const stopPlayback = async (id, video, stopFn) => {
      if (state.torrentStop !== stopFn) return;
      state.torrentStop = null; video.pause(); video.removeAttribute('src'); video.load(); playerArea.replaceChildren();
      try { await api(`/api/admin/torrents/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }); } catch {}
      notify('Reproducción detenida; la caché temporal del torrent se eliminó.');
    };
    const showSession = async (session) => {
      const files = (session.files || []).filter(item => Number.isSafeInteger(item.index) && Number(item.size) > 0);
      const section = el('section', { class: 'panel torrent-session' }, el('h3', {}, session.name || 'Torrent'));
      if (!files.length) section.append(el('p', {}, 'El torrent no tiene archivos de vídeo compatibles.'));
      for (const item of files) {
        const label = `${item.name} · ${formatBytes(item.size)}`;
        const playButton = button('▷ Reproducir', async () => { await busy(playButton, async () => {
          const result = await api(`/api/admin/torrents/${encodeURIComponent(session.id)}/play`, { method: 'POST', body: { fileIndex: item.index } });
          playerArea.replaceChildren();
          const video = el('video', { class: 'torrent-video', controls: true, playsInline: true, preload: 'auto' }); video.src = result.streamUrl;
          const playbackStatus = el('p', { class: 'note', role: 'status' }, 'Esperando las primeras piezas verificadas del torrent…');
          const stop = () => stopPlayback(session.id, video, stop); state.torrentStop = stop;
          video.addEventListener('ended', () => void stop());
          video.addEventListener('waiting', () => { playbackStatus.textContent = 'Esperando más piezas del torrent para mantener la reproducción…'; });
          video.addEventListener('playing', () => { playbackStatus.textContent = 'Reproduciendo desde el torrent; JRPlex convierte el formato si el navegador lo necesita.'; });
          video.addEventListener('stalled', () => { playbackStatus.textContent = 'La fuente dejó de enviar datos. Puede que el torrent no tenga pares activos.'; });
          video.addEventListener('error', () => {
            const code = video.error?.code;
            playbackStatus.textContent = code === 4 ? 'El navegador no reconoce el formato de salida. Revisa el nombre y formato del archivo.' : 'La fuente de torrent no entregó datos reproducibles. Comprueba que tenga pares activos.';
            notify(playbackStatus.textContent, true);
          });
          playerArea.append(panel('Reproductor temporal', playbackStatus, el('p', { class: 'note' }, 'Se lee por piezas desde el torrent; los formatos no compatibles con el navegador se convierten en el servidor. Pulsa “Detener” al terminar para borrar el búfer.'), video, button('Detener y borrar búfer', stop, 'small-button')));
          try { await video.play(); } catch { playbackStatus.textContent = 'Pulsa reproducir en el control de vídeo para iniciar la transmisión.'; }
        }); });
        section.append(el('div', { class: 'list-row' }, el('div', { class: 'row-copy' }, label, el('small', {}, `${Math.round(Math.max(0, Math.min(1, Number(item.progress) || 0)) * 100)} % de piezas disponibles en caché`)), playButton));
      }
      section.append(button('Quitar enlace y borrar piezas', async () => { await api(`/api/admin/torrents/${encodeURIComponent(session.id)}`, { method: 'DELETE', body: {} }); await refresh(); notify('Torrent y caché temporal eliminados.'); }, 'small-button'));
      return section;
    };
    const refresh = async () => {
      try {
        const result = await api('/api/admin/torrents'); if (generation !== state.generation) return;
        list.replaceChildren(el('h2', {}, 'Vídeos disponibles'));
        for (const session of result.torrents || []) list.append(await showSession(session));
        if (!result.torrents?.length) list.append(el('p', {}, 'Aún no hay enlaces listos para reproducir.'));
      } catch (error) { if (generation === state.generation && state.session) list.replaceChildren(el('h2', {}, 'Servicio de descargas'), el('p', { class: 'form-error' }, error.message)); }
    };
    form.addEventListener('submit', event => { event.preventDefault(); void busy(submit, async () => {
      const selected = file.files[0]; if (Boolean(selected) === Boolean(magnet.value.trim())) throw new Error('Introduce un magnet o elige un archivo, solo uno a la vez.');
      let payload;
      if (selected) {
        if (selected.size > 1024 * 1024 || !/\.torrent$/i.test(selected.name)) throw new Error('Elige un archivo .torrent de hasta 1 MiB.');
        const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('No se pudo leer el archivo.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(selected); });
        payload = { torrentBase64: encoded, filename: selected.name };
      } else { if (!magnet.value.trim().startsWith('magnet:?')) throw new Error('Se necesita un enlace magnet válido; las URL remotas .torrent no están habilitadas.'); payload = { url: magnet.value.trim() }; }
      await api('/api/admin/torrents', { method: 'POST', body: payload }); form.reset(); notify('Torrent listo. Elige el vídeo que quieres reproducir.'); await refresh();
    }); });
    await refresh();
  }
  async function adminSystem(body, generation) {
    const result = await api('/api/admin/status'); if (generation !== state.generation) return;
    const statuses = panel('Estado comprobado');
    const torrentState = result.torrent?.available ? 'Disponible' : result.torrent?.configured ? 'Sin conexión' : 'Sin configurar';
    for (const [name, available, detail, label] of [['Servidor multimedia', result.jellyfin?.available, 'Conexión autenticada con Jellyfin', result.jellyfin?.available ? 'Disponible' : 'No disponible'], ['Servicio de descargas', result.torrent?.available, result.torrent?.message || 'Comprueba la configuración del servidor.', torrentState]]) statuses.append(el('div', { class: 'list-row' }, el('div', { class: 'row-copy' }, name, el('small', {}, detail)), el('span', { class: `pill${available ? '' : ' off'}` }, label)));
    body.append(statuses, panel('Comprobaciones del servidor', el('p', { class: 'note' }, 'El estado de conexión no verifica todos los discos, montajes de nube, formatos ni descargas. Comprueba un archivo real de cada biblioteca y realiza una prueba de restauración de tu copia de seguridad.'), el('p', {}, 'JRPlex 0.1 · Web privada sobre Jellyfin. La sesión se cierra al reiniciar el gateway. Las credenciales de almacenamiento se administran en el servidor.')));
  }

  $('login-form').addEventListener('submit', event => { event.preventDefault(); const submit = $('login-form').querySelector('button[type="submit"]'); void busy(submit, async () => {
    $('login-error').textContent = '';
    try { const session = await api('/api/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } }); $('password').value = ''; await signedIn(session); }
    catch (error) { $('password').value = ''; $('login-error').textContent = error.status === 401 ? 'Usuario o contraseña incorrectos.' : error.message; }
  }); });
  $('logout').addEventListener('click', () => void busy($('logout'), async () => { await stopPlayer(); await api('/api/logout', { method: 'POST' }); showLogin(); }));
  $('change-password').addEventListener('click', () => { $('password-form').reset(); $('password-error').textContent = ''; $('password-dialog').showModal(); });
  $('password-dialog').querySelector('.close-password').addEventListener('click', () => { $('password-form').reset(); $('password-dialog').close(); });
  $('password-dialog').addEventListener('cancel', () => $('password-form').reset());
  $('password-form').addEventListener('submit', event => {
    event.preventDefault(); const submit = $('password-form').querySelector('button[type="submit"]');
    void busy(submit, async () => {
      $('password-error').textContent = '';
      if ($('new-password').value.length < 16 || new Set($('new-password').value).size < 8) { $('password-error').textContent = 'Usa al menos 16 caracteres y 8 caracteres diferentes.'; return; }
      if ($('new-password').value !== $('confirm-password').value) { $('password-error').textContent = 'Las contraseñas nuevas no coinciden.'; return; }
      try {
        await api('/api/password', { method: 'POST', body: { currentPassword: $('current-password').value, newPassword: $('new-password').value } });
        showLogin('Contraseña actualizada. Entra de nuevo con tu nueva contraseña.');
      } catch (error) { if (state.session) $('password-error').textContent = error.message; }
      finally { $('password-form').reset(); }
    });
  });
  for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => { state.search = ''; $('search-input').value = ''; void navigate(node.dataset.view); });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); state.search = $('search-input').value.trim(); void navigate(['admin', 'photos'].includes(state.view) ? 'home' : state.view); });
  $('detail-dialog').querySelector('.close-dialog').addEventListener('click', () => { state.detailGeneration++; $('detail-dialog').close(); });
  $('detail-dialog').addEventListener('cancel', () => { state.detailGeneration++; });
  $('close-photos').addEventListener('click', () => $('photos-dialog').close());
  $('photos-dialog').addEventListener('cancel', stopPhotoSlideshow);
  $('photos-dialog').addEventListener('close', () => { stopPhotoSlideshow(); $('photo-slide-toggle').textContent = 'Iniciar secuencia'; $('photo-slide-image').removeAttribute('src'); });
  $('photo-slide-prev').addEventListener('click', () => void busy(null, () => movePhoto(-1)));
  $('photo-slide-next').addEventListener('click', () => void busy(null, () => movePhoto(1)));
  $('photo-slide-toggle').addEventListener('click', togglePhotoSlideshow);
  $('close-player').addEventListener('click', () => void stopPlayer());
  $('player-dialog').addEventListener('cancel', event => { event.preventDefault(); void stopPlayer(); });
  $('quality').addEventListener('change', () => { if (state.player) { const { item } = state.player; const position = $('video').currentTime; void play(item, position); } });
  $('video').addEventListener('loadedmetadata', () => { const player = state.player; if (!player) return; if (player.pendingSeek > 0 && Number.isFinite($('video').duration)) { $('video').currentTime = Math.min(player.pendingSeek, Math.max(0, $('video').duration - 0.1)); player.pendingSeek = 0; } });
  $('video').addEventListener('playing', () => { const player = state.player; if (!player) return; $('player-error').textContent = ''; if (!player.started) { player.started = true; void reportPlayback('').catch(() => {}); } });
  $('video').addEventListener('pause', () => { if (state.player?.started) void reportPlayback('Progress').catch(() => {}); });
  $('video').addEventListener('ended', () => { if (state.player) void stopPlayer(); });
  $('video').addEventListener('error', () => {
    const player = state.player; if (!player?.source) return;
    const code = $('video').error?.code; const reasons = { 1: 'reproducción interrumpida', 2: 'falló la transferencia de datos', 3: 'el navegador no pudo decodificar la fuente', 4: 'el formato o la URL de la fuente no es compatible' };
    $('player-error').textContent = `No se pudo reproducir el archivo${code ? ` (código multimedia ${code}: ${reasons[code] || 'error del navegador'})` : ''}. Prueba calidad automática o revisa la fuente.`;
    const sourceInfo = sourceDiagnosticsText(player.item, player.source); if (sourceInfo) { $('player-source-info').textContent = sourceInfo; $('player-source-info').hidden = false; }
    void api('/api/session').catch(() => {});
  });
  window.addEventListener('pagehide', () => { if (state.player?.source) void reportPlayback('Stopped', true).catch(() => {}); stopPolling(); });
  void (async () => {
    try {
      await signedIn(await api('/api/session'));
      if (cloudReturn === 'google-linked') notify('Google Drive quedó vinculado. El montaje de solo lectura y la reproducción aún deben verificarse.');
      else if (cloudReturn === 'google-cancelled') notify('No se completó la autorización de Google.', true);
      else if (cloudReturn === 'google-error') notify('Google no pudo completar el vínculo. Comprueba el cliente OAuth del servidor e inténtalo otra vez.', true);
    } catch (error) { if (error.status !== 401) showLogin(error.message); else showLogin(); }
  })();
})();
