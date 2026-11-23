import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBackupTransfer } from '../lib/backups.mjs';
import { defaultPreferences } from '../lib/preferences.mjs';
import { openStore } from '../lib/store.mjs';
import { startServer } from '../server.mjs';

const limits = { partBytes: 2048, partItems: 2 };
const providers = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo', 'kilo', 'opencode'];
const records = Array.from({ length: 5 }, (_, index) => ({
  id: 'backup-' + index, provider: 'codex', model: 'gpt-6.2-sol',
  date: '2026-11-23T03:00:00.000Z', input: 30 + index, output: 2,
  cached: 10, reasoning: 1, total: 32 + index, source: 'import', requestLevel: true,
}));

function temporaryStores(context) {
  const root = mkdtempSync(join(tmpdir(), 'tokenstat-backups-test-'));
  const stores = [];
  const dirs = new Map();
  const transfers = [];
  context.after(() => {
    for (const transfer of transfers) transfer.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store(name) {
      const dir = join(root, name);
      const store = openStore(dir);
      dirs.set(store, dir);
      stores.push(store);
      return store;
    },
    transfer(store, options = limits) {
      const transfer = createBackupTransfer(store, dirs.get(store), options);
      transfers.push(transfer);
      return transfer;
    },
  };
}

test('stages volumes privately in the data directory and prunes only expired dead runs', (context) => {
  const fixtures = temporaryStores(context);
  const source = fixtures.store('source');
  const staging = join(fixtures.root, 'source', 'backup-transfers');
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ifError(child.error);
  assert.equal(child.status, 0);
  const expired = join(staging, `run-${child.pid}-oldAb1`);
  const recent = join(staging, `run-${child.pid}-newAb2`);
  const live = join(staging, `run-${process.pid}-liveA3`);
  const unmanaged = join(staging, 'keep-this-directory');
  for (const path of [expired, recent, live, unmanaged]) mkdirSync(path, { recursive: true });
  const oldTime = new Date(Date.now() - 31 * 60_000);
  for (const path of [expired, live, unmanaged]) utimesSync(path, oldTime, oldTime);

  source.importBatch('fixture.jsonl', records);
  const transfer = fixtures.transfer(source);
  assert.equal(existsSync(expired), false);
  for (const path of [recent, live, unmanaged]) assert.equal(existsSync(path), true);
  multipart(transfer);
  const run = readdirSync(staging).find((name) => name.startsWith(`run-${process.pid}-`) && join(staging, name) !== live);
  assert(run);
  const [session] = readdirSync(join(staging, run));
  const part = join(staging, run, session, '1.json');
  assert.equal(existsSync(part), true);
  if (process.platform !== 'win32') {
    for (const path of [staging, join(staging, run), join(staging, run, session)]) assert.equal(statSync(path).mode & 0o777, 0o700);
    assert.equal(statSync(part).mode & 0o777, 0o600);
  }
  transfer.close();
  assert.equal(existsSync(join(staging, run)), false);
});

function staged(transfer, volumes) {
  const { id } = transfer.beginRestore();
  for (const volume of volumes) transfer.stage(id, volume);
  return id;
}

function multipart(transfer) {
  const exported = transfer.exportBackup();
  assert.equal(exported.format, 'tokenstat-backup-download');
  assert(exported.partCount > 1);
  const volumes = exported.parts.map(({ partIndex }) => transfer.volume(exported.backupId, partIndex));
  return { exported, volumes };
}

test('restores verified volumes in any order and retains one undoable batch across volume boundaries', (context) => {
  const fixtures = temporaryStores(context);
  const source = fixtures.store('source');
  const target = fixtures.store('target');
  source.setPath('codex', '/source/logs');
  source.setPriceOverrides([{ provider: 'codex', model: 'gpt-6.2-sol', input: 2, output: 10 }]);
  source.setPreferences({ ...defaultPreferences, locale: 'en', currency: 'CNY', cnyPerUsd: 7 });
  source.setSyncConfig({ enabled: false, deviceName: 'Test source', key: 'fixture-private-sync-key' });
  assert.equal(source.importBatch('same-batch.jsonl', records).added, 5);

  target.setPath('codex', '/target/logs');
  target.importBatch('already-imported.jsonl', [records[0]]);
  const original = target.exportBackup();
  const revision = target.getSyncIdentity().revision;
  const receiver = fixtures.transfer(target);
  const { exported, volumes } = multipart(fixtures.transfer(source));
  assert(volumes.filter(({ entries }) => entries.some(({ kind }) => kind === 'record')).length > 1);
  assert(!JSON.stringify(volumes).includes('fixture-private-sync-key'));

  const id = staged(receiver, [...volumes].reverse());
  assert.throws(() => receiver.restoreVolumes(id, false), /请先预检/);
  const expected = {
    added: 4, duplicate: 1, paths: 1, priceOverrides: 1, preferences: 4,
    volumes: { verified: true, received: exported.partCount, expected: exported.partCount },
  };
  assert.deepEqual(receiver.restoreVolumes(id, true), expected);
  assert.deepEqual(target.exportBackup(), original);
  assert.equal(target.getSyncIdentity().revision, revision);
  assert.deepEqual(receiver.restoreVolumes(id, false), expected);
  assert.equal(target.getPaths().codex, '/source/logs');
  assert.equal(target.getPriceOverrides()[0].input, 2);
  assert.equal(target.getPreferences().locale, 'en');
  assert.throws(() => receiver.restoreVolumes(id, false), /已过期/);

  const duplicate = staged(receiver, volumes);
  const repeated = { ...expected, added: 0, duplicate: 5, paths: 0, priceOverrides: 0, preferences: 0 };
  assert.deepEqual(receiver.restoreVolumes(duplicate, true), repeated);
  assert.deepEqual(receiver.restoreVolumes(duplicate, false), repeated);
  assert.equal(target.getSyncIdentity().revision, revision + 1);
  const undoable = target.getImports().find((batch) => batch.filename === 'same-batch.jsonl');
  assert.equal(undoable.added, 4);
  assert.equal(target.getImports().filter((batch) => batch.filename === undoable.filename).length, 1);
  assert.deepEqual(target.deleteImport(undoable.id), { id: undoable.id, removed: 4 });
  assert.deepEqual(target.exportBackup().records.map(({ id }) => id), [records[0].id]);
});

test('rejects missing, corrupt, or mixed volumes before changing target data', (context) => {
  const fixtures = temporaryStores(context);
  const source = fixtures.store('source');
  const target = fixtures.store('target');
  target.setPath('codex', '/target/logs');
  const unchanged = target.exportBackup();
  source.importBatch('fixture.jsonl', records);
  const sender = fixtures.transfer(source);
  const receiver = fixtures.transfer(target);
  const first = multipart(sender);
  const second = multipart(sender);

  const id = staged(receiver, first.volumes.slice(1));
  assert.throws(() => receiver.restoreVolumes(id, true), /分卷不完整/);
  const corrupt = structuredClone(first.volumes[0]);
  corrupt.entries[0].data.paths.codex = '/tampered';
  assert.throws(() => receiver.stage(id, corrupt), /备份分卷校验失败/);
  assert.throws(() => receiver.stage(id, second.volumes[0]), /来自不同备份/);
  assert.deepEqual(target.exportBackup(), unchanged);
  receiver.remove(id);
  assert.throws(() => receiver.stage(id, first.volumes[0]), /已过期/);

  const brokenBundle = staged(receiver, first.volumes.map((volume) => ({ ...volume, bundleSha256: '0'.repeat(64) })));
  assert.throws(() => receiver.restoreVolumes(brokenBundle, true), /分卷组校验失败/);
  assert.deepEqual(target.exportBackup(), unchanged);
});

test('keeps the legacy single-file format and previews a restore without changing it', (context) => {
  const fixtures = temporaryStores(context);
  const source = fixtures.store('source');
  const target = fixtures.store('target');
  source.importBatch('one.jsonl', [records[0]]);
  const payload = fixtures.transfer(source, { partBytes: 2048, partItems: 10 }).exportBackup();
  assert.equal(payload.format, 'tokenstat-backup');
  assert.equal(payload.version, 1);
  const preview = target.restoreBackup(payload, { dryRun: true });
  assert.equal(preview.added, 1);
  assert.equal(target.exportBackup().records.length, 0);
  assert.deepEqual(target.restoreBackup(payload), preview);
  assert.equal(target.exportBackup().records.length, 1);
});

test('exposes volume download, staging, preview, restore, and cancellation on loopback', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'tokenstat-backups-http-'));
  let backend;
  context.after(async () => {
    try { await backend?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const emptyLogs = join(root, 'logs');
  const dataDir = join(root, 'data');
  mkdirSync(emptyLogs);
  const store = openStore(dataDir);
  try {
    for (const provider of providers) store.setPath(provider, emptyLogs);
    store.importBatch('same-batch.jsonl', records);
  } finally { store.close(); }
  backend = await startServer({ port: 0, dataDir, backupParts: limits });

  const request = async (path, method, body) => {
    const response = await fetch(backend.url + path, {
      method,
      headers: { Origin: backend.url, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };
  const post = async (path, body = {}) => {
    const { response, payload } = await request(path, 'POST', body);
    assert.equal(response.ok, true, payload.error);
    return payload;
  };

  const exported = await post('/api/backup/export');
  assert.equal(exported.format, 'tokenstat-backup-download');
  const volumes = await Promise.all(exported.parts.map(async ({ url }) => {
    const { response, payload } = await request(url, 'GET');
    assert.equal(response.ok, true, payload.error);
    return payload;
  }));
  const { id } = await post('/api/backup/transfers');
  const transfer = '/api/backup/transfers/' + id;
  for (const volume of volumes) await post(transfer + '/volume', volume);
  const preview = await post(transfer + '/restore?dryRun=true');
  assert.deepEqual(preview.volumes, { verified: true, received: exported.partCount, expected: exported.partCount });
  assert.equal(preview.duplicate, records.length);
  assert.deepEqual(await post(transfer + '/restore'), preview);

  const empty = '/api/backup/transfers/' + (await post('/api/backup/transfers')).id;
  const { response } = await request(empty, 'DELETE');
  assert.equal(response.ok, true);
  assert.equal((await request(empty + '/volume', 'POST', volumes[0])).response.status, 400);
});
