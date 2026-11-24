import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const filenamePattern = /^tokenstat-v[1-9]\d*-to-v[1-9]\d*-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/u;

function syncFile(path, flags) {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The caller holds the source connection's writer lock, so this independent
// reader sees the same committed (including WAL) state that will be migrated.
export function createMigrationBackup(filename, previousVersion, nextVersion) {
  const directory = join(dirname(filename), 'migration-backups');
  const target = join(directory, `tokenstat-v${previousVersion}-to-v${nextVersion}-${Date.now()}-${randomUUID()}.db`);
  const temporary = target + '.tmp';
  let temporaryCreated = false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error('备份目录不是普通目录。');
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    const fd = openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    closeSync(fd);

    const reader = new DatabaseSync(filename, { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      reader.prepare('VACUUM INTO ?').run(temporary);
    } finally {
      reader.close();
    }
    // Windows FlushFileBuffers requires a handle opened with write access.
    syncFile(temporary, 'r+');
    renameSync(temporary, target);
    if (process.platform !== 'win32') {
      try {
        syncFile(directory, 'r');
      } catch (error) {
        // Some filesystems can sync the backup file but do not support fsync on directories.
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
      }
    }
    return directory;
  } catch (error) {
    throw new Error('无法创建升级前的 SQLite 备份，原数据库未升级。', { cause: error });
  } finally {
    if (temporaryCreated) rmSync(temporary, { force: true });
  }
}

export function pruneMigrationBackups(directory) {
  if (!lstatSync(directory).isDirectory()) return;
  const managed = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && filenamePattern.test(entry.name))
    .map(({ name }) => ({ name, time: Number(filenamePattern.exec(name)[1]) }))
    .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const { name } of managed.slice(5)) rmSync(join(directory, name), { force: true });
}
