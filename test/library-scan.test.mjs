import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/security.mjs';
import { startLibraryScan } from '../lib/library-scan.mjs';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, body: { cancel: async () => {} }, data };
}

function fixture(tasks) {
  const calls = [];
  const upstream = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/ScheduledTasks?isHidden=false&isEnabled=true') return response(tasks);
    if (path === '/ScheduledTasks/Running/scan-task') return response(null, 204);
    throw new Error('Unexpected request: ' + path);
  };
  return { calls, upstream, jsonResponse: async result => result.data };
}

test('starts the stable RefreshMediaLibraryTask and reports that the scan was queued', async () => {
  const f = fixture([{ Id: 'scan-task', Key: 'Jellyfin.RefreshMediaLibraryTask', Name: 'Escanear la biblioteca', State: 'Idle' }]);
  const result = await startLibraryScan({ ...f, session: { user: { Policy: { IsAdministrator: true } } } });
  assert.deepEqual(result, { scanRequested: true, alreadyRunning: false, taskName: 'Escanear la biblioteca' });
  assert.deepEqual(f.calls.map(call => [call.path, call.method || 'GET']), [
    ['/ScheduledTasks?isHidden=false&isEnabled=true', 'GET'],
    ['/ScheduledTasks/Running/scan-task', 'POST'],
  ]);
});

test('does not queue a second scan when Jellyfin reports the library task is running', async () => {
  const f = fixture([{ Id: 'scan-task', Key: 'RefreshMediaLibraryTask', Name: 'Scan Media Library', State: 'Running', CurrentProgressPercentage: 42 }]);
  const result = await startLibraryScan({ ...f, session: {} });
  assert.deepEqual(result, { scanRequested: true, alreadyRunning: true, taskName: 'Scan Media Library', progress: 42 });
  assert.equal(f.calls.length, 1);
});

test('refuses to start an unrelated or ambiguous Jellyfin task', async () => {
  const f = fixture([{ Id: 'other-task', Key: 'RefreshPlugins', Name: 'Actualizar complementos', State: 'Idle' }]);
  await assert.rejects(startLibraryScan({ ...f, session: {} }), error => error instanceof HttpError && error.status === 503);
  assert.equal(f.calls.length, 1);
});

test('reports a failed Jellyfin task start instead of claiming a scan was queued', async () => {
  const f = fixture([{ Id: 'scan-task', Key: 'RefreshMediaLibraryTask', Name: 'Scan Media Library', State: 'Idle' }]);
  f.upstream = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    if (path === '/ScheduledTasks?isHidden=false&isEnabled=true') return response([{ Id: 'scan-task', Key: 'RefreshMediaLibraryTask', Name: 'Scan Media Library', State: 'Idle' }]);
    if (path === '/ScheduledTasks/Running/scan-task') return response(null, 500);
    throw new Error('Unexpected request: ' + path);
  };
  await assert.rejects(startLibraryScan({ ...f, session: {} }), error => error instanceof HttpError && error.status === 502);
});

test('treats a concurrent start conflict as success only after confirming Jellyfin reports the task running', async () => {
  const calls = [];
  const upstream = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/ScheduledTasks?isHidden=false&isEnabled=true') {
      const state = calls.filter(call => call.path === path).length === 1 ? 'Idle' : 'Running';
      return response([{ Id: 'scan-task', Key: 'RefreshMediaLibraryTask', Name: 'Scan Media Library', State: state, CurrentProgressPercentage: 33 }]);
    }
    if (path === '/ScheduledTasks/Running/scan-task') return response(null, 409);
    throw new Error('Unexpected request: ' + path);
  };
  const result = await startLibraryScan({ session: {}, upstream, jsonResponse: async value => value.data });
  assert.deepEqual(result, { scanRequested: true, alreadyRunning: true, taskName: 'Scan Media Library', progress: 33 });
  assert.equal(calls.filter(call => call.path === '/ScheduledTasks/Running/scan-task').length, 1);
});
