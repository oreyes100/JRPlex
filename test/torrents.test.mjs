import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTorrentClient, parseTorrentRange, torrentInput } from '../lib/torrents.mjs';

test('torrent range parser accepts media ranges and rejects malformed or unsatisfiable ranges', () => {
  assert.deepEqual(parseTorrentRange('bytes=4-8', 16), { start: 4, end: 8, partial: true });
  assert.deepEqual(parseTorrentRange('bytes=12-', 16), { start: 12, end: 15, partial: true });
  assert.deepEqual(parseTorrentRange('bytes=-4', 16), { start: 12, end: 15, partial: true });
  assert.deepEqual(parseTorrentRange(undefined, 16), { start: 0, end: 15, partial: false });
  for (const range of ['bytes=-0', 'bytes=16-', 'bytes=8-4', 'bytes=1-2,4-5', 'items=0-2']) assert.throws(() => parseTorrentRange(range, 16), /range/i);
});

test('torrent video is served only after its selected pieces verify and deleted on stop', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-torrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'movie.mp4'), '0123456789abcdef');
  const hash = '0123456789012345678901234567890123456789';
  let added = false; let piecesCalls = 0; let deletedFiles = null; let addFields; let addCalls = 0; let filePolls = 0; let priorityPending = true; let clearedPlayLimit = 0;
  const files = [{ index: 0, name: 'movie.mp4', size: 16, progress: 0, priority: 0 }, { index: 1, name: 'types.ts', size: 4, progress: 0, priority: 0 }];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace('/api/v2/', '');
    if (route === 'auth/login') return new Response(null, { status: 204, headers: { 'set-cookie': 'QBT_SID_8080=test; HttpOnly; SameSite=Strict; Path=/' } });
    assert.equal(init.headers?.Cookie, 'QBT_SID_8080=test', 'uses the qBittorrent 5.2 session cookie');
    if (route === 'torrents/info') {
      if (parsed.searchParams.has('tag')) return new Response('[]');
      return new Response(JSON.stringify(added ? [{ hash, name: 'Sample video', tags: 'jrplex-stream', content_path: path.join(root, 'movie.mp4'), save_path: root }] : []), { headers: { 'content-type': 'application/json' } });
    }
    if (route === 'torrents/add') {
      addCalls++;
      addFields = init.body;
      added = true;
      return new Response(JSON.stringify({ success_count: 0, pending_count: 1, failure_count: 0, added_torrent_ids: [] }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (route === 'torrents/files') {
      filePolls++;
      if (added && filePolls === 1) return new Response('Not ready', { status: 404 });
      return new Response(JSON.stringify(added ? files : []), { headers: { 'content-type': 'application/json' } });
    }
    if (route === 'torrents/filePrio' && priorityPending) { priorityPending = false; return new Response('Metadata pending', { status: 409 }); }
    if (route === 'torrents/setDownloadLimit') { clearedPlayLimit++; return new Response(''); }
    if (route === 'torrents/properties') return new Response(JSON.stringify({ piece_size: 4, save_path: root }), { headers: { 'content-type': 'application/json' } });
    if (route === 'torrents/pieceStates') {
      piecesCalls++;
      return new Response(JSON.stringify(piecesCalls === 1 ? [0, 2, 2, 2] : [2, 2, 2, 2]), { headers: { 'content-type': 'application/json' } });
    }
    if (route === 'torrents/delete') { deletedFiles = new URLSearchParams(init.body).get('deleteFiles'); added = false; return new Response(''); }
    if (route === 'app/version' || route.startsWith('torrents/')) return new Response('');
    throw new Error(`Unexpected qBittorrent test request: ${route}`);
  };
  const client = createTorrentClient({
    qbUrl: 'http://127.0.0.1:8080', qbUsername: 'test', qbPassword: 'test',
    torrentFilesDir: root, torrentSavePath: root, upstreamTimeout: 5000, maxJson: 1024 * 1024,
  }, { fetch });
  assert.equal(await client.health(), true);
  const responses = await Promise.all(Array.from({ length: 20 }, () => client.add({ url: `magnet:?xt=urn:btih:${hash}` })));
  const session = responses[0];
  assert.ok(responses.every(result => result.id === session.id), 'parallel duplicate submissions reuse one playback session');
  assert.equal(session.files.length, 1);
  assert.deepEqual(session.files.map(file => file.name), ['movie.mp4'], 'TypeScript declarations are hidden from torrent choices');
  await assert.rejects(client.play(session.id, 1), /vídeo válido/i);
  assert.equal(addCalls, 1, 'a repeated magnet is added to qBittorrent only once');
  assert.equal(addFields.get('paused'), 'false', 'metadata discovery can run');
  assert.equal(addFields.get('dlLimit'), '1', 'metadata discovery has a one-byte-per-second payload cap');
  assert.equal(addFields.get('sequentialDownload'), 'true');
  assert.equal(addFields.get('firstLastPiecePrio'), 'false');
  assert.ok(filePolls >= 2, 'the qBittorrent 404 while metadata is pending is retried');
  const playback = await client.play(session.id, 0);
  assert.equal(playback.size, 16);
  assert.equal(clearedPlayLimit, 1, 'the selected video can stream at the normal configured rate');

  class FakeResponse extends EventEmitter {
    headers = {}; chunks = []; writableEnded = false; destroyed = false;
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
    end() { this.writableEnded = true; }
  }
  const response = new FakeResponse();
  await client.stream({ method: 'GET', headers: { range: 'bytes=2-6' } }, response, session.id, 0);
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers['Content-Range'], 'bytes 2-6/16');
  assert.equal(Buffer.concat(response.chunks).toString(), '23456');
  assert.equal(piecesCalls >= 2, true, 'waits for the first requested piece before serving bytes');

  await client.remove(session.id);
  assert.equal(deletedFiles, 'true');
  assert.deepEqual(await client.list(), []);
  await client.close();
});

