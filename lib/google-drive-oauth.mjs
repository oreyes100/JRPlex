import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { access, constants, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './security.mjs';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ENVELOPE = 'JRPlex-GDrive-v1:';

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

  return { start, callback, status, callbackPath, scopes: { drive: DRIVE_SCOPE }, async disconnect() {
    await outsideProject(tokenFile, projectRoot);
    try { await unlink(tokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } };
}
