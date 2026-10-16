import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rcloneEnvironment, rcloneMountArgs } from '../scripts/google-drive-mount.mjs';

test('rclone gets read-only Google OAuth values only in its child environment', () => {
  const credentials = { clientId: 'web.apps.googleusercontent.com', clientSecret: 'CLIENT_SECRET_TEST', token: { access_token: 'ACCESS_TEST', refresh_token: 'REFRESH_TEST', scope: 'https://www.googleapis.com/auth/drive.readonly' } };
  const env = rcloneEnvironment(credentials, { PATH: '/usr/bin', HOME: '/home/test', HTTPS_PROXY: 'http://proxy.test', SECRET_API_KEY: 'INHERITED_SECRET', RCLONE_CONFIG_PASS: 'INHERITED_SECRET', RCLONE_CONFIG_GDRIVE_SCOPE: 'drive' }, 'folder_abcdefghijk');
  assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, '/home/test'); assert.equal(env.HTTPS_PROXY, 'http://proxy.test');
  assert.equal(env.SECRET_API_KEY, undefined);
  assert.equal(env.RCLONE_CONFIG_GDRIVE_TYPE, 'drive');
  assert.equal(env.RCLONE_CONFIG_GDRIVE_CLIENT_ID, credentials.clientId);
  assert.equal(env.RCLONE_CONFIG_GDRIVE_CLIENT_SECRET, credentials.clientSecret);
  assert.equal(env.RCLONE_CONFIG_GDRIVE_SCOPE, 'drive.readonly');
  assert.equal(JSON.parse(env.RCLONE_CONFIG_GDRIVE_TOKEN).refresh_token, 'REFRESH_TEST');
  assert.equal(env.RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID, 'folder_abcdefghijk');
  assert.equal(Object.keys(env).some(key => /^RCLONE_CONFIG_PASS$/i.test(key)), false);
  assert.deepEqual(rcloneMountArgs('/srv/jrplex/cloud', '/var/cache/jrplex'), [
    '--config', '/dev/null', 'mount', 'gdrive:', '/srv/jrplex/cloud', '--read-only', '--allow-other', '--default-permissions', '--dir-perms', '0700', '--file-perms', '0600', '--vfs-cache-mode', 'full', '--cache-dir', '/var/cache/jrplex',
    '--vfs-cache-max-size', '2G', '--vfs-cache-max-age', '30m', '--vfs-cache-min-free-space', '5G', '--buffer-size', '16M', '--log-level', 'ERROR',
  ]);
});
