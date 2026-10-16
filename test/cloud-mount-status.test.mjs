import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCloudMountActive } from '../lib/cloud-mount-status.mjs';

test('recognizes only the active marker written after systemd confirms the FUSE mount', () => {
  assert.equal(isCloudMountActive('active\n'), true);
});

test('does not treat empty, missing, or inactive state as a verified mount', () => {
  assert.equal(isCloudMountActive(''), false);
  assert.equal(isCloudMountActive('inactive\n'), false);
  assert.equal(isCloudMountActive(undefined), false);
});
