import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const volumeFormat = 'tokenstat-backup-volume';
const backupFormat = 'tokenstat-backup';
const life = 30 * 60_000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex = /^[0-9a-f]{64}$/u;
const runFolder = /^run-([1-9]\d{0,9})-[A-Za-z0-9]{6}$/u;

function processExited(pid) {
  if (pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function listHash(hashes) {
  return digest(JSON.stringify(hashes));
}

function validateVolume(volume, maxBytes, maxItems) {
  if (volume?.format !== volumeFormat || volume.version !== 2 || typeof volume.backupId !== 'string'
    || !uuid.test(volume.backupId) || !Number.isSafeInteger(volume.partIndex) || volume.partIndex < 1
    || !Number.isSafeInteger(volume.partCount) || volume.partIndex > volume.partCount
    || typeof volume.sha256 !== 'string' || !hex.test(volume.sha256)
    || typeof volume.bundleSha256 !== 'string' || !hex.test(volume.bundleSha256)
    || !Array.isArray(volume.entries) || !volume.entries.length || volume.entries.length > maxItems) {
    throw new Error('备份分卷格式无效。');
  }
  const json = JSON.stringify(volume.entries);
  if (Buffer.byteLength(json) > maxBytes || digest(json) !== volume.sha256) throw new Error('备份分卷校验失败。');
  return json;
}

export function createBackupTransfer(store, dataDir, { partBytes = 8 * 1024 * 1024, partItems = 20_000 } = {}) {
  const staging = join(dataDir, 'backup-transfers');
  mkdirSync(staging, { mode: 0o700, recursive: true });
  if (!lstatSync(staging).isDirectory()) throw new Error('备份暂存位置不是普通目录。');
  if (process.platform !== 'win32') chmodSync(staging, 0o700);
  const sessions = new Map();
  const cleanup = new Set();
  let directory;
  let expiry;
  function discard(path) {
    try {
      rmSync(path, { recursive: true, force: true });
      cleanup.delete(path);
    } catch {
      cleanup.add(path);
    }
  }

  function remove(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    discard(session.directory);
  }

  function sweep() {
    clearTimeout(expiry);
    for (const path of cleanup) discard(path);
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) remove(id);
    const delays = [...sessions.values()].map((session) => session.expiresAt - Date.now());
    if (cleanup.size) delays.push(60_000);
    if (delays.length) expiry = setTimeout(sweep, Math.max(1, Math.min(...delays))).unref();
  }

  const cutoff = Date.now() - life;
  for (const entry of readdirSync(staging, { withFileTypes: true })) {
    const match = entry.isDirectory() && runFolder.exec(entry.name);
    if (!match) continue;
    const path = join(staging, entry.name);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isDirectory() && info.mtimeMs <= cutoff && processExited(Number(match[1]))) discard(path);
  }
  sweep();

  function begin(kind) {
    sweep();
    if (sessions.size >= 8) throw new Error('备份传输过多，请先下载或取消现有传输。');
    directory ??= mkdtempSync(join(staging, `run-${process.pid}-`));
    const id = randomUUID();
    const session = { id, kind, directory: mkdtempSync(join(directory, kind + '-')), parts: new Map(), expiresAt: Date.now() + life };
    sessions.set(id, session);
    sweep();
    return session;
  }

  function locate(id, kind) {
    const session = sessions.get(id);
    if (!session || session.kind !== kind || session.expiresAt <= Date.now()) throw new Error('备份传输已过期，请重新开始。');
    session.expiresAt = Date.now() + life;
    sweep();
    return session;
  }

  function put(session, partIndex, json, sha256) {
    const path = join(session.directory, String(partIndex) + '.json');
    let usage;
    try { usage = statfsSync(session.directory); }
    catch (error) { if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error; }
    if (usage && usage.bavail * usage.bsize - Buffer.byteLength(json) < 32 * 1024 * 1024) {
      throw new Error('临时目录空间不足，请释放磁盘空间后重试。');
    }
    try {
      writeFileSync(path, json, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') discard(path);
      throw error;
    }
    session.parts.set(partIndex, { path, sha256 });
  }

  function exportBackup() {
    const session = begin('export');
    const createdAt = new Date().toISOString();
    let strings = [];
    let bytes = 2;
    function flush() {
      if (!strings.length) return;
      const json = '[' + strings.join(',') + ']';
      put(session, session.parts.size + 1, json, digest(json));
      strings = [];
      bytes = 2;
    }
    try {
      store.visitBackup((entry) => {
        const item = JSON.stringify(entry);
        const size = Buffer.byteLength(item);
        if (size + 2 > partBytes) throw new Error('单条备份内容超出分卷上限。');
        if (strings.length >= partItems || bytes + size + (strings.length ? 1 : 0) > partBytes) flush();
        bytes += size + (strings.length ? 1 : 0);
        strings.push(item);
      });
      flush();
      if (session.parts.size === 1) {
        const data = { format: backupFormat, version: 1, createdAt, batches: [], records: [] };
        for (const entry of JSON.parse(readFileSync(session.parts.get(1).path, 'utf8'))) {
          if (entry.kind === 'settings') Object.assign(data, entry.data);
          else if (entry.kind === 'batch') data.batches.push(entry.data);
          else data.records.push(entry.data);
        }
        remove(session.id);
        return data;
      }
      const partCount = session.parts.size;
      session.bundleSha256 = listHash([...session.parts.values()].map((part) => part.sha256));
      session.createdAt = createdAt;
      return {
        format: 'tokenstat-backup-download', backupId: session.id, partCount,
        parts: [...session.parts.keys()].map((partIndex) => ({
          partIndex, url: '/api/backup/volumes/' + session.id + '/' + partIndex,
          filename: 'tokenstat-' + createdAt.slice(0, 10) + '-' + session.id.slice(0, 8) + '-' + partIndex + '-of-' + partCount + '.json',
        })),
      };
    } catch (error) {
      remove(session.id);
      throw error;
    }
  }

  function volume(id, partIndex) {
    const session = locate(id, 'export');
    const part = session.parts.get(partIndex);
    if (!part) throw new Error('找不到该备份分卷。');
    return {
      format: volumeFormat, version: 2, backupId: id, partIndex, partCount: session.parts.size,
      createdAt: session.createdAt, sha256: part.sha256, bundleSha256: session.bundleSha256,
      entries: JSON.parse(readFileSync(part.path, 'utf8')),
    };
  }

  function stage(id, part) {
    const session = locate(id, 'restore');
    const json = validateVolume(part, partBytes, partItems);
    const { backupId, partCount, partIndex, bundleSha256, sha256 } = part;
    if (session.backupId && (session.backupId !== backupId || session.partCount !== partCount || session.bundleSha256 !== bundleSha256)) {
      throw new Error('选中的文件来自不同备份，请选择同一组分卷。');
    }
    const existing = session.parts.get(partIndex);
    if (existing && existing.sha256 !== sha256) throw new Error('存在内容不一致的同号分卷。');
    if (!existing) put(session, partIndex, json, sha256);
    Object.assign(session, { backupId, partCount, bundleSha256 });
    return { received: session.parts.size, expected: partCount };
  }

  function restoreVolumes(id, dryRun) {
    const session = locate(id, 'restore');
    const received = session.parts.size;
    if (!session.partCount || received !== session.partCount) throw new Error('备份分卷不完整，请选择同一组的全部文件。');
    const parts = [...session.parts.entries()].sort((a, b) => a[0] - b[0]);
    if (parts.some(([index], offset) => index !== offset + 1) || listHash(parts.map(([, part]) => part.sha256)) !== session.bundleSha256) {
      throw new Error('备份分卷组校验失败。');
    }
    if (!dryRun && !session.previewed) throw new Error('请先预检备份，再确认恢复。');
    function* entries() {
      for (const [, part] of parts) {
        const json = readFileSync(part.path, 'utf8');
        if (digest(json) !== part.sha256) throw new Error('备份分卷校验失败。');
        yield* JSON.parse(json);
      }
    }
    const result = store.restoreBackupItems(entries(), { dryRun });
    if (dryRun) session.previewed = true;
    else remove(id);
    return { ...result, volumes: { verified: true, received, expected: session.partCount } };
  }

  return {
    exportBackup,
    volume,
    beginRestore: () => ({ id: begin('restore').id }),
    stage,
    restoreVolumes,
    remove,
    close() {
      clearTimeout(expiry);
      sessions.clear();
      if (directory) discard(directory);
    },
  };
}
