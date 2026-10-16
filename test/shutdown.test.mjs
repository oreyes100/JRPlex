import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('gateway exits cleanly on SIGTERM when app.close is synchronous', { timeout: 10000 }, async (t) => {
  const port = await unusedPort();
  const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverFile], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', () => { if (stdout.includes('JRPlex gateway listening')) resolve(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`gateway exited before listening (code ${code}): ${stderr}`)));
    }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('gateway did not start in time')), 5000); timer.unref(); }),
  ]);

  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /TypeError/);
});
