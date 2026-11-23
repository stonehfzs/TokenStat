import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { openStore } from '../lib/store.mjs';
import { createSync } from '../lib/sync.mjs';

const timezone = 'Asia/Shanghai';

function record(id, date, input = 100) {
  return {
    id, provider: 'codex', model: 'gpt-6.2-sol', date, input,
    output: 1, cached: 4, cacheWrite: 0, reasoning: 0, total: input + 1,
    requestLevel: true, source: 'Codex',
  };
}

function total(store, device) {
  return store.readUsage(timezone, { device }).reduce((sum, entry) => sum + entry.total, 0);
}

async function fixture(t, senderOptions, receiverOptions) {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-month-test-'));
  const shared = join(root, 'shared');
  await mkdir(shared);
  const sender = openStore(join(root, 'sender'));
  const receiver = openStore(join(root, 'receiver'));
  let a = createSync(sender, senderOptions);
  const b = createSync(receiver, receiverOptions);
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
    sender.close();
    receiver.close();
    await rm(root, { recursive: true, force: true });
  });
  const pairing = await a.configure({ folder: shared, deviceName: 'Sender', enabled: true });
  await b.configure({ folder: shared, deviceName: 'Receiver', enabled: true, key: pairing.pairingKey });
  return {
    sender, receiver, get a() { return a; }, b, pairing, shared,
    device: sender.getSyncIdentity().deviceId,
    directory: join(shared, 'TokenStat-sync', 'v2', pairing.keyId),
    async reopenSender(options = senderOptions) {
      await a.close();
      a = createSync(sender, options);
    },
    replace(records, stamp, append = false) {
      sender.cache.applyChanges('codex', { updates: [{ path: join(root, 'own-log'), stamp,
        result: { records, incomplete: 0, append } }] });
    },
  };
}

test('reuses historical shards after restart and filters by device on local day boundaries', async (t) => {
  const f = await fixture(t);
  const older = record('older', '2026-10-31T16:10:00.000Z');
  const recent = record('recent', '2026-11-20T07:00:00.000Z', 20);
  f.replace([older, recent], 'first');
  assert.equal((await f.a.run()).state, 'ok');
  assert.equal((await f.b.run()).peers[0].protocol, 2);
  assert.equal(total(f.receiver, f.device), 122);
  assert.equal(total(f.receiver, 'local'), 0);
  assert.deepEqual(f.receiver.readDeviceUsage(timezone, { from: '2026-11-01', to: '2026-11-01' })
    .map(({ id, total }) => [id, total]), [['local', 0], [f.device, 101]]);
  assert.equal(f.receiver.readDay(timezone, '2026-11-01', { device: f.device }).hourly[0].total, 101);
  const historicalPath = join(f.directory, f.device + '.2026-10.0.shard');
  const historicalStamp = await stat(historicalPath);
  const historicalBytes = await readFile(historicalPath);
  assert.equal(historicalBytes.includes('gpt-6.2-sol'), false);

  let monthReads = [];
  await f.reopenSender();
  const readMonth = f.sender.readOwnSyncMonth;
  f.sender.readOwnSyncMonth = (...args) => {
    monthReads.push(args[0]);
    return readMonth(...args);
  };
  f.replace([record('latest', '2026-11-21T16:00:01.000Z', 40)], 'next', true);
  assert.equal((await f.a.run()).state, 'ok');
  assert.equal((await f.b.run()).state, 'ok');
  assert.deepEqual(monthReads, ['2026-11']);
  assert.deepEqual(await readFile(historicalPath), historicalBytes);
  assert.equal((await stat(historicalPath)).mtimeMs, historicalStamp.mtimeMs);
  assert.equal(total(f.receiver, f.device), 163);

  monthReads = [];
  const manifestPath = join(f.directory, f.device + '.manifest');
  const manifest = await stat(manifestPath);
  await f.a.run();
  await f.b.run();
  assert.deepEqual(monthReads, []);
  assert.equal((await stat(manifestPath)).mtimeMs, manifest.mtimeMs);
});

