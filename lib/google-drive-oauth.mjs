import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { access, constants, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { boundedBody, HttpError } from './security.mjs';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const ENVELOPE = 'JRPlex-GDrive-v1:';

export function googleDriveFolderIdFromUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new HttpError(400, 'Pega un enlace válido de una carpeta de Google Drive.');
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Pega un enlace válido de una carpeta de Google Drive.'); }
  const match = url.pathname.match(/^\/drive\/folders\/([A-Za-z0-9_-]{10,200})\/?$/);
  if (url.origin !== 'https://drive.google.com' || url.username || url.password || url.hash || !match) throw new HttpError(400, 'El enlace debe tener el formato https://drive.google.com/drive/folders/ID.');
  return match[1];
}

function validFolderId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value); }

function safeDriveFolderName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

async function privateRegularFile(filename, label) {
  if (!filename || !path.isAbsolute(filename)) throw new HttpError(503, `${label} is not configured on the server`);
  let info;
  try { info = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') throw new HttpError(503, `${label} is not configured on the server`); throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(503, `${label} must be a private regular file`);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new HttpError(503, `${label} permissions must be restricted to its service account`);
  return info;
}

async function outsideProject(filename, root) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new HttpError(503, 'Google credential paths are not configured on the server');
  let resolvedRoot;
  let resolvedParent;
  try { resolvedRoot = await realpath(root); resolvedParent = await realpath(path.dirname(filename)); }
  catch { throw new HttpError(503, 'Google credential directory is not available on the server'); }
  const resolved = path.join(resolvedParent, path.basename(filename));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new HttpError(503, 'Google credentials must be stored outside the application source');
}

async function readClient(config, projectRoot) {
  const filename = config.googleOAuthClientFile;
  await outsideProject(filename, projectRoot);
  await privateRegularFile(filename, 'Google Web client');
  let document;
  try { document = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new HttpError(503, 'Google Web client file is invalid'); }
  const client = document?.web;
  if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com') || typeof client.client_secret !== 'string' || !client.client_secret || !Array.isArray(client.redirect_uris)) throw new HttpError(503, 'A Google OAuth Web client is required');
  const redirectUri = `${config.publicUrl}/api/google-drive/callback`;
  if (!client.redirect_uris.includes(redirectUri)) throw new HttpError(503, 'Google Web client callback URI does not match JRPlex');
  return { clientId: client.client_id, clientSecret: client.client_secret, redirectUri };
}

