import { isIP } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(normalized) ? normalized : '';
}

export function privateEndpoint(raw, name) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const parts = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
  const privateV6 = host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  const internalHost = host === 'localhost' || /^[a-z][a-z0-9-]*$/.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(privateV4 || privateV6 || internalHost)) {
    throw new Error(`${name} must be a fixed private HTTP(S) origin without credentials or path`);
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const publicUrl = new URL(env.PUBLIC_URL || 'http://localhost:8787');
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_URL must be an HTTP(S) origin');
  const publicHost = publicUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = publicHost === 'localhost' || publicHost === '::1' || (isIP(publicHost) === 4 && publicHost.startsWith('127.'));
  if (publicUrl.protocol === 'http:' && !loopback) throw new Error('PUBLIC_URL requires HTTPS except on loopback');
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS || '').split(',').map((value) => value.trim()).filter(Boolean).map((value) => {
    const ip = normalizeIp(value);
    if (!ip) throw new Error('TRUSTED_PROXY_IPS requires exact IP addresses');
    return ip;
  });
  const number = (value, fallback, min, max) => {
    const result = Number(value ?? fallback);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid numeric configuration');
    return result;
  };
  const secret = (name) => env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : '';
  return {
    publicUrl: publicUrl.origin,
    jellyfinUrl: privateEndpoint(env.JELLYFIN_URL || 'http://127.0.0.1:8096', 'JELLYFIN_URL'),
    qbUrl: env.QB_URL ? privateEndpoint(env.QB_URL, 'QB_URL') : '',
    qbUsername: secret('QB_USERNAME'), qbPassword: secret('QB_PASSWORD'),
    googleOAuthClientFile: env.GOOGLE_OAUTH_CLIENT_FILE || '',
    googleOAuthKeyFile: env.GOOGLE_OAUTH_KEY_FILE || '',
    googleOAuthTokenFile: env.GOOGLE_OAUTH_TOKEN_FILE || '',
    torrentFilesDir: path.resolve(env.TORRENT_FILES_DIR || './runtime/downloads/incomplete'),
    torrentSavePath: path.isAbsolute(env.TORRENT_SAVE_PATH || '') ? env.TORRENT_SAVE_PATH : path.resolve(env.TORRENT_SAVE_PATH || './runtime/downloads/incomplete'),
    trustedProxyIps,
    host: env.HOST || '127.0.0.1', port: number(env.PORT, 8787, 0, 65535),
    sessionTtl: number(env.SESSION_TTL, 28800, 1, 86400) * 1000,
    upstreamTimeout: 20000, maxBody: 2 * 1024 * 1024, maxJson: 16 * 1024 * 1024,
  };
}

export const opaque = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const isSecretKey = (key) => /^(access.?token|open.?token|api.?key|password(?:_pbkdf2)?|pw|authorization|credential|credentials|path|substitutionpath)$/i.test(key);

export function requireStrongPassword(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 1024) throw new HttpError(400, 'Password must contain 16 to 1024 characters');
}

export function safePath(raw) {
  if (raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//')) throw new HttpError(400, 'Invalid path');
  const pathname = raw.split('?')[0];
  let decoded = pathname;
  for (let i = 0; i < 3; i++) {
    try { decoded = decodeURIComponent(decoded); } catch { throw new HttpError(400, 'Invalid path'); }
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('%') || decoded.split('/').some((part) => part === '.' || part === '..') || decoded.includes('//') || decoded.includes(':')) throw new HttpError(400, 'Invalid path');
  return decoded;
}

export function cleanQuery(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (/^(api.?key|access.?token|token|authorization)$/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

export function localMediaUrl(value, basePath, config) {
  if (typeof value !== 'string' || value.length > 16384) throw new HttpError(502, 'Invalid media URL');
  const source = new URL(value, `${config.jellyfinUrl}${basePath}`);
  if (source.origin !== config.jellyfinUrl || source.username || source.password || source.hash) throw new HttpError(502, 'External media URL rejected');
  safePath(source.pathname);
  // Jellyfin emits lower-case media prefixes in transcoding URLs while the
  // gateway allowlist uses the API's canonical spelling. Normalize only this
  // leading segment; item IDs, nested paths and their case remain untouched.
  const prefixes = { videos: 'Videos', audio: 'Audio', items: 'Items', shows: 'Shows' };
  source.pathname = source.pathname.replace(/^\/(videos|audio|items|shows)(?=\/|$)/i, (_match, prefix) => `/${prefixes[prefix.toLowerCase()]}`);
  cleanQuery(source);
  return `/jellyfin${source.pathname}${source.search}`;
}

export function sanitizeJson(value, config, basePath = '/', includeMediaPaths = false) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, config, basePath, includeMediaPaths));
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).filter(([key]) => !isSecretKey(key) || (includeMediaPaths && /^path$/i.test(key))).map(([key, item]) => {
    if (/(?:TranscodingUrl|DirectStreamUrl|StreamUrl)$/i.test(key) && typeof item === 'string') {
      try { return [key, localMediaUrl(item, basePath, config)]; } catch { return [key, null]; }
    }
    return [key, sanitizeJson(item, config, basePath, includeMediaPaths)];
    }));
    // Keep server paths hidden from regular users. Administrators may request
    // them for media diagnostics; all callers receive only a safe extension hint.
    if (typeof value.Path === 'string' && (value.MediaType === 'Video' || value.MediaType === 'Audio' || ['Movie', 'Video', 'Episode', 'Recording', 'MusicVideo', 'Audio'].includes(value.Type))) {
      const filename = value.Path.replace(/\\/g, '/').split('/').at(-1) || '';
      const declaration = filename.match(/\.d\.(?:ts|mts|cts)$/i);
      const extension = declaration ? declaration[0].toLowerCase() : path.extname(filename).toLowerCase();
      if (/^\.[a-z0-9]{1,12}$/.test(extension) || declaration) result.JRPlexMediaExtension = extension;
    }
    return result;
  }
  if (typeof value === 'string') {
    // Credentials can occur in nested metadata URLs as well as in named fields.
    return value.replace(/([?&](?:api_?key|access_?token|token|authorization)=)[^&#\s"']*/gi, '$1[redacted]');
  }
  return value;
}

export function rewritePlaylist(text, path, config, mapUrl = value => value) {
  return text.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${mapUrl(localMediaUrl(uri, path, config))}"`);
    return mapUrl(localMediaUrl(line.trim(), path, config));
  }).join('\n');
}

export async function boundedBody(stream, max, timeout = 20000) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  let total = 0;
  const chunks = [];
  let expired = false;
  const timer = setTimeout(() => { expired = true; reader.cancel().catch(() => {}); }, timeout);
  timer.unref?.();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new HttpError(502, 'Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    if (expired) throw new HttpError(504, 'Upstream response timed out');
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