test('stages cross-month moves and removals until every changed shard is authenticated', async (t) => {
  const f = await fixture(t);
  f.replace([
    record('moves', '2026-09-01T03:30:00.000Z', 10),
    record('removed', '2026-10-14T12:00:00.000Z', 30),
    record('stays', '2026-11-19T12:00:00.000Z', 50),
  ], 'first');
  await f.a.run();
  await f.b.run();
  assert.equal(total(f.receiver, f.device), 93);
  f.replace([
    record('moves', '2026-12-02T03:30:00.000Z', 10),
    record('stays', '2026-11-19T12:00:00.000Z', 50),
  ], 'moves-and-deletions');
  await f.a.run();
  const shard = join(f.directory, f.device + '.2026-12.0.shard');
  const delayed = shard + '.delayed';
  await rename(shard, delayed);
  const pending = await f.b.run();
  assert.match(pending.lastError, /等待共享文件同步/);
  assert.equal(total(f.receiver, f.device), 93);
  assert.equal(f.receiver.readUsage(timezone, { device: f.device }).length, 3);

  const correct = await readFile(delayed);
  const malformed = Buffer.from(correct);
  malformed[malformed.length - 1] ^= 1;
  await writeFile(shard, malformed);
  const failed = await f.b.run();
  assert.equal(failed.state, 'error');
  assert.deepEqual(failed.peerIssues.find((item) => item.deviceId === f.device).months, [
    { month: '2026-12', state: 'corrupt', reason: 'shard-authentication-failed' },
  ]);
  assert.equal(total(f.receiver, f.device), 93);
  await writeFile(shard, correct);
  assert.equal((await f.b.run()).state, 'ok');
  assert.equal(total(f.receiver, f.device), 62);
  assert.deepEqual(f.receiver.readUsage(timezone, { device: f.device }).map((entry) => entry.date),
    ['2026-12-02', '2026-11-19']);
  assert.equal(f.receiver.readSyncPeers()[0].count, 2);
});

test('the audit reports peer faults and only the owner repairs shards into alternate slots', async (t) => {
  const f = await fixture(t);
  f.replace([
    record('september', '2026-09-13T12:00:00.000Z', 20),
    record('october', '2026-10-14T12:00:00.000Z', 10),
    record('november', '2026-11-19T12:00:00.000Z', 50),
  ], 'published');
  await f.a.run();
  const revision = f.sender.getSyncIdentity().revision;
  const manifest = join(f.directory, f.device + '.manifest');
  const previousManifest = await readFile(manifest);
  const truncatedSlot = join(f.directory, f.device + '.2026-09.0.shard');
  const olderSlot = join(f.directory, f.device + '.2026-10.0.shard');
  const missingSlot = join(f.directory, f.device + '.2026-11.0.shard');
  const truncated = (await readFile(truncatedSlot)).subarray(0, 12);
  const corrupted = await readFile(olderSlot);
  corrupted[corrupted.length - 1] ^= 1;
  await writeFile(truncatedSlot, truncated);
  await writeFile(olderSlot, corrupted);
  await rm(missingSlot);

  const passive = await f.b.run();
  assert.equal(total(f.receiver), 0);
  assert.deepEqual(passive.peerIssues.find((item) => item.deviceId === f.device).months, [
    { month: '2026-11', state: 'missing', reason: 'shard-missing' },
  ]);
  const remoteAudit = await f.b.verifyAndRepair();
  assert.equal(remoteAudit.status, 'attention');
  assert.equal(remoteAudit.repairedMonths, 0);
  assert.deepEqual(remoteAudit.devices.find((item) => item.deviceId === f.device).months, [
    { month: '2026-09', state: 'corrupt', reason: 'shard-invalid' },
    { month: '2026-10', state: 'corrupt', reason: 'shard-authentication-failed' },
    { month: '2026-11', state: 'missing', reason: 'shard-missing' },
  ]);
  assert.equal(f.b.status().lastVerification.checkedAt, remoteAudit.checkedAt);
  assert.deepEqual(await readFile(manifest), previousManifest);
  assert.deepEqual(await readFile(olderSlot), corrupted);

  const repaired = await f.a.verifyAndRepair();
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.repairedMonths, 3);
  const local = repaired.devices.find((item) => item.local);
  assert.equal(local.revision, revision);
  assert.deepEqual(local.months, [
    { month: '2026-09', state: 'repaired', reason: 'rebuilt-from-local-data', previousReason: 'shard-invalid' },
    { month: '2026-10', state: 'repaired', reason: 'rebuilt-from-local-data', previousReason: 'shard-authentication-failed' },
    { month: '2026-11', state: 'repaired', reason: 'rebuilt-from-local-data', previousReason: 'shard-missing' },
  ]);
  assert.notDeepEqual(await readFile(manifest), previousManifest);
  assert.deepEqual(await readFile(truncatedSlot), truncated);
  assert.deepEqual(await readFile(olderSlot), corrupted);
  await stat(join(f.directory, f.device + '.2026-09.1.shard'));
  await stat(join(f.directory, f.device + '.2026-10.1.shard'));
  await stat(join(f.directory, f.device + '.2026-11.1.shard'));
  assert.equal(f.sender.getSyncIdentity().revision, revision);
  assert.equal((await f.b.run()).state, 'ok');
  assert.equal(total(f.receiver, f.device), 83);
  assert.equal((await f.a.verifyAndRepair()).status, 'ok');
});

