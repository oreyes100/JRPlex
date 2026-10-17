const VIDEO_EXTENSIONS = new Set([
  '.3g2', '.3gp', '.asf', '.avi', '.divx', '.f4v', '.flv', '.m2t', '.m2ts', '.m2v', '.m4v', '.mkv', '.mov', '.mp2', '.mp4', '.mpe', '.mpeg', '.mpg', '.mpv', '.mts', '.mxf', '.nut', '.ogv', '.qt', '.rm', '.rmvb', '.vob', '.webm', '.wmv',
]);
const AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.alac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav', '.wma']);
const VIDEO_TYPES = new Set(['Movie', 'Video', 'Episode', 'Recording', 'MusicVideo']);
const CONTAINER_TYPES = new Set(['Series', 'Season', 'MusicAlbum', 'MusicArtist', 'Folder', 'CollectionFolder', 'BoxSet', 'PhotoAlbum']);
const NON_MEDIA_EXTENSIONS = new Set(['.ass', '.cue', '.idx', '.jpeg', '.jpg', '.lrc', '.nfo', '.pdf', '.png', '.smi', '.srt', '.ssa', '.sub', '.sup', '.text', '.txt', '.vtt', '.webp', '.xml', '.json', '.bin', '.iso', '.img', '.d.ts', '.d.mts', '.d.cts']);
const TYPESCRIPT_DECLARATION = /\.d\.(?:ts|mts|cts)$/i;

function extensionOf(item) {
  const extension = item?.JRPlexMediaExtension || (typeof item?.Name === 'string' ? item.Name.slice(item.Name.lastIndexOf('.')) : '');
  return typeof extension === 'string' ? extension.toLowerCase() : '';
}

export function isTypeScriptDeclaration(item) {
  return extensionOf(item).startsWith('.d.') || TYPESCRIPT_DECLARATION.test(item?.Path || '') || TYPESCRIPT_DECLARATION.test(item?.Name || '');
}

export function hasPlayableMedia(item) {
  if (isTypeScriptDeclaration(item)) return false;
  if (NON_MEDIA_EXTENSIONS.has(extensionOf(item))) return false;
  if (isPhotoItem(item)) return false;
  // MPEG transport-stream captures (.ts) are not a reliably playable source
  // in the supported browser player; never classify TypeScript as media.
  if (extensionOf(item) === '.ts') return false;
  const streams = [
    ...(Array.isArray(item?.MediaStreams) ? item.MediaStreams : []),
    ...(Array.isArray(item?.MediaSources) ? item.MediaSources.flatMap((source) => Array.isArray(source?.MediaStreams) ? source.MediaStreams : []) : []),
  ];
  const isAudio = item?.MediaType === 'Audio' || item?.Type === 'Audio';
  const type = isAudio ? 'Audio' : 'Video';
  if (streams.some((stream) => stream?.Type === type)) return true;
  if (streams.length) return false;
  const extension = extensionOf(item);
  if (isAudio) return AUDIO_EXTENSIONS.has(extension) || item?.Type === 'Audio';
  if (VIDEO_TYPES.has(item?.Type)) return !extension || VIDEO_EXTENSIONS.has(extension);
  return VIDEO_EXTENSIONS.has(extension) && item?.MediaType === 'Video';
}

export function isDisplayableItem(item) {
  return Boolean(item?.IsFolder || CONTAINER_TYPES.has(item?.Type) || hasPlayableMedia(item));
}

export function isPhotoItem(item) {
  return item?.Type === 'Photo' || item?.MediaType === 'Photo';
}

export function isPhotoFolder(item) {
  return Boolean(item?.IsFolder || ['Folder', 'PhotoAlbum', 'CollectionFolder'].includes(item?.Type));
}
