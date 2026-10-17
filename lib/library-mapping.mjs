import { HttpError } from './security.mjs';
import { startLibraryScan } from './library-scan.mjs';

export function mediaFolderPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new HttpError(400, 'La carpeta seleccionada no es válida.');
  const normalized = value.replace(/\/+$/, '');
  if (!['/media/cloud', '/media/local'].some(root => normalized === root || normalized.startsWith(root + '/'))) throw new HttpError(400, 'Selecciona una carpeta de Google Drive o del disco de medios.');
  return normalized;
}

// Changes library references, never files. Restore the original references if
// an upstream mutation fails; the caller serializes operations per library.
export async function replaceLibraryPath({ name, id, input, session, upstream, jsonResponse }) {
  const path = mediaFolderPath(input.path);
  const libraries = async () => {
    const response = await upstream('/Library/VirtualFolders', { session });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'No se pudieron leer las bibliotecas.'); }
    const rows = await jsonResponse(response);
    if (!Array.isArray(rows)) throw new HttpError(502, 'Lista de bibliotecas no válida.');
    return rows;
  };
  const findLibrary = rows => {
    const matches = rows.filter(row => name ? row.Name === name : row.ItemId === id);
    if (!matches.length) throw new HttpError(404, 'La biblioteca ya no existe.');
    if (matches.length !== 1) throw new HttpError(409, 'Jellyfin tiene nombres o identificadores de biblioteca repetidos y no permite cambiar esta ruta con seguridad. Renombra la biblioteca primero.');
    return matches[0];
  };
  const rows = await libraries();
  const library = findLibrary(rows); const libraryName = library.Name; const previousPaths = library.Locations || [];
  if (!Array.isArray(input.previousPaths) || input.previousPaths.some(value => typeof value !== 'string') || JSON.stringify([...previousPaths].sort()) !== JSON.stringify([...input.previousPaths].sort())) throw new HttpError(409, 'La ruta cambió en otra sesión. Recarga antes de guardarla.');
  // Keep duplicate entries: Jellyfin stores one shortcut for every occurrence,
  // and RemoveMediaPath deletes only one matching shortcut at a time.
  const original = [...previousPaths];
  const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  if (!original.includes(path) && rows.some(row => row.Name !== libraryName && (row.Locations || []).some(location => {
    try { return overlaps(path, mediaFolderPath(location)); } catch { return false; }
  }))) throw new HttpError(409, 'Esta carpeta se superpone con otra biblioteca. Elige una carpeta separada para evitar rutas duplicadas en Jellyfin.');
  const check = await upstream('/Environment/DirectoryContents?' + new URLSearchParams({ path, includeFiles: 'false', includeDirectories: 'true' }), { session });
  await check.body?.cancel();
  if (!check.ok) throw new HttpError(400, 'Jellyfin no puede leer la carpeta elegida.');
  const originalOptions = library.LibraryOptions || {};
  const wantsPhotoScan = typeof input.enablePhotos === 'boolean' ? input.enablePhotos : originalOptions.EnablePhotos === true;
  const shouldUpdateOptions = typeof input.enablePhotos === 'boolean' && wantsPhotoScan !== (originalOptions.EnablePhotos === true);
  const retargetPathInfo = value => {
    const existing = originalOptions.PathInfos?.find(row => row.Path === value);
    if (existing) return existing;
    const template = originalOptions.PathInfos?.[0];
    return template ? { ...template, Path: value } : { Path: value };
  };
  const updatePhotoScan = async (enabled, pathInfos = originalOptions.PathInfos || []) => {
    const viewResponse = await upstream(`/Users/${encodeURIComponent(session.user.Id)}/Views`, { session });
    if (!viewResponse.ok) { await viewResponse.body?.cancel(); throw new HttpError(502, 'No se pudieron identificar las opciones de esta biblioteca.'); }
    const viewPayload = await jsonResponse(viewResponse);
    const views = Array.isArray(viewPayload) ? viewPayload : viewPayload?.Items;
    const matchingViews = Array.isArray(views) ? views.filter(view => view?.Name === libraryName && typeof view.Id === 'string') : [];
    const libraryId = matchingViews.length === 1 ? matchingViews[0].Id : library.ItemId;
    if (!libraryId) throw new HttpError(409, 'Jellyfin no expuso un identificador único para actualizar la opción de fotografías.');
    const options = { ...originalOptions, EnablePhotos: enabled, PathInfos: pathInfos };
    const response = await upstream('/Library/VirtualFolders/LibraryOptions', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Id: libraryId, LibraryOptions: options }) });
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(502, enabled ? 'No se pudo activar la exploración de fotografías para esta biblioteca.' : 'No se pudo desactivar la exploración de fotografías para esta biblioteca.');
  };
  const add = async value => {
    const info = retargetPathInfo(value);
    const response = await upstream('/Library/VirtualFolders/Paths?refreshLibrary=false', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: libraryName, PathInfo: info }) });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo registrar la carpeta.');
  };
  const remove = async value => {
    const response = await upstream('/Library/VirtualFolders/Paths?' + new URLSearchParams({ name: libraryName, path: value, refreshLibrary: 'false' }), { session, method: 'DELETE' });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo retirar la ruta anterior.');
  };
  let added = false; let photoOptionsChanged = false; const removed = [];
  try {
    if (!original.includes(path)) { await add(path); added = true; }
    let keptSelectedPath = false;
    for (const old of original) {
      if (old === path && !keptSelectedPath) { keptSelectedPath = true; continue; }
      await remove(old); removed.push(old);
    }
    if (shouldUpdateOptions) { await updatePhotoScan(wantsPhotoScan, [retargetPathInfo(path)]); photoOptionsChanged = true; }
    const current = findLibrary(await libraries());
    if (current.Locations?.length !== 1 || current.Locations[0] !== path) throw new HttpError(502, 'El servidor no confirmó el nuevo mapeo.');
    if (typeof input.enablePhotos === 'boolean' && (current.LibraryOptions?.EnablePhotos === true) !== wantsPhotoScan) throw new HttpError(502, 'El servidor no confirmó la opción de exploración de fotografías.');
  } catch (error) {
    try {
      if (added) await remove(path);
      for (const old of removed) await add(old);
      if (photoOptionsChanged) await updatePhotoScan(originalOptions.EnablePhotos === true, originalOptions.PathInfos || []);
      const restored = findLibrary(await libraries());
      if (JSON.stringify(restored.Locations || []) !== JSON.stringify(previousPaths)) throw new Error('Original library paths were not restored.');
    }
    catch { throw new HttpError(502, 'No se pudo completar ni restaurar el mapeo. Revisa las rutas de esta biblioteca antes de continuar.'); }
    throw error;
  }
  try { return { name: libraryName, path, ...await startLibraryScan({ session, upstream, jsonResponse }) }; }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { name: libraryName, path, scanRequested: false, scanError: error.message };
  }
}
