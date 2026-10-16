import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoogleDriveOAuth, googleDriveFolderIdFromUrl, readGoogleDriveMountCredentials } from '../lib/google-drive-oauth.mjs';

const redirectUri = 'https://jrplexps.duckdns.org/api/google-drive/callback';
const driveScope = 'https://www.googleapis.com/auth/drive.readonly';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-oauth-'));
  const projectRoot = path.join(root, 'source');
  const secrets = path.join(root, 'private-config');
  const state = path.join(root, 'private-state');
  await mkdir(projectRoot, { recursive: true }); await mkdir(secrets, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  const clientFile = path.join(secrets, 'google-web.json');
  const keyFile = path.join(secrets, 'oauth-key');
  const tokenFile = path.join(state, 'token.enc');
  await writeFile(clientFile, JSON.stringify({ web: {
    client_id: 'test.apps.googleusercontent.com', client_secret: 'CLIENT_SECRET_TEST_ONLY',
    redirect_uris: [redirectUri], javascript_origins: [],
  } }), { mode: 0o600 });
  await writeFile(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { publicUrl: 'https://jrplexps.duckdns.org', googleOAuthClientFile: clientFile, googleOAuthKeyFile: keyFile, googleOAuthTokenFile: tokenFile };
  return { root, projectRoot, clientFile, keyFile, tokenFile, config };
}

test('Google Web OAuth redirects with exact callback, offline read-only scope, and one-time state', async (t) => {
  const files = await setup(t); let tokenCalls = 0; let posted;
  const oauth = createGoogleDriveOAuth(files.config, { projectRoot: files.projectRoot, fetcher: async (url, options) => {
    tokenCalls++; posted = new URLSearchParams(options.body);
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    return new Response(JSON.stringify({ access_token: 'ACCESS_TOKEN_TEST_ONLY', refresh_token: 'REFRESH_TOKEN_TEST_ONLY', expires_in: 3600, token_type: 'Bearer', scope: driveScope }), { status: 200 });
  } });
  const authorization = new URL(await oauth.start());
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('response_mode'), 'form_post');
  assert.equal(authorization.searchParams.get('scope'), driveScope);
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  assert.equal(authorization.searchParams.get('prompt'), 'consent');
  const state = authorization.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{40,50}$/);
  const result = await oauth.callback(`${redirectUri}?code=one-time-code&state=${state}`);
  assert.equal(result.redirect, 'https://jrplexps.duckdns.org/app?cloud=google-linked');
  assert.equal(tokenCalls, 1);
  assert.equal(posted.get('redirect_uri'), redirectUri);
  assert.equal(posted.get('grant_type'), 'authorization_code');
  const stored = await readFile(files.tokenFile, 'utf8');
  assert.match(stored, /^JRPlex-GDrive-v1:/);
  assert.ok(!stored.includes('REFRESH_TOKEN_TEST_ONLY'));
  assert.ok(!stored.includes('ACCESS_TOKEN_TEST_ONLY'));
  assert.deepEqual(await oauth.status(), { configured: true, linked: true, mountVerified: false });
  const mountCredentials = await readGoogleDriveMountCredentials(files.config, { projectRoot: files.projectRoot });
  assert.equal(mountCredentials.clientId, 'test.apps.googleusercontent.com');
  assert.equal(mountCredentials.clientSecret, 'CLIENT_SECRET_TEST_ONLY');
  assert.equal(mountCredentials.token.refresh_token, 'REFRESH_TOKEN_TEST_ONLY');
  assert.equal(mountCredentials.token.scope, driveScope);
  await assert.rejects(oauth.callback(`${redirectUri}?code=replay&state=${state}`), /authorization expired/i);
});

test('Google OAuth rejects an unregistered callback and expired state', async (t) => {
  const files = await setup(t); let current = 1000;
  const oauth = createGoogleDriveOAuth(files.config, { projectRoot: files.projectRoot, now: () => current, fetcher: async () => { throw new Error('not expected'); } });
  const auth = new URL(await oauth.start());
  current += 10 * 60 * 1000 + 1;
  await assert.rejects(oauth.callback(`${redirectUri}?code=test&state=${auth.searchParams.get('state')}`), /authorization expired/i);
  const badClient = { ...files.config, googleOAuthClientFile: path.join(path.dirname(files.clientFile), 'bad-client.json') };
  await writeFile(badClient.googleOAuthClientFile, JSON.stringify({ web: { client_id: 'test.apps.googleusercontent.com', client_secret: 'test', redirect_uris: ['https://jrplexps.duckdns.org/wrong'] } }), { mode: 0o600 });
  await assert.rejects(createGoogleDriveOAuth(badClient, { projectRoot: files.projectRoot }).start(), /callback URI does not match/i);
});

