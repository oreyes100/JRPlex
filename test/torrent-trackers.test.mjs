import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicTrackers } from '../lib/torrent-trackers.mjs';

test('trackers are pinned to public UDP IPv4 addresses without dropping peer discovery', async () => {
  const lookup = async host => { assert.equal(host, 'tracker.example.org'); return [{ address: '93.184.216.34' }]; };
  assert.deepEqual(await publicTrackers(['udp://tracker.example.org:1337/announce', 'udp://tracker.example.org:1337/announce'], { lookup }), ['udp://93.184.216.34:1337/announce']);
});

test('trackers cannot contact private networks, mixed DNS answers, credentials or HTTP redirects', async () => {
  const values = ['udp://127.0.0.1:80/announce', 'udp://10.0.0.1:80', 'udp://169.254.169.254:80', 'udp://100.64.0.1:80', 'udp://192.168.1.1:80', 'udp://172.31.1.1:80', 'udp://224.0.0.1:80', 'udp://[::1]:80', 'http://93.184.216.34/announce', 'https://93.184.216.34/redirect', 'udp://user:pw@93.184.216.34:80', 'udp://tracker.example.org:1337/announce'];
  assert.deepEqual(await publicTrackers(values, { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }] }), []);
});

test('DNS failure and timeout cannot leave a torrent submission stuck indefinitely', async () => {
  assert.deepEqual(await publicTrackers(['udp://tracker.example.org:1337/announce'], { timeout: 10, lookup: () => new Promise(() => {}) }), []);
  assert.deepEqual(await publicTrackers(['udp://tracker.example.org:1337/announce'], { lookup: async () => { throw Error('DNS'); } }), []);
});
