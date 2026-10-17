import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPlayableMedia, isDisplayableItem, isPhotoFolder, isPhotoItem, isTypeScriptDeclaration } from '../public/media-eligibility.js';

test('shows a movie only when Jellyfin reports an actual video stream', () => {
  assert.equal(hasPlayableMedia({ Type: 'Movie', MediaType: 'Video', MediaStreams: [{ Type: 'Video', Codec: 'h264' }] }), true);
  assert.equal(isDisplayableItem({ Type: 'Movie', MediaType: 'Video', MediaStreams: [{ Type: 'Video', Codec: 'h264' }] }), true);
  assert.equal(hasPlayableMedia({ Type: 'Movie', MediaType: 'Video', Name: 'firmware.bin', MediaStreams: [] }), false);
  assert.equal(isDisplayableItem({ Type: 'Movie', MediaType: 'Video', Name: 'firmware.bin', MediaStreams: [] }), false);
});

test('uses media-source streams when the top-level item has no stream list', () => {
  assert.equal(hasPlayableMedia({ Type: 'Movie', MediaSources: [{ MediaStreams: [{ Type: 'Video', Codec: 'hevc' }] }] }), true);
});

test('keeps real audio items and browseable containers', () => {
  assert.equal(isDisplayableItem({ Type: 'Audio', MediaType: 'Audio', MediaStreams: [{ Type: 'Audio', Codec: 'aac' }] }), true);
  assert.equal(hasPlayableMedia({ Type: 'Audio', MediaType: 'Audio', MediaStreams: [{ Type: 'Video' }] }), false);
  for (const Type of ['Series', 'Season', 'Folder', 'MusicAlbum']) assert.equal(isDisplayableItem({ Type }), true);
  assert.equal(isDisplayableItem({ Type: 'Movie', MediaStreams: [{ Type: 'Audio' }] }), false);
});

test('shows supported cloud videos even before Jellyfin has indexed stream metadata', () => {
  for (const extension of ['.mp4', '.mkv', '.mts', '.avi', '.mov', '.webm', '.m2ts', '.wmv']) {
    const item = { Type: 'Movie', MediaType: 'Video', JRPlexMediaExtension: extension };
    assert.equal(hasPlayableMedia(item), true, extension);
    assert.equal(isDisplayableItem(item), true, extension);
  }
  for (const extension of ['.bin', '.iso', '.img']) {
    assert.equal(isDisplayableItem({ Type: 'Movie', MediaType: 'Video', JRPlexMediaExtension: extension }), false, extension);
  }
});

test('does not mistake TypeScript declaration files for transport-stream video', () => {
  for (const extension of ['.d.ts', '.d.mts', '.d.cts']) {
    const item = { Type: 'Movie', MediaType: 'Video', Name: 'metadata title', Path: `/media/cloud/node_modules/pkg/index${extension}`, JRPlexMediaExtension: extension };
    assert.equal(isTypeScriptDeclaration(item), true, extension);
    assert.equal(hasPlayableMedia(item), false, extension);
    assert.equal(hasPlayableMedia({ ...item, MediaStreams: [{ Type: 'Video', Codec: 'mpeg2video' }] }), false, `${extension} stays non-media even with stale stream metadata`);
    assert.equal(isDisplayableItem(item), false, extension);
  }
  const transportStream = { Type: 'Movie', MediaType: 'Video', Path: '/media/cloud/capture.ts', JRPlexMediaExtension: '.ts' };
  assert.equal(isTypeScriptDeclaration(transportStream), false);
  assert.equal(hasPlayableMedia(transportStream), false, 'transport streams are excluded from the catalog');
});

test('never lists subtitle and companion files as playable videos, even with stale stream metadata', () => {
  for (const extension of ['.srt', '.ass', '.ssa', '.sub', '.idx', '.sup', '.vtt', '.nfo', '.cue', '.iso']) {
    const item = { Type: 'Video', MediaType: 'Video', Name: `Episode${extension}`, JRPlexMediaExtension: extension, MediaStreams: [{ Type: 'Video', Codec: 'h264' }] };
    assert.equal(hasPlayableMedia(item), false, extension);
    assert.equal(isDisplayableItem(item), false, extension);
  }
  assert.equal(isDisplayableItem({ Type: 'PhotoAlbum', IsFolder: true }), true);
});

test('identifies photos and navigable photo folders without mixing them into video playback', () => {
  assert.equal(isPhotoItem({ Type: 'Photo' }), true);
  assert.equal(isPhotoFolder({ Type: 'PhotoAlbum', IsFolder: true }), true);
  assert.equal(isDisplayableItem({ Type: 'Photo', MediaType: 'Photo' }), false);
});
