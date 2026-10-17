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
  const list = async () => {
    const response = await upstream('/Library/VirtualFolders', { session });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'No se pudieron leer las bibliotecas.'); }
    const rows = await jsonResponse(response);
    if (!Array.isArray(rows)) throw new HttpError(502, 'Lista de bibliotecas no válida.');
    const library = rows.find(row => row.ItemId === id);
    if (!library) throw new HttpError(404, 'La biblioteca ya no existe.');
    return library;
  };
  const library = await list(); const original = library.Locations || [];
  if (!Array.isArray(input.previousPaths) || input.previousPaths.some(value => typeof value !== 'string') || JSON.stringify([...original].sort()) !== JSON.stringify([...input.previousPaths].sort())) throw new HttpError(409, 'La ruta cambió en otra sesión. Recarga antes de guardarla.');
  if (input.enablePhotos === true && library.LibraryOptions?.EnablePhotos !== true) {
    const options = { ...(library.LibraryOptions || {}), EnablePhotos: true };
    const response = await upstream('/Library/VirtualFolders/LibraryOptions', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Id: library.ItemId, LibraryOptions: options }) });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo activar la exploración de fotografías para esta biblioteca.');
  }
  const check = await upstream('/Environment/DirectoryContents?' + new URLSearchParams({ path, includeFiles: 'false', includeDirectories: 'true' }), { session });
  await check.body?.cancel();
  if (!check.ok) throw new HttpError(400, 'Jellyfin no puede leer la carpeta elegida.');
  const add = async value => {
    const info = library.LibraryOptions?.PathInfos?.find(row => row.Path === value) || { Path: value };
    const response = await upstream('/Library/VirtualFolders/Paths?refreshLibrary=false', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: library.Name, PathInfo: info }) });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo registrar la carpeta.');
  };
  const remove = async value => {
    const response = await upstream('/Library/VirtualFolders/Paths?' + new URLSearchParams({ name: library.Name, path: value, refreshLibrary: 'false' }), { session, method: 'DELETE' });
    await response.body?.cancel(); if (!response.ok) throw new HttpError(502, 'No se pudo retirar la ruta anterior.');
  };
  let added = false; const removed = [];
  try {
    if (!original.includes(path)) { await add(path); added = true; }
    for (const old of original.filter(value => value !== path)) { await remove(old); removed.push(old); }
    const current = await list();
    if (current.Locations?.length !== 1 || current.Locations[0] !== path) throw new HttpError(502, 'El servidor no confirmó el nuevo mapeo.');
  } catch (error) {
    try { for (const old of removed) await add(old); if (added) await remove(path); }
    catch { throw new HttpError(502, 'No se pudo completar ni restaurar el mapeo. Revisa las rutas de esta biblioteca antes de continuar.'); }
    throw error;
  }
  const refresh = await upstream('/Library/Refresh', { session, method: 'POST' });
  await refresh.body?.cancel();
  return { id, path, scanRequested: refresh.ok };
}