test('the audit repairs a newer local month and publishes a removed month as empty', async (t) => {
  const f = await fixture(t);
  f.replace([
    record('october', '2026-10-14T12:00:00.000Z'),
    record('november', '2026-11-12T12:00:00.000Z'),
  ], 'published');
  await f.a.run();
  await f.b.run();
  assert.equal(total(f.receiver, f.device), 202);
  const manifest = join(f.directory, f.device + '.manifest');
  const previousManifest = await readFile(manifest);
  await rm(join(f.directory, f.device + '.2026-10.0.shard'));
  await rm(join(f.directory, f.device + '.2026-11.0.shard'));
  f.replace([record('october', '2026-10-14T12:00:00.000Z', 500)], 'newer-local');

  const [repaired] = await Promise.all([f.a.verifyAndRepair(), f.a.run()]);
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.repairedMonths, 2);
  const local = repaired.devices.find((item) => item.local);
  assert.equal(local.revision, f.sender.getSyncIdentity().revision);
  assert.deepEqual(local.months, [
    { month: '2026-10', state: 'repaired', reason: 'rebuilt-from-local-data', previousReason: 'shard-missing' },
    { month: '2026-11', state: 'repaired', reason: 'rebuilt-from-local-data', previousReason: 'shard-missing' },
  ]);
  assert.notDeepEqual(await readFile(manifest), previousManifest);
  await stat(join(f.directory, f.device + '.2026-10.1.shard'));
  await assert.rejects(() => stat(join(f.directory, f.device + '.2026-11.1.shard')), { code: 'ENOENT' });
  await f.b.run();
  assert.equal(total(f.receiver, f.device), 501);
  assert.deepEqual((await f.a.verifyAndRepair()).devices.find((item) => item.local).months, [
    { month: '2026-10', state: 'verified', reason: null },
    { month: '2026-11', state: 'empty', reason: null },
  ]);
});

test('the audit defers writes if the local revision changes mid-repair or storage is offline', async (t) => {
  const f = await fixture(t);
  f.replace([record('october', '2026-10-14T12:00:00.000Z')], 'published');
  await f.a.run();
  const manifest = join(f.directory, f.device + '.manifest');
  const previousManifest = await readFile(manifest);
  await rm(join(f.directory, f.device + '.2026-10.0.shard'));
  const readMonth = f.sender.readOwnSyncMonth;
  f.sender.readOwnSyncMonth = (month, revision) => {
    f.sender.readOwnSyncMonth = readMonth;
    const entries = readMonth(month, revision);
    f.replace([record('october', '2026-10-14T12:00:00.000Z', 500)], 'newer-local');
    return entries;
  };

  const blocked = await f.a.verifyAndRepair();
  assert.equal(blocked.status, 'attention');
  assert.equal(blocked.repairedMonths, 0);
  assert.deepEqual(blocked.devices.find((item) => item.local).months, [
    { month: '2026-10', state: 'missing', reason: 'local-revision-changed', previousReason: 'shard-missing' },
  ]);
  assert.deepEqual(await readFile(manifest), previousManifest);
  await assert.rejects(() => stat(join(f.directory, f.device + '.2026-10.1.shard')), { code: 'ENOENT' });

  const moved = f.shared + '-offline';
  await rename(f.shared, moved);
  try {
    const offline = await f.a.verifyAndRepair();
    assert.equal(offline.status, 'offline');
    assert.equal(offline.reason, 'folder-offline');
    assert.equal(offline.repairedMonths, 0);
    assert.equal(offline.devices.find((item) => item.local).status, 'offline');
    await assert.rejects(() => stat(f.shared), { code: 'ENOENT' });
  } finally {
    await rename(moved, f.shared);
  }
  assert.equal((await f.a.verifyAndRepair()).status, 'repaired');
  assert.equal((await f.a.verifyAndRepair()).status, 'ok');
  await f.b.run();
  assert.equal(total(f.receiver, f.device), 501);
});

async function writeLegacy(f) {
  const legacyFolder = join(f.shared, 'TokenStat-sync', 'v1', f.pairing.keyId);
  await mkdir(legacyFolder, { recursive: true });
  const local = f.sender.readOwnSyncRecords();
  const material = Buffer.from(hkdfSync('sha256', Buffer.from(f.pairing.pairingKey, 'base64url'),
    'TokenStat folder sync', 'v1', 64));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', material.subarray(0, 32), nonce);
  cipher.setAAD(Buffer.from('TokenStat/1/' + f.pairing.keyId + '/' + f.device));
  const payload = gzipSync(Buffer.from(JSON.stringify({ version: 1, deviceName: 'Sender', ...local })));
  await writeFile(join(legacyFolder, f.device + '.snapshot'),
    Buffer.concat([Buffer.from('TSTAT-SYNC-1\n'), nonce, cipher.update(payload), cipher.final(), cipher.getAuthTag()]));
}

