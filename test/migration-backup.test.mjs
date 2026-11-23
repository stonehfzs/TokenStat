import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { openStore } from '../lib/store.mjs';

function record(id) {
  return { id, provider: 'codex', model: 'gpt-6.2-sol', date: '2026-11-22T09:30:00.000Z',
    input: 100, output: 10, cached: 80, reasoning: 0, total: 110 };
}

async function fixture(t, version = 5) {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-pre-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openStore(root);
  try { store.importBatch('import.csv', [record('import-1')]); } finally { store.close(); }
  const database = join(root, 'tokenstat.db');
  const old = new DatabaseSync(database);
  old.exec(`ALTER TABLE source_files DROP COLUMN diagnostics;
    INSERT INTO daily_cache (zone, entries) VALUES ('UTC', '[]');
    PRAGMA user_version = ${version};`);
  if (version === 4) old.exec(`
    DROP INDEX sync_events_device_time;
    DROP TABLE sync_retired_peers;
    DROP TABLE sync_peer_months;
    DROP TABLE own_sync_months;
    ALTER TABLE sync_peers DROP COLUMN protocol;
  `);
  old.close();
  return { root, database, backups: join(root, 'migration-backups') };
}

function inspect(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      imports: database.prepare('SELECT count(*) AS count FROM imported_events').get().count,
      caches: database.prepare('SELECT count(*) AS count FROM daily_cache').get().count,
      diagnostics: database.prepare('PRAGMA table_info(source_files)').all().some(({ name }) => name === 'diagnostics'),
    };
  } finally { database.close(); }
}

test('schema 6 creates a private standalone version 5 backup including committed WAL records', async (t) => {
  const { root, database, backups } = await fixture(t);
  const old = new DatabaseSync(database);
  try {
    old.exec('PRAGMA wal_autocheckpoint = 0;');
    const columns = old.prepare('PRAGMA table_info(imported_events)').all().map(({ name }) => name);
    const values = columns.map((name) => name === 'id' ? "'import-wal'" : name);
    old.exec(`INSERT INTO imported_events (${columns.join(',')}) SELECT ${values.join(',')} FROM imported_events WHERE id = 'import-1';`);
    assert(statSync(database + '-wal').size > 0);
    const migrated = openStore(root);
    migrated.close();
  } finally { old.close(); }

  const [backup, ...unexpected] = await readdir(backups);
  assert.deepEqual(unexpected, []);
  assert.match(backup, /^tokenstat-v5-to-v6-/);
  assert.deepEqual(inspect(join(backups, backup)), { version: 5, imports: 2, caches: 1, diagnostics: false });
  assert.deepEqual(inspect(database), { version: 6, imports: 2, caches: 0, diagnostics: true });
  if (process.platform !== 'win32') {
    assert.equal(statSync(backups).mode & 0o777, 0o700);
    assert.equal(statSync(join(backups, backup)).mode & 0o777, 0o600);
  }
  openStore(root).close();
  assert.deepEqual(await readdir(backups), [backup]);
});

test('version 4 is backed up before both upgrades and only five managed backups are kept', async (t) => {
  const { root, database, backups } = await fixture(t, 4);
  await mkdir(backups);
  const filenames = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const filename = `tokenstat-v4-to-v6-${1_700_000_000_000 + index}-${randomUUID()}.db`;
    await writeFile(join(backups, filename), 'old managed file');
    return filename;
  }));
  await writeFile(join(backups, 'my-manual-backup.db'), 'manual backup');
  openStore(root).close();
  const kept = await readdir(backups);
  assert.equal(kept.length, 6);
  assert.equal(await readFile(join(backups, 'my-manual-backup.db'), 'utf8'), 'manual backup');
  assert(filenames.slice(2).every((filename) => kept.includes(filename)));
  const actual = kept.find((filename) => filename.startsWith('tokenstat-v4-') && !filenames.includes(filename));
  assert.deepEqual(inspect(join(backups, actual)), { version: 4, imports: 1, caches: 1, diagnostics: false });
  assert.deepEqual(inspect(database), { version: 6, imports: 1, caches: 0, diagnostics: true });
});

test('backup failure aborts the migration and preserves old data', async (t) => {
  const { root, database, backups } = await fixture(t);
  await writeFile(backups, 'a preexisting file, not a backup directory');
  assert.throws(() => openStore(root), /无法创建升级前的 SQLite 备份/);
  assert.deepEqual(inspect(database), { version: 5, imports: 1, caches: 1, diagnostics: false });
});

test('migration rollback retains the independently readable backup', async (t) => {
  const { root, database, backups } = await fixture(t, 4);
  const corrupt = new DatabaseSync(database);
  try { corrupt.exec('ALTER TABLE source_files ADD COLUMN diagnostics TEXT;'); } finally { corrupt.close(); }
  assert.throws(() => openStore(root), /duplicate column name: diagnostics/);
  const [backup] = await readdir(backups);
  assert.deepEqual(inspect(database), { version: 4, imports: 1, caches: 1, diagnostics: true });
  assert.deepEqual(inspect(join(backups, backup)), inspect(database));
  const restored = new DatabaseSync(database);
  try {
    const fields = restored.prepare('PRAGMA table_info(sync_peers)').all();
    assert(!fields.some(({ name }) => name === 'protocol'));
  } finally { restored.close(); }
});

test('concurrent opens create a single pre-migration backup', { timeout: 15_000 }, async (t) => {
  const { root, database, backups } = await fixture(t);
  const module = new URL('../lib/store.mjs', import.meta.url).href;
  const entry = new URL('data:text/javascript,' + encodeURIComponent(`
    import { workerData } from 'node:worker_threads';
    import { openStore } from ${JSON.stringify(module)};
    openStore(workerData).close();
  `));
  const launch = () => new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData: root, execArgv: [] });
    worker.on('error', reject);
    worker.on('exit', (code) => code ? reject(new Error(`Upgrade worker failed with code ${code}`)) : resolve());
  });
  await Promise.all([launch(), launch()]);
  assert.equal((await readdir(backups)).length, 1);
  assert.equal(inspect(database).version, 6);
});