test('Google status does not reveal an absent client or authorization details', async (t) => {
  const files = await setup(t);
  const oauth = createGoogleDriveOAuth({ ...files.config, googleOAuthClientFile: '', googleOAuthKeyFile: '' }, { projectRoot: files.projectRoot });
  assert.deepEqual(await oauth.status(), { configured: false, linked: false, mountVerified: false });
});

test('Google Drive folder links resolve to mounted paths and folder browsing uses refreshed read-only authorization', async (t) => {
  const files = await setup(t); let current = Date.parse('2026-10-16T12:00:00Z'); const calls = []; let refreshCalls = 0;
  const ids = { child: 'southparkfolder123456', parent: 'seriesfolder12345678', root: 'mydrivefolder123456789' };
  const oauth = createGoogleDriveOAuth(files.config, { projectRoot: files.projectRoot, now: () => current, fetcher: async (url, options) => {
    const target = new URL(url);
    if (target.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'ACCESS_OLD', refresh_token: 'REFRESH_KEEP', expires_in: 3600, scope: driveScope }), { status: 200 });
      refreshCalls++;
      assert.equal(form.get('grant_type'), 'refresh_token');
      return new Response(JSON.stringify({ access_token: 'ACCESS_FRESH', expires_in: 3600 }), { status: 200 });
    }
    calls.push({ target, authorization: options.headers.Authorization });
    assert.equal(options.headers.Authorization, 'Bearer ACCESS_FRESH');
    if (target.pathname.endsWith('/files')) {
      assert.equal(target.searchParams.get('includeItemsFromAllDrives'), 'true');
      if (target.searchParams.has('pageToken')) {
        assert.equal(target.searchParams.get('pageToken'), 'next-page');
        assert.match(target.searchParams.get('q'), /'seriesfolder12345678' in parents/);
        return new Response(JSON.stringify({ files: [{ id: ids.child, name: 'South Park', mimeType: 'application/vnd.google-apps.folder' }] }), { status: 200 });
      }
      assert.match(target.searchParams.get('q'), /'root' in parents/);
      return new Response(JSON.stringify({ files: [{ id: ids.parent, name: 'Series', mimeType: 'application/vnd.google-apps.folder' }, { id: 'fileid1234567890', name: 'video.mp4', mimeType: 'video/mp4' }], nextPageToken: 'next-page' }), { status: 200 });
    }
    const id = target.pathname.split('/').at(-1);
    const rows = {
      [ids.child]: { id: ids.child, name: 'South Park', mimeType: 'application/vnd.google-apps.folder', parents: [ids.parent] },
      [ids.parent]: { id: ids.parent, name: 'Series', mimeType: 'application/vnd.google-apps.folder', parents: [ids.root] },
      [ids.root]: { id: ids.root, name: 'My Drive', mimeType: 'application/vnd.google-apps.folder', parents: [] },
    };
    return rows[id] ? new Response(JSON.stringify(rows[id]), { status: 200 }) : new Response('{}', { status: 404 });
  } });
  const authorization = new URL(await oauth.start());
  await oauth.callback(`${redirectUri}?code=one-time-code&state=${authorization.searchParams.get('state')}`);
  current += 3600 * 1000;

  const listing = await oauth.listFolders();
  assert.deepEqual(listing, { parentId: null, folders: [{ id: ids.parent, name: 'Series' }], nextPageToken: 'next-page' });
  assert.deepEqual(await oauth.listFolders(ids.parent, listing.nextPageToken), { parentId: ids.parent, folders: [{ id: ids.child, name: 'South Park' }], nextPageToken: null });
  assert.equal(refreshCalls, 1);
  assert.equal(await oauth.resolveFolderUrl(`https://drive.google.com/drive/folders/${ids.child}?hl=es-419`), '/media/cloud/Series/South Park');
  assert.equal(calls.length, 5, 'lists two pages and reads each folder ancestor');
  assert.equal(googleDriveFolderIdFromUrl(`https://drive.google.com/drive/folders/${ids.child}?hl=es-419`), ids.child);
  assert.equal(googleDriveFolderIdFromUrl('https://drive.google.com/drive/folders/fixturefolder123456789?hl=es-419'), 'fixturefolder123456789');
  assert.throws(() => googleDriveFolderIdFromUrl(`https://drive.google.com/drive/folders/${ids.child}#fragment`), /formato/);
  await assert.rejects(oauth.listFolders('../invalid'), /identificador/);
});