test('qBittorrent legacy login response remains supported', async () => {
  const fetch = async (url) => {
    const route = new URL(url).pathname.replace('/api/v2/', '');
    if (route === 'auth/login') return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=legacy-test; HttpOnly' } });
    if (route === 'torrents/info') return new Response('[]', { headers: { 'content-type': 'application/json' } });
    if (route === 'app/version') return new Response('5.0.0');
    throw new Error(`Unexpected qBittorrent test request: ${route}`);
  };
  const client = createTorrentClient({
    qbUrl: 'http://127.0.0.1:8080', qbUsername: 'test', qbPassword: 'test',
    torrentFilesDir: '/tmp', torrentSavePath: '/tmp', upstreamTimeout: 1000, maxJson: 1024,
  }, { fetch });
  assert.equal(await client.health(), true);
  await client.close();
});

test('torrent input keeps only validated hash and removes tracker endpoints', () => {
  const value = torrentInput({ url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=http%3A%2F%2F127.0.0.1%2Fannounce' });
  assert.equal(value.hash, '0123456789012345678901234567890123456789');
  assert.equal(value.magnet.includes('127.0.0.1'), false);
  assert.equal(torrentInput({ url: `magnet:?xt=urn:btih:${'A'.repeat(32)}` }).hash, '0'.repeat(40));
});

test('Matroska torrent streams are converted to fragmented MP4 after their first piece verifies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-torrent-transcode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'sample.mkv'), '0123456789ab');
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  let added = false; let pieceCalls = 0;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url); const route = parsed.pathname.replace('/api/v2/', '');
    if (route === 'auth/login') return new Response(null, { status: 204, headers: { 'set-cookie': 'QBT_SID_8080=test; Path=/' } });
    if (route === 'torrents/info') return new Response(JSON.stringify(parsed.searchParams.has('tag') || !added ? [] : [{ hash, name: 'Sample', tags: 'jrplex-stream', content_path: path.join(root, 'sample.mkv'), save_path: root }]));
    if (route === 'torrents/add') { added = true; return new Response('Ok.'); }
    if (route === 'torrents/files') return new Response(JSON.stringify([{ index: 0, name: 'sample.mkv', size: 12, progress: 0, priority: 0 }]));
    if (route === 'torrents/properties') return new Response(JSON.stringify({ piece_size: 4 }));
    if (route === 'torrents/pieceStates') { pieceCalls++; return new Response(JSON.stringify(pieceCalls === 1 ? [0, 2, 2] : [2, 2, 2])); }
    if (route === 'torrents/delete' || route.startsWith('torrents/')) return new Response('');
    throw new Error(`Unexpected qBittorrent request: ${route}`);
  };
  const spawn = () => {
    const child = new EventEmitter(); child.killed = false; child.exitCode = null;
    child.stdout = new PassThrough(); let emitted = false;
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { if (!emitted) { emitted = true; child.stdout.write(Buffer.from('0000ftyp-isom0000moof')); } callback(); },
      final(callback) { child.exitCode = 0; child.stdout.end(); queueMicrotask(() => child.emit('close', 0)); callback(); },
    });
    child.kill = () => { child.killed = true; child.exitCode = 1; child.stdout.destroy(); };
    return child;
  };
  const client = createTorrentClient({ qbUrl: 'http://127.0.0.1:8080', qbUsername: 'test', qbPassword: 'test', torrentFilesDir: root, torrentSavePath: root, upstreamTimeout: 1000, maxJson: 1024 }, { fetch, spawn });
  const session = await client.add({ url: `magnet:?xt=urn:btih:${hash}` });
  const playback = await client.play(session.id, 0);
  const request = new EventEmitter(); request.method = 'GET'; request.headers = {};
  class TestResponse extends Writable {
    constructor() { super(); this.output = []; }
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
    _write(chunk, _encoding, callback) { this.output.push(Buffer.from(chunk)); callback(); }
  }
  const response = new TestResponse();
  await client.stream(request, response, session.id, 0);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'video/mp4');
  assert.equal(response.headers['Accept-Ranges'], 'none');
  assert.match(Buffer.concat(response.output).toString(), /ftyp-isom.*moof/);
  assert.ok(pieceCalls >= 2, 'the first response waits until the opening torrent piece is verified');
  await client.close();
});
