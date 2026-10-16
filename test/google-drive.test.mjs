import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizationUrls, cleanEnvironment, failureClassification, runRclone, setupGoogleDrive } from '../scripts/google-drive.mjs';

function fakeRclone({ code = 0, stdout = '', stderr = '' } = {}) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}

test('OAuth output allowlist excludes bearer tokens and non-loopback URLs', () => {
  const output = 'token={"access_token":"SENSITIVE"}\nhttp://evil.test/auth?state=bad\nhttp://127.0.0.1:53682/auth?state=state_123%2D\n';
  assert.deepEqual(authorizationUrls(output), ['http://127.0.0.1:53682/auth?state=state_123%2D']);
});

test('Inherited rclone overrides cannot broaden scope or replace configuration', () => {
  assert.deepEqual(cleanEnvironment({ PATH: 'safe', RCLONE_CONFIG_PASS: 'secret', RCLONE_DRIVE_SCOPE: 'drive', RCLONE_RC: 'true' }), { PATH: 'safe' });
});

test('Child diagnostics are never propagated on failure', async () => {
  await assert.rejects(runRclone('/test/rclone', ['lsd', 'gdrive:'], { env: cleanEnvironment(), spawnImpl: fakeRclone({ code: 7, stderr: 'refresh_token=VERY_SECRET' }) }), (error) => {
    assert.equal(error.message.includes('VERY_SECRET'), false);
    return true;
  });
});

test('Unknown flags produce only a safe classification and operation stage', async () => {
  assert.equal(failureClassification('Error: unknown flag: --PRIVATE_VALUE'), 'CLI_FLAG_UNKNOWN');
  await assert.rejects(runRclone('/test/rclone', ['config', 'create'], { env: cleanEnvironment(), stage: 'config-create', spawnImpl: fakeRclone({ code: 2, stderr: 'Error: unknown flag: --PRIVATE_VALUE\nrefresh_token=SECRET' }) }), (error) => {
    assert.match(error.message, /\[config-create\]/);
    assert.match(error.message, /código 2; CLI_FLAG_UNKNOWN/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE|refresh_token|SECRET/);
    return true;
  });
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jrplex-oauth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateDir = path.join(directory, 'config');
  await mkdir(privateDir, { mode: 0o700 });
  await chmod(privateDir, 0o700);
  const config = path.join(privateDir, 'rclone.conf');
  const opt = { rclone: process.execPath, config, 'password-command': '/private/secret-helper' };
  return { directory, config, opt };
}

test('OAuth is encrypted before authorization; args contain no token and request readonly', async (t) => {
  const { config, opt } = await fixture(t);
  const calls = [];
  const runner = async (_bin, argv, options) => {
    calls.push({ argv, options });
    if (argv.slice(0, 3).join(' ') === 'config encryption set') await writeFile(config, '# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\nciphertext', { mode: 0o600 });
    if (argv[1] === 'dump') return calls.some((call) => call.argv[1] === 'create') ? JSON.stringify({ gdrive: { type: 'drive', scope: 'drive.readonly', token: 'PRIVATE_TOKEN' } }) : '{}';
    return '';
  };
  await setupGoogleDrive(opt, { runner });
  assert.deepEqual(calls[0].argv.slice(0, 3), ['config', 'encryption', 'set']);
  const create = calls.find((call) => call.argv[1] === 'create');
  assert.ok(create.argv.includes('scope=drive.readonly'));
  assert.ok(create.argv.includes('config_shared_client_id=true'));
  assert.ok(create.argv.includes('--no-output'));
  assert.ok(create.argv.includes('config_auth_no_browser=true'));
  assert.equal(create.argv.includes('--auth-no-open-browser'), false);
  assert.equal(create.options.stage, 'config-create');
  assert.equal(JSON.stringify(calls).includes('PRIVATE_TOKEN'), false);
  assert.ok((await readFile(config, 'utf8')).includes('RCLONE_ENCRYPT_V0:'));
});

test('Existing gdrive authorization is never overwritten', async (t) => {
  const { config, opt } = await fixture(t);
  await writeFile(config, '# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\nciphertext', { mode: 0o600 });
  const calls = [];
  const runner = async (_bin, argv) => { calls.push(argv); return argv[1] === 'dump' ? '{"gdrive":{"type":"drive","token":"PRIVATE"}}' : ''; };
  await assert.rejects(setupGoogleDrive(opt, { runner }), /Ya existe gdrive/);
  assert.equal(calls.some((argv) => argv[1] === 'create'), false);
});

test('Existing plaintext config is rejected without invoking rclone', async (t) => {
  const { config, opt } = await fixture(t);
  await writeFile(config, '[gdrive]\ntoken=PRIVATE\n', { mode: 0o600 });
  await assert.rejects(setupGoogleDrive(opt, { runner: async () => assert.fail('Must not execute rclone') }), /no está cifrada/);
});

test('Readonly scope verification rejects broader existing authorization', async (t) => {
  const { config, opt } = await fixture(t);
  await writeFile(config, 'RCLONE_ENCRYPT_V0:\nciphertext', { mode: 0o600 });
  await assert.rejects(setupGoogleDrive({ ...opt, action: 'check' }, { runner: async (_bin, argv) => argv[1] === 'dump' ? '{"gdrive":{"type":"drive","scope":"drive","token":"PRIVATE"}}' : '' }), /solo lectura completa/);
});

test('Real rclone accepts config create CLI parameters without OAuth or file mutation', { skip: !process.env.JRPLEX_TEST_RCLONE }, async () => {
  const binary = process.env.JRPLEX_TEST_RCLONE;
  assert.ok(path.isAbsolute(binary), 'JRPLEX_TEST_RCLONE must be an absolute official binary path');
  const help = await runRclone(binary, ['config', 'create', 'gdrive', 'drive', 'scope=drive.readonly', 'config_is_local=true', 'config_auth_no_browser=true', 'config_shared_client_id=true', '--no-output', '--config', os.devNull, '--password-command', '/private/secret-helper', '--ask-password=false', '--help'], { env: cleanEnvironment(), capture: true, stage: 'cli-help' });
  assert.match(help, /config create/);
  assert.match(help, /--no-output/);
});
