import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Optional in tests/bare-node mode; production mounts a private persistent directory.
export function createTvStore(directory = '') {
  let records = new Map(); let key; let filename;
  function privateFile(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('TV state files must be private regular files');
    if (info.size > 16 * 1024 * 1024) throw new Error('TV state file exceeds size limit');
  }
  if (directory) {
    directory = resolve(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('TV state directory must be private');
    filename = join(directory, 'devices.enc'); const keyPath = join(directory, 'devices.key');
    if (!existsSync(keyPath)) {
      if (existsSync(filename)) throw new Error('TV encryption key is missing');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    privateFile(keyPath); key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error('TV encryption key is invalid');
    if (existsSync(filename)) {
      privateFile(filename); const bytes = readFileSync(filename);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
      const rows = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
      if (!Array.isArray(rows) || rows.length > 10000 || rows.some(r => !/^[a-f0-9]{64}$/.test(r.hash || '') || !/^[A-Za-z0-9_-]{43}$/.test(r.id || '') || !/^[A-Za-z0-9_-]{1,512}$/.test(r.token || '') || !/^[A-Za-z0-9_-]+$/.test(r.user?.Id || '') || !Number.isFinite(r.expires))) throw new Error('TV state records are invalid');
      records = new Map(rows.map(r => [r.id, r]));
    }
  }
  function save(next) {
    if (filename) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify([...next.values()])), cipher.final()]);
      const temporary = join(directory, `.devices-${randomBytes(10).toString('hex')}.tmp`);
      writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, filename);
    }
    records = next;
  }
  return {
    values: () => [...records.values()],
    set(record) { const next = new Map(records); next.set(record.id, record); save(next); },
    delete(id) { if (!records.has(id)) return; const next = new Map(records); next.delete(id); save(next); },
  };
}