async function keyBytes(config, projectRoot) {
  const filename = config.googleOAuthKeyFile;
  await outsideProject(filename, projectRoot);
  await privateRegularFile(filename, 'Google token encryption key');
  const encoded = (await readFile(filename, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new HttpError(503, 'Google token encryption key must be a private 32-byte base64url key');
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new HttpError(503, 'Google token encryption key is invalid');
  return key;
}

async function encryptedWrite(filename, key, payload) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new HttpError(503, 'Google credential directory permissions are not private');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const temporary = `${filename}.${randomBytes(10).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${ENVELOPE}${envelope}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
  if (process.platform !== 'win32') {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new HttpError(503, 'Google credential file permissions are not private');
  }
}

async function encryptedRead(filename, key) {
  await privateRegularFile(filename, 'Google Drive authorization');
  const envelope = (await readFile(filename, 'utf8')).trim();
  if (!envelope.startsWith(ENVELOPE)) throw new HttpError(503, 'Stored Google Drive authorization is invalid');
  try {
    const input = Buffer.from(envelope.slice(ENVELOPE.length), 'base64url');
    if (input.length < 29) throw new Error('short envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
    decipher.setAuthTag(input.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { throw new HttpError(503, 'Stored Google Drive authorization could not be decrypted'); }
}

async function assertTokenStoreReady(tokenFile, projectRoot) {
  if (typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) throw new HttpError(503, 'Google token storage is not configured on the server');
  await outsideProject(tokenFile, projectRoot);
  const directory = path.dirname(tokenFile);
  let info;
  try { info = await lstat(directory); } catch { throw new HttpError(503, 'Google token storage is not ready on the server'); }
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new HttpError(503, 'Google token directory permissions must be restricted to its service account');
  try { await access(directory, constants.W_OK); } catch { throw new HttpError(503, 'Google token storage is not writable by the service account'); }
}

export async function readGoogleDriveMountCredentials(config, { projectRoot = process.cwd() } = {}) {
  const client = await readClient(config, projectRoot);
  const key = await keyBytes(config, projectRoot);
  await assertTokenStoreReady(config.googleOAuthTokenFile, projectRoot);
  const token = await encryptedRead(config.googleOAuthTokenFile, key);
  if (typeof token.refresh_token !== 'string' || !token.refresh_token || typeof token.access_token !== 'string' || !token.access_token || !String(token.scope || '').split(/\s+/).includes(DRIVE_SCOPE)) throw new HttpError(503, 'Google Drive authorization is not complete for read-only access');
  return { clientId: client.clientId, clientSecret: client.clientSecret, token };
}

export function createGoogleDriveOAuth(config, { fetcher = fetch, now = Date.now, projectRoot = process.cwd() } = {}) {
  const states = new Map();
  const tokenFile = config.googleOAuthTokenFile;
  const callbackPath = '/api/google-drive/callback';
  let refreshInFlight;

  async function readDriveAuthorization() {
    const client = await readClient(config, projectRoot);
    const key = await keyBytes(config, projectRoot);
    await assertTokenStoreReady(tokenFile, projectRoot);
    const token = await encryptedRead(tokenFile, key);
    if (typeof token.refresh_token !== 'string' || !token.refresh_token || !String(token.scope || '').split(/\s+/).includes(DRIVE_SCOPE)) throw new HttpError(503, 'Vincula Google Drive con permiso de solo lectura antes de explorar sus carpetas.');
    return { client, key, token };
  }

  async function refreshDriveToken(force = false) {
    const current = await readDriveAuthorization();
    if (!force && typeof current.token.access_token === 'string' && Date.parse(current.token.expiry) > now() + 60_000) return current.token.access_token;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let response;
      try {
        response = await fetcher(TOKEN_ENDPOINT, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: current.client.clientId, client_secret: current.client.clientSecret, refresh_token: current.token.refresh_token, grant_type: 'refresh_token' }),
        });
      } catch { throw new HttpError(502, 'Google no pudo renovar el acceso a Drive. Vuelve a vincular la cuenta e inténtalo otra vez.'); }
      let renewed;
      try {
        const text = await response.text();
        if (text.length > 65536 || !response.ok) throw new Error('token refresh rejected');
        renewed = JSON.parse(text);
      } catch { throw new HttpError(502, 'Google no pudo renovar el acceso a Drive. Vuelve a vincular la cuenta e inténtalo otra vez.'); }
      if (typeof renewed.access_token !== 'string' || !renewed.access_token) throw new HttpError(502, 'Google no devolvió una autorización válida para Drive.');
      const expiresIn = Number(renewed.expires_in);
      const stored = {
        ...current.token,
        access_token: renewed.access_token,
        refresh_token: typeof renewed.refresh_token === 'string' && renewed.refresh_token ? renewed.refresh_token : current.token.refresh_token,
        token_type: typeof renewed.token_type === 'string' ? renewed.token_type : current.token.token_type || 'Bearer',
        expiry: new Date(now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000).toISOString(),
      };
      await encryptedWrite(tokenFile, current.key, stored);
      return stored.access_token;
    })().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }

  async function driveApiJson(url, retryUnauthorized = true, requestSignal) {
    const accessToken = await refreshDriveToken();
    let response;
    try {
      response = await fetcher(url, { method: 'GET', redirect: 'error', signal: requestSignal || AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    } catch { throw new HttpError(502, 'No se pudo consultar Google Drive. Revisa la conexión e inténtalo de nuevo.'); }
    if (response.status === 401 && retryUnauthorized) {
      await response.body?.cancel();
      await refreshDriveToken(true);
      return driveApiJson(url, false, requestSignal);
    }
    if (response.status === 404) { await response.body?.cancel(); throw new HttpError(404, 'La carpeta no existe o no está compartida con la cuenta Google vinculada.'); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 403 ? 403 : 502, response.status === 403 ? 'La cuenta Google vinculada no tiene permiso para ver esta carpeta.' : 'Google Drive no pudo completar la consulta.'); }
    let data;
    try {
      const text = (await boundedBody(response.body, 2 * 1024 * 1024, 15000)).toString('utf8');
      if (!text) throw new Error('empty response');
      data = JSON.parse(text);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Google Drive devolvió una respuesta no válida.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(502, 'Google Drive devolvió una respuesta no válida.');
    return data;
  }

  async function listFolders(parentId = '', pageToken = '') {
    if (parentId && parentId !== 'root' && !validFolderId(parentId)) throw new HttpError(400, 'El identificador de la carpeta no es válido.');
    if (typeof pageToken !== 'string' || pageToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(pageToken)) throw new HttpError(400, 'La página solicitada no es válida.');
    const query = new URLSearchParams({
      q: `'${parentId || 'root'}' in parents and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
      pageSize: '1000', orderBy: 'name', fields: 'nextPageToken,files(id,name,mimeType)',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await driveApiJson(`${DRIVE_API}/files?${query}`);
    if (!Array.isArray(data.files)) throw new HttpError(502, 'Google Drive devolvió una lista de carpetas no válida.');
    const folders = data.files.filter(folder => validFolderId(folder?.id) && folder.mimeType === DRIVE_FOLDER_MIME && safeDriveFolderName(folder.name))
      .map(folder => ({ id: folder.id, name: folder.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { parentId: parentId || null, folders, nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
  }

  async function resolveFolderUrl(value) {
    const folderId = googleDriveFolderIdFromUrl(value);
    const parts = []; const visited = new Set(); let currentId = folderId; const requestSignal = AbortSignal.timeout(30000);
    for (let depth = 0; depth < 64; depth++) {
      if (!validFolderId(currentId) || visited.has(currentId)) throw new HttpError(400, 'No se pudo recorrer la ubicación de esta carpeta de Google Drive.');
      visited.add(currentId);
      const file = await driveApiJson(`${DRIVE_API}/files/${encodeURIComponent(currentId)}?${new URLSearchParams({ fields: 'id,name,mimeType,parents,driveId,trashed', supportsAllDrives: 'true' })}`, true, requestSignal);
      if (file.id !== currentId || file.trashed || file.mimeType !== DRIVE_FOLDER_MIME || !safeDriveFolderName(file.name)) throw new HttpError(400, 'El enlace no apunta a una carpeta de Google Drive legible.');
      if (file.driveId) throw new HttpError(400, 'Los enlaces de unidades compartidas aún no se pueden mapear al montaje de Drive de este servidor. Usa una carpeta de Mi unidad.');
      if (!Array.isArray(file.parents) || file.parents.length === 0) break;
      if (file.parents.length !== 1) throw new HttpError(400, 'No se pudo traducir esta carpeta a una ruta de medios compatible.');
      parts.push(file.name);
      if (file.parents[0] === 'root') break;
      if (!validFolderId(file.parents[0])) throw new HttpError(400, 'No se pudo traducir esta carpeta a una ruta de medios compatible.');
      currentId = file.parents[0];
      if (depth === 63) throw new HttpError(400, 'La ruta de la carpeta excede el límite de profundidad.');
    }
    const path = parts.length ? `/media/cloud/${parts.reverse().join('/')}` : '/media/cloud';
    if (path.length > 1024) throw new HttpError(400, 'La ruta de la carpeta es demasiado larga para JRPlex.');
    return path;
  }

  async function status() {
    let clientConfigured = false;
    try { await readClient(config, projectRoot); await keyBytes(config, projectRoot); await assertTokenStoreReady(tokenFile, projectRoot); clientConfigured = true; } catch {}
    let linked = false;
    try {
      const key = await keyBytes(config, projectRoot);
      const token = await encryptedRead(tokenFile, key);
      linked = typeof token.refresh_token === 'string' && token.refresh_token.length > 0;
    } catch {}
    return { configured: clientConfigured, linked, mountVerified: false };
  }

  async function start() {
    for (const [state, record] of states) if (record.expiresAt <= now()) states.delete(state);
    if (states.size >= 1000) throw new HttpError(429, 'Too many Google authorization requests');
    const client = await readClient(config, projectRoot);
    await keyBytes(config, projectRoot);
    await assertTokenStoreReady(tokenFile, projectRoot);
    const state = randomBytes(32).toString('base64url');
    states.set(state, { expiresAt: now() + 10 * 60 * 1000 });
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      response_mode: 'form_post',
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    });
    return url.href;
  }

  async function callback(requestUrl) {
    const params = new URL(requestUrl, config.publicUrl).searchParams;
    const state = params.get('state') || '';
    const record = states.get(state);
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(state) || !record || record.expiresAt <= now()) {
      states.delete(state);
      throw new HttpError(400, 'Google authorization expired; start again from JRPlex');
    }
    states.delete(state);
    if (params.has('error') || !params.get('code') || params.get('code').length > 4096) throw new HttpError(400, 'Google authorization was cancelled or could not be completed');

    await assertTokenStoreReady(tokenFile, projectRoot);
    const client = await readClient(config, projectRoot);
    const key = await keyBytes(config, projectRoot);
    let response;
    try {
      response = await fetcher(TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: params.get('code'), client_id: client.clientId, client_secret: client.clientSecret,
          redirect_uri: client.redirectUri, grant_type: 'authorization_code',
        }),
      });
    } catch { throw new HttpError(502, 'Google could not complete authorization; try again'); }
    let tokens;
    try {
      const text = await response.text();
      if (text.length > 65536 || !response.ok) throw new Error('token endpoint rejected request');
      tokens = JSON.parse(text);
    } catch { throw new HttpError(502, 'Google could not complete authorization; try again'); }
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || typeof tokens.access_token !== 'string' || !tokens.access_token) throw new HttpError(502, 'Google did not return a durable Drive authorization; try again');
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [];
    if (!scopes.includes(DRIVE_SCOPE)) throw new HttpError(502, 'Google did not grant the requested read-only Drive permission');
    const expiresIn = Number(tokens.expires_in);
    const stored = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: typeof tokens.token_type === 'string' ? tokens.token_type : 'Bearer',
      scope: scopes.length ? scopes.join(' ') : DRIVE_SCOPE,
      expiry: new Date(now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000).toISOString(),
    };
    await encryptedWrite(tokenFile, key, stored);
    return { redirect: `${config.publicUrl}/app?cloud=google-linked` };
  }

  return { start, callback, status, callbackPath, listFolders, resolveFolderUrl, scopes: { drive: DRIVE_SCOPE }, async disconnect() {
    await outsideProject(tokenFile, projectRoot);
    try { await unlink(tokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } };
}
