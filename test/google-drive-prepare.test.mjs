import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareGoogleDrive } from '../scripts/google-drive-prepare.mjs';

test('VPS Google preparation keeps client, encryption key and token state external and private', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-drive-prepare-'));
  const projectRoot = path.join(root, 'source'); const home = path.join(root, 'home'); const downloads = path.join(home, 'Downloads');
  await mkdir(projectRoot, { recursive: true, mode: 0o700 }); await mkdir(downloads, { recursive: true, mode: 0o700 });
  const source = path.join(downloads, 'client.json');
  await writeFile(source, JSON.stringify({ web: { client_id: 'test.apps.googleusercontent.com', client_secret: 'CLIENT_SECRET_TEST', redirect_uris: ['https://jrplexps.duckdns.org/api/google-drive/callback'] } }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));

  const paths = await prepareGoogleDrive({ clientFile: source, home, projectRoot });
  assert.equal(await readFile(paths.client, 'utf8'), await readFile(source, 'utf8'));
  assert.notEqual(path.dirname(paths.key), path.dirname(paths.client));
  assert.equal(Buffer.from((await readFile(paths.key, 'utf8')).trim(), 'base64url').length, 32);
  for (const filename of [paths.client, paths.key]) assert.equal((await stat(filename)).mode & 0o077, 0);
  for (const directory of [path.dirname(paths.client), path.dirname(paths.key), paths.state]) assert.equal((await stat(directory)).mode & 0o077, 0);

  await writeFile(source, JSON.stringify({ web: { client_id: 'other.apps.googleusercontent.com', client_secret: 'DO_NOT_OVERWRITE', redirect_uris: ['https://jrplexps.duckdns.org/api/google-drive/callback'] } }), { mode: 0o600 });
  await assert.rejects(prepareGoogleDrive({ clientFile: source, home, projectRoot }), /already exists|ya existe|EEXIST/i);
  assert.ok(!(await readFile(paths.client, 'utf8')).includes('DO_NOT_OVERWRITE'));
});

test('VPS Google preparation rejects a callback mismatch before writing credentials', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-drive-invalid-'));
  const projectRoot = path.join(root, 'source'); const home = path.join(root, 'home'); const downloads = path.join(home, 'Downloads');
  await mkdir(projectRoot, { recursive: true, mode: 0o700 }); await mkdir(downloads, { recursive: true, mode: 0o700 });
  const source = path.join(downloads, 'client.json');
  await writeFile(source, JSON.stringify({ web: { client_id: 'test.apps.googleusercontent.com', client_secret: 'CLIENT_SECRET_TEST', redirect_uris: ['https://jrplexps.duckdns.org/wrong'] } }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareGoogleDrive({ clientFile: source, home, projectRoot }), /callback HTTPS exacto/i);
  await assert.rejects(stat(path.join(home, '.local', 'share', 'jrplex', 'secrets', 'google-drive.key')), { code: 'ENOENT' });
});
