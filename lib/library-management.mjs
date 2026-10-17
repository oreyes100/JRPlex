import { HttpError } from './security.mjs';
import { mediaFolderPath } from './library-mapping.mjs';
import { startLibraryScan } from './library-scan.mjs';

const TYPES = new Set(['movies', 'tvshows', 'music', 'photos', 'homevideos', '']);

function libraryType(library) {
  if (library.LibraryOptions?.EnablePhotos === true) return 'photos';
  return typeof library.CollectionType === 'string' ? library.CollectionType : '';
}

function normalizedLocations(library) {
  if (!Array.isArray(library.Locations)) return null;
  try { return library.Locations.map(mediaFolderPath).sort((a, b) => a.localeCompare(b)); }
  catch { return null; }
}

async function readLibraries({ session, upstream, jsonResponse }) {
  const response = await upstream('/Library/VirtualFolders', { session });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'No se pudieron leer las bibliotecas.'); }
  const rows = await jsonResponse(response);
  if (!Array.isArray(rows)) throw new HttpError(502, 'Lista de bibliotecas no válida.');
  return rows;
}

function overlaps(left, right) { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }

function operationKey(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const match = url.origin === 'https://drive.google.com' && url.pathname.match(/^\/drive\/folders\/([A-Za-z0-9_-]{10,200})\/?$/);
    if (match && !url.username && !url.password && !url.hash) return `drive:${match[1]}`;
  } catch {}
  return value.trim();
}

export async function createLibrary({ input, session, upstream, jsonResponse, resolvePath, operations }) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'Escribe un nombre válido para la biblioteca.');
  if (typeof input.collectionType !== 'string' || !TYPES.has(input.collectionType)) throw new HttpError(400, 'El tipo de contenido seleccionado no es válido.');
  const collectionType = input.collectionType === 'photos' ? 'homevideos' : input.collectionType;
  const photoScan = input.collectionType === 'photos';
  const requestedPath = typeof input.path === 'string' ? input.path.trim() : '';
  const requestedKey = operationKey(requestedPath);
  if (operations.has(requestedKey)) throw new HttpError(409, 'Esta carpeta ya se está agregando. Espera a que termine antes de volver a intentarlo.');
  operations.add(requestedKey);
  let path;
  try {
    path = mediaFolderPath(await resolvePath(requestedPath));
    if (path !== requestedKey) {
      if (operations.has(path)) throw new HttpError(409, 'Esta carpeta ya se está agregando. Espera a que termine antes de volver a intentarlo.');
      operations.add(path);
    }
    const rows = await readLibraries({ session, upstream, jsonResponse });
    const exact = rows.filter(row => normalizedLocations(row)?.length === 1 && normalizedLocations(row)[0] === path);
    const existing = exact.find(row => libraryType(row) === (photoScan ? 'photos' : collectionType));
    const scan = async () => {
      try { return await startLibraryScan({ session, upstream, jsonResponse }); }
      catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { scanRequested: false, scanError: error.message };
      }
    };
    if (existing) {
      return { id: existing.ItemId, name: existing.Name, path, created: false, ...await scan() };
    }
    if (exact.length) throw new HttpError(409, 'Esta carpeta ya está asignada a otra clase de biblioteca. Revisa el mapeo existente antes de volver a agregarla.');
    if (rows.some(row => row.Name?.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new HttpError(409, 'Ya existe una biblioteca con ese nombre. Cambia el nombre o actualiza su carpeta.');
    if (rows.some(row => (normalizedLocations(row) || []).some(location => overlaps(path, location)))) throw new HttpError(409, 'Esta carpeta se superpone con otra biblioteca. Elige una carpeta separada para evitar rutas duplicadas en Jellyfin.');

    const check = await upstream('/Environment/DirectoryContents?' + new URLSearchParams({ path, includeFiles: 'false', includeDirectories: 'true' }), { session });
    await check.body?.cancel();
    if (!check.ok) throw new HttpError(400, 'Jellyfin no puede leer la carpeta elegida.');

    const query = new URLSearchParams({ name, refreshLibrary: 'false' });
    if (collectionType) query.set('collectionType', collectionType);
    const response = await upstream(`/Library/VirtualFolders?${query}`, {
      session, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: path }], ...(photoScan ? { EnablePhotos: true } : {}), EnableRealtimeMonitor: false, SaveLocalMetadata: false } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(response.status === 409 ? 409 : 502, 'Jellyfin no pudo crear la biblioteca. Revisa su estado y vuelve a intentarlo.');

    // A media scan can take longer than the browser request. Queue it separately
    // so a retry immediately sees the committed library and never creates a twin.
    return { name, path, created: true, ...await scan() };
  } finally { operations.delete(requestedKey); if (path && path !== requestedKey) operations.delete(path); }
}

export async function removeDuplicateLibrary({ id, session, upstream, jsonResponse }) {
  const rows = await readLibraries({ session, upstream, jsonResponse });
  const library = rows.find(row => row.ItemId === id);
  if (!library) throw new HttpError(404, 'La biblioteca ya no existe.');
  const locations = normalizedLocations(library);
  const type = libraryType(library);
  const hasTwin = locations?.length && type && rows.some(row => row.ItemId !== id && libraryType(row) === type && JSON.stringify(normalizedLocations(row)) === JSON.stringify(locations));
  if (!hasTwin) throw new HttpError(409, 'Solo se puede quitar una biblioteca cuando otra tiene exactamente la misma carpeta y tipo de contenido.');
  if (rows.filter(row => row.Name === library.Name).length !== 1) throw new HttpError(409, 'Jellyfin tiene nombres de biblioteca repetidos y no permite quitar esta configuración con seguridad. Renombra una biblioteca primero.');

  // Jellyfin removes virtual folders by name rather than ItemId. Re-read just
  // before the call so a concurrent change cannot silently retarget that name.
  const latestRows = await readLibraries({ session, upstream, jsonResponse });
  const latest = latestRows.find(row => row.ItemId === id);
  const latestLocations = latest && normalizedLocations(latest);
  const latestHasTwin = latest && latestLocations?.length && libraryType(latest) === type && latestRows.some(row => row.ItemId !== id && libraryType(row) === type && JSON.stringify(normalizedLocations(row)) === JSON.stringify(latestLocations));
  if (!latest || latest.Name !== library.Name || libraryType(latest) !== type || JSON.stringify(latestLocations) !== JSON.stringify(locations) || !latestHasTwin) throw new HttpError(409, 'La biblioteca cambió durante la revisión. Recarga la lista antes de volver a intentarlo.');
  if (latestRows.filter(row => row.Name === latest.Name).length !== 1) throw new HttpError(409, 'Jellyfin tiene nombres de biblioteca repetidos y no permite quitar esta configuración con seguridad. Renombra una biblioteca primero.');

  const query = new URLSearchParams({ name: latest.Name, refreshLibrary: 'false' });
  const response = await upstream(`/Library/VirtualFolders?${query}`, { session, method: 'DELETE' });
  await response.body?.cancel();
  if (!response.ok) throw new HttpError(502, 'Jellyfin no pudo quitar la configuración duplicada.');
  const remaining = await readLibraries({ session, upstream, jsonResponse });
  if (remaining.some(row => row.ItemId === id)) throw new HttpError(502, 'Jellyfin no confirmó que quitó la configuración duplicada.');
  return { id, removed: true };
}
