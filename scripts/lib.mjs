import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const project = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function args(allowed, booleans = []) {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    if (!process.argv[i].startsWith('--') || !allowed.includes(key)) throw new Error(`Opción no admitida: ${key}. Usa --help.`);
    if (booleans.includes(key)) { out[key] = true; continue; }
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de --${key}.`);
    out[key] = value;
  }
  return out;
}

export async function loadEnv(filename = path.join(project, '.env')) {
  const values = {};
  for (const row of (await readFile(filename, 'utf8')).split(/\r?\n/)) {
    const m = row.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[m[1]] = value;
  }
  return values;
}

let pipedLines;
export async function prompt(label, secret = false) {
  // Never accept passwords through argv or environment. Piped input is one line per prompt.
  if (!stdin.isTTY) {
    if (!pipedLines) {
      const rl = createInterface({ input: stdin, crlfDelay: Infinity });
      pipedLines = rl[Symbol.asyncIterator]();
    }
    const next = await pipedLines.next();
    if (next.done) throw new Error(`Falta entrada por stdin para: ${label}`);
    return next.value;
  }
  if (!secret) {
    const rl = createInterface({ input: stdin, output: stdout });
    try { return await rl.question(label); } finally { rl.close(); }
  }
  stdout.write(label);
  return await new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (error) => {
      stdin.removeListener('data', data);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const data = (buffer) => {
      for (const ch of buffer.toString('utf8')) {
        if (ch === '\u0003') { finish(new Error('Cancelado.')); return; }
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && value.length < 1024) value += ch;
      }
    };
    stdin.on('data', data);
  });
}

export function privateBackend(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new Error('URL backend inválida.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = host === 'localhost' || host === '::1' || host === 'jellyfin' || host === 'qbittorrent' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!allowed) throw new Error('El backend debe estar en loopback o una red privada verificada. Usa un túnel SSH para administración remota.');
  return url;
}

export async function jsonRequest(base, endpoint, { method = 'GET', body, token, headers = {}, timeout = 30000 } = {}) {
  const response = await fetch(new URL(endpoint.replace(/^\//, ''), `${base.toString().replace(/\/$/, '')}/`), {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `MediaBrowser Client="JRPlex CLI", Device="Setup", DeviceId="JRPlex-CLI", Version="0.1.0", Token="${token}"` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint.split('?')[0]} devolvió HTTP ${response.status}.`);
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error(`Respuesta JSON inválida de ${endpoint.split('?')[0]}.`); }
}

export function fail(error) {
  // Do not print backend response bodies or nested causes: they can contain credentials.
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