test('upgrades an equal legacy revision, rejects legacy replay, and retires only locally', async (t) => {
  const f = await fixture(t);
  f.replace([record('legacy-id', '2026-09-01T03:30:00.000Z')], 'first');
  await writeLegacy(f);
  assert.equal((await f.b.run()).peers[0].protocol, 1);
  assert.equal(total(f.receiver, f.device), 101);
  await f.a.run();
  assert.equal((await f.b.run()).peers[0].protocol, 2);
  assert.equal(total(f.receiver, f.device), 101);
  const manifest = join(f.directory, f.device + '.manifest');
  await rename(manifest, manifest + '.delayed');
  assert.match((await f.b.run()).lastError, /较旧/);
  assert.equal(f.receiver.readSyncPeers()[0].protocol, 2);
  assert.equal(total(f.receiver, f.device), 101);
  await rename(manifest + '.delayed', manifest);

  assert.equal((await f.b.retirePeer(f.device)).changed, true);
  assert.equal(total(f.receiver), 0);
  assert.equal((await f.b.run()).peers.length, 0);
  assert.equal(f.b.status().retired[0].deviceId, f.device);
  assert.equal((await readdir(f.directory)).includes(f.device + '.manifest'), true);
  await f.b.restorePeer(f.device);
  assert.equal((await f.b.run()).peers.length, 1);
  assert.equal(total(f.receiver, f.device), 101);
});

test('desktop vault migration and local configuration backup omit synchronization secrets', async (t) => {
  const f = await fixture(t);
  const vault = {
    available: async () => true,
    encrypt: async (key) => Buffer.from('sealed:' + key).toString('base64'),
    decrypt: async (data) => Buffer.from(data, 'base64').toString().slice(7),
  };
  await f.reopenSender({ keyVault: vault });
  assert.equal((await f.a.run()).state, 'ok');
  const saved = f.sender.getSyncConfig();
  assert(!Object.hasOwn(saved, 'key'));
  assert(saved.sealedKey);
  assert.equal(await f.a.getPairingKey(), f.pairing.pairingKey);
  await f.reopenSender({ keyVault: { ...vault, available: async () => false } });
  // With no working vault, a new credential cannot be written or activate a different sync group.
  await assert.rejects(() => f.a.configure({ key: randomBytes(32).toString('base64url') }), /密钥库/);
  assert.deepEqual(f.sender.getSyncConfig(), saved);

  f.sender.setPath('codex', '/example/logs');
  f.sender.setPreferences({ locale: 'en', currency: 'USD', timeZone: timezone });
  f.sender.importBatch('user-import.csv', [record('user-import', '2026-11-22T01:00:00.000Z')]);
  const backup = f.sender.exportBackup();
  const exportedText = JSON.stringify(backup);
  assert(!exportedText.includes(f.pairing.pairingKey));
  assert(!exportedText.includes(saved.sealedKey));
  assert.equal(f.receiver.restoreBackup(backup).added, 1);
  assert.equal(f.receiver.restoreBackup(backup).added, 0);
  assert.equal(f.receiver.getPaths().codex, '/example/logs');
  assert.equal(f.receiver.getPreferences().locale, 'en');
  const invalid = { ...backup, paths: { codex: '/invalid' }, records: [{ ...backup.records[0], session: '/raw/session' }] };
  assert.throws(() => f.receiver.restoreBackup(invalid), /无效的用量记录/);
  assert.equal(f.receiver.getPaths().codex, '/example/logs');
  assert.equal(f.receiver.deleteImport(f.receiver.getImports()[0].id).removed, 1);
});

test('upgrades a populated v4 database and plans months from its existing cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-v4-upgrade-'));
  let store = openStore(root);
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  store.importBatch('saved.csv', [
    record('before-upgrade-1', '2026-10-31T23:59:59.999Z'),
    record('before-upgrade-2', '2026-11-01T00:00:00.000Z'),
  ]);
  const oldIdentity = store.getSyncIdentity();
  store.close();
  store = undefined;
  const old = new DatabaseSync(join(root, 'tokenstat.db'));
  old.exec(`
    DROP INDEX sync_events_device_time;
    DROP TABLE sync_retired_peers;
    DROP TABLE sync_peer_months;
    DROP TABLE own_sync_months;
    ALTER TABLE sync_peers DROP COLUMN protocol;
    ALTER TABLE source_files DROP COLUMN diagnostics;
    PRAGMA user_version = 4;
  `);
  old.close();
  store = openStore(root);
  assert.deepEqual(store.getSyncIdentity(), oldIdentity);
  assert.deepEqual(store.readOwnSyncPlan().months.map(({ month }) => month), ['2026-10', '2026-11']);
  assert.equal(store.readOwnSyncMonth('2026-10', oldIdentity.revision).length, 1);
  assert.equal(store.readOwnSyncMonth('2026-11', oldIdentity.revision).length, 1);
  assert.equal(total(store, 'local'), 202);
});
