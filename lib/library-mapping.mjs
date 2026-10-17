import { HttpError } from './security.mjs';

export function mediaFolderPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new HttpError(400, 'La carpeta seleccionada no es válida.');
  const normalized = value.replace(/\/+$/, '');
  if (!['/media/cloud', '/media/local'].some(root => normalized === root || normalized.startsWith(root + '/'))) throw new HttpError(400, 'Selecciona una carpeta de Google Drive o del disco de medios.');
  return normalized;
}

// Changes library references, never files. Restore the original references if
// an upstream mutation fails; the caller serializes operations per library.
export async function replaceLibraryPath({ id, input, session, upstream, jsonResponse }) {
  const path = mediaFolderPath(input.path);
  const libraries = async () => {
    const response = await upstream('/Library/VirtualFolders', { session });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'No se pudieron leer las bibliotecas.'); }
    const rows = await jsonResponse(response);
    if (!Array.isArray(rows)) throw new HttpError(502, 'Lista de bibliotecas no válida.');
    return rows;
  };
  const findLibrary = rows => {
    const library = rows.find(row => row.ItemId === id);
    if (!library) throw new HttpError(404, 'La biblioteca ya no existe.');
    return library;
  };
  const rows = await libraries();
  const library = findLibrary(rows); const previousPaths = library.Locations || [];
  if (!Array.isArray(input.previousPaths) || input.previousPaths.some(value => typeof value !== 'string') || JSON.stringify([...previousPaths].sort()) !== JSON.stringify([...input.previousPaths].sort())) throw new HttpError(409, 'La ruta cambió en otra sesión. Recarga antes de guardarla.');
  // Keep duplicate entries: Jellyfin stores one shortcut for every occurrence,
  // and RemoveMediaPath deletes only one matching shortcut at a time.
  const original = [...previousPaths];
  const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  if (!original.includes(path) && rows.some(row => row.ItemId !== id && (row.Locations || []).some(location => {
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
    const options = { ...originalOptions, EnablePhotos: enabled, PathInfos: pathInfos };
    const response = await upstream('/Library/VirtualFolders/LibraryOptions', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Id: library.ItemId, LibraryOptions: options }) });
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(502, enabled ? 'No se pudo activar la exploración de fotografías para esta biblioteca.' : 'No se pudo desactivar la exploración de fotografías para esta biblioteca.');
  };
  const add = async value => {
    const info = retargetPathInfo(value);
    const response = await upstream('/Library/VirtualFolders/Paths?refreshLibrary=false', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: library.Name, PathInfo: info }) });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo registrar la carpeta.');
  };
  const remove = async value => {
    const response = await upstream('/Library/VirtualFolders/Paths?' + new URLSearchParams({ name: library.Name, path: value, refreshLibrary: 'false' }), { session, method: 'DELETE' });
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
  const refresh = await upstream('/Library/Refresh', { session, method: 'POST' });
  await refresh.body?.cancel();
  return { id, path, scanRequested: refresh.ok };
}
