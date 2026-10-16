import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoogleDriveOAuth, readGoogleDriveMountCredentials } from '../lib/google-drive-oauth.mjs';

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
