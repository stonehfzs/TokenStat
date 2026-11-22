import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pricingTier } from './pricing.mjs';

const DAY_MS = 86_400_000;
const TOKEN_FIELDS = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'];
const SOURCE_PROVIDERS = new Set(['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo']);
const MAX_SYNC_RECORDS = 250_000;
const MAX_SYNC_PEERS = 32;
const MAX_SYNC_TOTAL = Math.floor(Number.MAX_SAFE_INTEGER / (MAX_SYNC_PEERS + 2));
const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const eventIdPattern = /^[A-Za-z0-9_:-]{1,180}$/;
const sessionPattern = /^(?:[a-z-]+-)?[0-9a-f]{24}$/;
const dbFields = 'id, model, source, time_ms, date_only, session, input, output, cached, cache_write, reasoning, total, reasoning_known, request_level, cost_usd_ticks';
const eventColumns = dbFields.split(', ').map((column) => 'event.' + column).join(', ');
const incomingColumns = eventColumns.replace('event.source', "('同步 · ' || peer.device_name) AS source");
const emptyMetrics = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0, count: 0, withoutReasoning: 0,
  reportedCostTicks: 0, reportedCostRecords: 0 };
const metrics = `SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached,
  SUM(cache_write) AS cacheWrite, SUM(reasoning) AS reasoning, SUM(total) AS total,
  COUNT(*) AS count, SUM(1 - reasoning_known) AS withoutReasoning,
  COALESCE(SUM(cost_usd_ticks), 0) AS reportedCostTicks, COUNT(cost_usd_ticks) AS reportedCostRecords`;
const importFields = 'id, filename, date, total, added, removable';

const recordFields = `
  id TEXT NOT NULL,
  model TEXT,
  source TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  date_only TEXT,
  session TEXT,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cached INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  total INTEGER NOT NULL,
  reasoning_known INTEGER NOT NULL,
  request_level INTEGER NOT NULL DEFAULT 0,
  cost_usd_ticks INTEGER
`;

const usageView = `CREATE VIEW usage_events AS
    SELECT provider, ${dbFields} FROM imported_events
    UNION ALL
    SELECT owner.provider, ${eventColumns}
      FROM file_events event JOIN event_owners owner USING(file_id, id);`;

const syncSchema = `
  CREATE TABLE sync_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT;
  CREATE TABLE sync_peers (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    count INTEGER NOT NULL,
    synced_at TEXT NOT NULL,
    signature TEXT
  ) STRICT;
  CREATE TABLE sync_events (
    device_id TEXT NOT NULL REFERENCES sync_peers(device_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    ${recordFields},
    PRIMARY KEY (device_id, provider, id)
  ) STRICT;
  CREATE INDEX sync_events_by_id ON sync_events(provider, id, device_id);
  CREATE INDEX sync_time ON sync_events(time_ms) WHERE date_only IS NULL;
  CREATE INDEX sync_day ON sync_events(date_only) WHERE date_only IS NOT NULL;
  CREATE TABLE sync_owners (
    provider TEXT NOT NULL,
    id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (provider, id),
    FOREIGN KEY (device_id, provider, id) REFERENCES sync_events(device_id, provider, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX sync_owners_by_device ON sync_owners(device_id, provider, id);

  DROP VIEW usage_events;
  CREATE VIEW own_usage_events AS
    SELECT provider, ${dbFields} FROM imported_events item
      WHERE NOT EXISTS (
        SELECT 1 FROM event_owners owner WHERE owner.provider = item.provider AND owner.id = item.id
      )
    UNION ALL
    SELECT owner.provider, ${eventColumns}
      FROM file_events event JOIN event_owners owner USING(file_id, id);
  CREATE VIEW usage_events AS
    SELECT * FROM own_usage_events
    UNION ALL
    SELECT event.provider, ${incomingColumns}
      FROM sync_events event
      JOIN sync_owners owner USING(device_id, provider, id)
      JOIN sync_peers peer USING(device_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM event_owners local WHERE local.provider = event.provider AND local.id = event.id
      ) AND NOT EXISTS (
        SELECT 1 FROM imported_events local WHERE local.provider = event.provider AND local.id = event.id
      );
`;

const schema = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE paths (provider TEXT PRIMARY KEY, path TEXT NOT NULL) STRICT;
  CREATE TABLE imports (
    ordinal INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    date TEXT NOT NULL,
    total INTEGER NOT NULL,
    added INTEGER NOT NULL,
    removable INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE TABLE imported_events (
    batch_id TEXT REFERENCES imports(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    ${recordFields},
    PRIMARY KEY (id)
  ) STRICT;
  CREATE INDEX imports_batch ON imported_events(batch_id);
  CREATE INDEX imports_model_time ON imported_events(provider, model, time_ms);
  CREATE INDEX imports_time ON imported_events(time_ms) WHERE date_only IS NULL;
  CREATE INDEX imports_day ON imported_events(date_only) WHERE date_only IS NOT NULL;

  CREATE TABLE source_files (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    path TEXT NOT NULL,
    stamp TEXT NOT NULL,
    count INTEGER NOT NULL,
    incomplete INTEGER NOT NULL,
    checkpoint TEXT,
    UNIQUE (provider, path)
  ) STRICT;
  CREATE TABLE file_events (
    file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    ${recordFields},
    PRIMARY KEY (file_id, id)
  ) STRICT;
  CREATE INDEX files_by_event ON file_events(id, file_id);
  CREATE INDEX files_model_time ON file_events(model, time_ms);
  CREATE INDEX files_time ON file_events(time_ms) WHERE date_only IS NULL;
  CREATE INDEX files_day ON file_events(date_only) WHERE date_only IS NOT NULL;
  CREATE TABLE event_owners (
    provider TEXT NOT NULL,
    id TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    PRIMARY KEY (provider, id),
    FOREIGN KEY (file_id, id) REFERENCES file_events(file_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX owners_by_file ON event_owners(file_id, id);
  ${usageView}
  CREATE TABLE daily_cache (zone TEXT PRIMARY KEY, entries TEXT NOT NULL, dirty_from INTEGER, dirty_to INTEGER) STRICT;
`;

function asDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) throw new Error('日期格式应为 YYYY-MM-DD。');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('日期无效。');
  return time;
}

function normalized(record) {
  if (typeof record.id !== 'string' || !record.id || typeof record.provider !== 'string' || !record.provider) {
    throw new Error('Token 记录缺少标识。');
  }
  const time = Date.parse(record.date);
  if (!Number.isSafeInteger(time)) throw new Error('Token 记录缺少有效的日期。');
  const counts = TOKEN_FIELDS.map((field) => field === 'cacheWrite' ? record[field] ?? 0 : record[field]);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error('Token 记录包含无效的数量。');
  return [
    record.id, record.model === '未知模型' ? null : record.model ?? null, record.source ?? 'import',
    time, record.dateOnly ? record.date.slice(0, 10) : null, record.session ?? null,
    ...counts, record.reasoningKnown === false ? 0 : 1, record.requestLevel === true ? 1 : 0,
    Number.isSafeInteger(record.costUsdTicks) && record.costUsdTicks >= 0 ? record.costUsdTicks : null,
  ];
}

function rawRecord(row, provider) {
  return {
    id: row.id, provider, model: row.model, source: row.source,
    date: new Date(row.time_ms).toISOString(), input: row.input, output: row.output,
    cached: row.cached, cacheWrite: row.cache_write, reasoning: row.reasoning, total: row.total,
    ...(row.date_only ? { dateOnly: true } : {}),
    ...(row.session ? { session: row.session } : {}),
    ...(!row.reasoning_known ? { reasoningKnown: false } : {}),
    ...(row.request_level ? { requestLevel: true } : {}),
    ...(row.cost_usd_ticks === null ? {} : { costUsdTicks: row.cost_usd_ticks }),
  };
}

function isSyncModel(model) {
  return model == null || (typeof model === 'string' && Boolean(model.trim()) && model.length <= 512
    && !/[\p{Cc}\p{Zl}\p{Zp}\\]/u.test(model) && !/^(?:\/|[a-z]:\/|~\/|\.\.?\/)/i.test(model.trim())
    && !/:\/\/|(?:^|\/)\.\.(?:\/|$)/.test(model));
}

function ownRecordForSync(row) {
  const raw = rawRecord(row, row.provider);
  const { source, session, ...record } = raw;
  if (!eventIdPattern.test(record.id) || (!SOURCE_PROVIDERS.has(record.provider) && record.provider !== 'other')) {
    throw new Error('本机有无法同步的用量记录标识。');
  }
  if (!isSyncModel(record.model)) record.model = null;
  if (typeof session === 'string' && sessionPattern.test(session)) record.session = session;
  return record;
}

function validateSyncSnapshot({ deviceId, deviceName, revision, records, signature }) {
  if (typeof deviceId !== 'string' || !deviceIdPattern.test(deviceId) || !Number.isSafeInteger(revision) || revision < 0
      || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 100 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(deviceName)) {
    throw new Error('同步快照的设备标识、名称或版本无效。');
  }
  if (!Array.isArray(records) || records.length > MAX_SYNC_RECORDS) throw new Error('每台设备最多同步 250,000 条用量记录。');
  if (signature != null && (typeof signature !== 'string' || signature.length > 512 || /[\p{Cc}]/u.test(signature))) {
    throw new Error('同步快照的文件标识无效。');
  }
}

function syncRecordValues(record, sums) {
  if (!record || typeof record.id !== 'string' || !eventIdPattern.test(record.id)
      || (!SOURCE_PROVIDERS.has(record.provider) && record.provider !== 'other')
      || !isSyncModel(record.model) || (record.session != null && (typeof record.session !== 'string' || !sessionPattern.test(record.session)))
      || ['dateOnly', 'reasoningKnown', 'requestLevel'].some((field) => record[field] != null && typeof record[field] !== 'boolean')) {
    throw new Error('同步快照包含无效的记录标识。');
  }
  const time = Date.parse(record.date);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== record.date || !/^\d{4}-/.test(record.date)
      || record.date.startsWith('0000') || (record.dateOnly && !record.date.endsWith('T00:00:00.000Z'))) {
    throw new Error('同步快照包含无效的时间。');
  }
  const values = normalized({ ...record, source: 'sync' });
  if (record.costUsdTicks != null && (!Number.isSafeInteger(record.costUsdTicks) || record.costUsdTicks < 0)) {
    throw new Error('同步快照包含无效的费用。');
  }
  for (const field of [...TOKEN_FIELDS, 'costUsdTicks']) {
    sums[field] = (sums[field] ?? 0) + (record[field] ?? 0);
    if (sums[field] > MAX_SYNC_TOTAL) throw new Error('同步快照的用量总和超出可统计范围。');
  }
  return values;
}

function importInfo(row) {
  return { ...row, removable: Boolean(row.removable) };
}

function migrateLegacy(file, { putPath, insertImport, insertImported }) {
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('无法读取原有 TokenStat 导入数据。', { cause: error });
  }
  if (state?.version !== 1 || !state.paths || typeof state.paths !== 'object' || Array.isArray(state.paths)
      || !Array.isArray(state.records) || !Array.isArray(state.imports)) {
    throw new Error('原有 TokenStat 导入数据格式无法识别。');
  }
  for (const [provider, path] of Object.entries(state.paths)) {
    if (typeof path === 'string' && SOURCE_PROVIDERS.has(provider)) putPath.run(provider, path);
  }
  const history = [...state.imports].reverse();
  const eventIds = new Set(state.records.map((record) => record.id));
  const knownAdditions = history.reduce((sum, row) => sum + Number(row?.added), 0);
  // The old server appended each batch's added rows in order and kept its last 100 history rows.
  const mapped = eventIds.size === state.records.length && knownAdditions <= state.records.length
    && history.every((row) => typeof row?.filename === 'string' && Number.isSafeInteger(row.added) && row.added > 0
      && Number.isSafeInteger(row.total) && row.total >= row.added);
  if (mapped && knownAdditions < state.records.length) {
    const count = state.records.length - knownAdditions;
    history.unshift({ filename: '原有导入数据', date: history[0]?.date, added: count, total: count, archived: true });
  }
  let rowIndex = 0;
  const addRecord = (id, record) => {
    const migrated = record.model === '未知模型' ? { ...record, model: null } : record;
    insertImported.run(id, migrated.provider, ...normalized(migrated));
  };
  for (const old of history) {
    if (!old || typeof old.filename !== 'string' || !Number.isSafeInteger(old.added) || !Number.isSafeInteger(old.total)) continue;
    const id = randomUUID();
    const date = typeof old.date === 'string' && Number.isFinite(Date.parse(old.date)) ? old.date : '1970-01-01T00:00:00.000Z';
    insertImport.run(id, old.filename, date, old.total, old.added, Number(mapped && !old.archived));
    if (mapped) {
      for (const record of state.records.slice(rowIndex, rowIndex + old.added)) addRecord(id, record);
      rowIndex += old.added;
    }
  }
  for (const record of state.records.slice(rowIndex)) addRecord(null, record);
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, 'tokenstat.db');
  try {
    closeSync(openSync(filename, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const db = new DatabaseSync(filename);
  let closed = false;
  // Prepared statements are reused by the common scan and query paths.
  const statements = new Map();
  function statement(sql) {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  }

  function transaction(work, write = true) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a failed write. */ }
      throw error;
    }
  }

  const putPathSql = 'INSERT INTO paths(provider,path) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET path = excluded.path';
  const insertImportSql = `INSERT INTO imports (${importFields}) VALUES(?,?,?,?,?,?)`;
  const params = new Array(dbFields.split(', ').length).fill('?').join(',');
  const insertImportedSql = `INSERT INTO imported_events (batch_id,provider,${dbFields})
    VALUES(?,?,${params}) ON CONFLICT(id) DO NOTHING`;
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    transaction(() => {
      const version = statement('PRAGMA user_version').get().user_version;
      if (version === 4) return;
      if (version === 1) {
        db.exec(`ALTER TABLE imported_events ADD COLUMN request_level INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE imported_events ADD COLUMN cost_usd_ticks INTEGER;
          ALTER TABLE file_events ADD COLUMN request_level INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE file_events ADD COLUMN cost_usd_ticks INTEGER;
          DROP VIEW usage_events;
          ${usageView}
          DELETE FROM daily_cache;`);
      } else if (version === 0) {
        db.exec(schema);
        migrateLegacy(join(dataDir, 'usage.json'), {
          putPath: statement(putPathSql),
          insertImport: statement(insertImportSql),
          insertImported: statement(insertImportedSql),
        });
      } else if (version !== 2 && version !== 3) {
        throw new Error('SQLite 用量数据库版本不受支持。');
      }
      if (version === 1 || version === 2) {
        db.exec('ALTER TABLE daily_cache ADD COLUMN dirty_from INTEGER; ALTER TABLE daily_cache ADD COLUMN dirty_to INTEGER;');
      }
      db.exec(syncSchema);
      statement('INSERT INTO sync_identity(singleton, device_id, revision) VALUES (1, ?, 0)').run(randomUUID());
      db.exec('PRAGMA user_version = 4;');
    });
    db.exec(`
      CREATE TEMP TABLE touched_events (id TEXT PRIMARY KEY) STRICT;
      CREATE TEMP TABLE touched_sync_events (provider TEXT, id TEXT, PRIMARY KEY(provider, id)) STRICT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  let formattedZone;
  let format;
  const timeParts = new Map();
  function localTime(time, zone) {
    if (zone !== formattedZone) {
      format = new Intl.DateTimeFormat('en', {
        timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      });
      formattedZone = zone;
      timeParts.clear();
    }
    let parts = timeParts.get(time);
    if (!parts) {
      const { year, month, day, hour } = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
      parts = { date: `${year.padStart(4, '0')}-${month}-${day}`, hour: Number(hour) };
      if (timeParts.size >= 65_536) timeParts.clear();
      timeParts.set(time, parts);
    }
    return parts;
  }
  db.function('event_day', { deterministic: true }, (time, zone) => localTime(time, zone).date);
  db.function('event_hour', { deterministic: true }, (time, zone) => localTime(time, zone).hour);
  db.function('request_price_tier', { deterministic: true }, pricingTier);

  function invalidateDailyCache() {
    statement('DELETE FROM daily_cache').run();
  }

  function markDailyDirty(first, last) {
    statement(`
      UPDATE daily_cache SET dirty_from = min(COALESCE(dirty_from, ?), ?),
        dirty_to = max(COALESCE(dirty_to, ?), ?)`).run(first, first, last, last);
  }

  function getSetting(key, fallback) {
    const row = statement('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  function setSetting(key, data) {
    statement('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(data));
  }

  function getSyncIdentity() {
    return { ...statement('SELECT device_id AS deviceId, revision FROM sync_identity WHERE singleton = 1').get() };
  }

  function bumpSyncRevision() {
    statement('UPDATE sync_identity SET revision = revision + 1 WHERE singleton = 1').run();
  }

  function getSyncConfig() {
    return getSetting('syncConfig', null);
  }

  function removeSyncPeers() {
    const peers = statement('DELETE FROM sync_peers').run().changes;
    if (peers) invalidateDailyCache();
    return peers;
  }

  function setSyncConfig(config, { clearPeers = false } = {}) {
    if (config !== null && (!config || typeof config !== 'object' || Array.isArray(config))) {
      throw new Error('同步配置格式无效。');
    }
    return transaction(() => {
      const previous = getSyncConfig();
      const clearedPeers = clearPeers || (previous?.key && config?.key && previous.key !== config.key)
        ? removeSyncPeers() : 0;
      if (previous?.deviceName !== config?.deviceName) bumpSyncRevision();
      setSetting('syncConfig', config);
      return { changed: Boolean(clearedPeers) || JSON.stringify(previous) !== JSON.stringify(config), clearedPeers };
    });
  }

  function readOwnSyncRecords() {
    return transaction(() => {
      const identity = getSyncIdentity();
      const rows = statement('SELECT * FROM own_usage_events ORDER BY provider, id LIMIT ?').all(MAX_SYNC_RECORDS + 1);
      if (rows.length > MAX_SYNC_RECORDS) throw new Error('每台设备最多同步 250,000 条用量记录。');
      return { ...identity, records: rows.map(ownRecordForSync) };
    }, false);
  }

  function readSyncPeers() {
    return statement(`
      SELECT device_id AS deviceId, device_name AS deviceName, revision, count, synced_at AS syncedAt, signature
      FROM sync_peers ORDER BY device_name, device_id`).all().map((row) => ({ ...row }));
  }

  function applySyncSnapshot(snapshot) {
    validateSyncSnapshot(snapshot);
    const { deviceId, deviceName, revision, records, signature = null } = snapshot;
    return transaction(() => {
      if (deviceId === getSyncIdentity().deviceId) return { changed: false, accepted: false };
      const previous = statement('SELECT revision, device_name FROM sync_peers WHERE device_id = ?').get(deviceId);
      if (previous && revision <= previous.revision) return { changed: false, accepted: false };
      if (!previous && statement('SELECT COUNT(*) AS count FROM sync_peers').get().count >= MAX_SYNC_PEERS) {
        throw new Error('最多可接收 32 台其他设备的用量。');
      }

      const previousRows = statement('SELECT provider, id, time_ms FROM sync_events WHERE device_id = ?').all(deviceId);
      const before = new Map(previousRows.map((row) => [row.provider + '\0' + row.id, row]));
      const renamed = Boolean(previous && deviceName !== previous.device_name);
      let dirtyFrom = Infinity;
      let dirtyTo = -Infinity;
      let recordsChanged = false;
      function touch(time) {
        if (!Number.isSafeInteger(time)) return;
        dirtyFrom = Math.min(dirtyFrom, time);
        dirtyTo = Math.max(dirtyTo, time);
      }
      if (renamed) for (const row of previousRows) touch(row.time_ms);

      statement(`
        INSERT INTO sync_peers(device_id, device_name, revision, count, synced_at, signature)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET device_name = excluded.device_name,
          revision = excluded.revision, count = excluded.count, synced_at = excluded.synced_at,
          signature = excluded.signature`).run(deviceId, deviceName, revision, records.length, new Date().toISOString(), signature);
      db.exec('DELETE FROM touched_sync_events;');
      const remember = statement('INSERT OR IGNORE INTO touched_sync_events VALUES (?,?)');
      const eventAttributes = dbFields.split(', ').slice(1);
      const upsert = statement(
        'INSERT INTO sync_events(device_id,provider,' + dbFields + ') VALUES(?,?,' + params + ')' +
        ' ON CONFLICT(device_id,provider,id) DO UPDATE SET ' +
        eventAttributes.map((field) => field + '=excluded.' + field).join(',') +
        ' WHERE ' + eventAttributes.map((field) => 'sync_events.' + field + ' IS NOT excluded.' + field).join(' OR ')
      );
      const seen = new Set();
      const sums = {};
      for (const record of records) {
        const values = syncRecordValues(record, sums);
        const key = record.provider + '\0' + record.id;
        if (seen.has(key)) throw new Error('同步快照包含重复的用量记录。');
        seen.add(key);
        const old = before.get(key);
        before.delete(key);
        if (upsert.run(deviceId, record.provider, ...values).changes) {
          recordsChanged = true;
          remember.run(record.provider, record.id);
          touch(old?.time_ms);
          touch(Date.parse(record.date));
        }
      }
      const remove = statement('DELETE FROM sync_events WHERE device_id = ? AND provider = ? AND id = ?');
      for (const old of before.values()) {
        remove.run(deviceId, old.provider, old.id);
        recordsChanged = true;
        remember.run(old.provider, old.id);
        touch(old.time_ms);
      }

      if (recordsChanged) {
        const ownedTimes = statement(`
          SELECT MIN(event.time_ms) AS first, MAX(event.time_ms) AS last FROM touched_sync_events touched
          JOIN sync_owners owner USING(provider, id) JOIN sync_events event USING(device_id, provider, id)`);
        const oldTimes = ownedTimes.get();
        touch(oldTimes.first);
        touch(oldTimes.last);
        statement(`
          INSERT INTO sync_owners(provider, id, device_id)
          SELECT provider, id, device_id FROM (
            SELECT event.provider, event.id, event.device_id,
              ROW_NUMBER() OVER (PARTITION BY event.provider, event.id
                ORDER BY event.model IS NULL, event.reasoning_known DESC, event.device_id) AS priority
            FROM touched_sync_events touched JOIN sync_events event USING(provider, id)
          ) WHERE priority = 1
          ON CONFLICT(provider, id) DO UPDATE SET device_id = excluded.device_id
            WHERE sync_owners.device_id <> excluded.device_id`).run();
        const latest = ownedTimes.get();
        touch(latest.first);
        touch(latest.last);
      }
      if (Number.isFinite(dirtyFrom)) markDailyDirty(dirtyFrom, dirtyTo);
      return { changed: recordsChanged || renamed || !previous, accepted: true };
    });
  }

  function previewImport(records) {
    return transaction(() => {
      const lookup = statement('SELECT 1 FROM imported_events WHERE id = ?');
      const seen = new Set();
      const providers = new Map();
      const models = new Map();
      let added = 0;
      for (const { id, provider, model } of records) {
        const duplicate = seen.has(id) || Boolean(lookup.get(id));
        seen.add(id);
        if (!duplicate) added++;
        const key = JSON.stringify([provider, model]);
        if (!providers.has(provider)) providers.set(provider, { provider, count: 0, added: 0, duplicate: 0 });
        if (!models.has(key)) models.set(key, { provider, model, count: 0, added: 0, duplicate: 0 });
        for (const group of [providers.get(provider), models.get(key)]) {
          group.count++;
          group[duplicate ? 'duplicate' : 'added']++;
        }
      }
      const byCount = (a, b) => b.count - a.count;
      return { total: records.length, added, duplicate: records.length - added,
        providers: [...providers.values()].sort(byCount), models: [...models.values()].sort(byCount) };
    }, false);
  }

  function importBatch(filename, records) {
    return transaction(() => {
      const id = randomUUID();
      const date = new Date().toISOString();
      const total = records.length;
      statement(insertImportSql).run(id, filename, date, total, 0, 1);
      let added = 0;
      for (const record of records) {
        added += statement(insertImportedSql).run(id, record.provider, ...normalized(record)).changes;
      }
      if (!added) {
        statement('DELETE FROM imports WHERE id = ?').run(id);
        return { id: null, filename, date, total, added, removable: false };
      }
      statement('UPDATE imports SET added = ? WHERE id = ?').run(added, id);
      bumpSyncRevision();
      invalidateDailyCache();
      return { id, filename, date, total, added, removable: true };
    });
  }

  function deleteImport(id) {
    return transaction(() => {
      const result = statement('SELECT removable FROM imports WHERE id = ?').get(id);
      if (!result?.removable) return null;
      const { count } = statement('SELECT COUNT(*) AS count FROM imported_events WHERE batch_id = ?').get(id);
      statement('DELETE FROM imports WHERE id = ?').run(id);
      if (count) bumpSyncRevision();
      invalidateDailyCache();
      return { id, removed: count };
    });
  }

  function providerCount(provider) {
    return statement('SELECT COUNT(*) AS count FROM event_owners WHERE provider = ?').get(provider).count;
  }

  function sourceFile(provider, path) {
    return statement('SELECT id, count, incomplete, checkpoint FROM source_files WHERE provider = ? AND path = ?')
      .get(provider, path);
  }

  function checkpoint(meta) {
    return {
      incomplete: meta.incomplete,
      ...(meta.checkpoint === null ? {} : { checkpoint: JSON.parse(meta.checkpoint) }),
    };
  }

  function applyChanges(provider, { updates = [], removed = [] }) {
    if (!updates.length && !removed.length) return { count: providerCount(provider), changed: false };
    return transaction(() => {
      const columns = dbFields.split(', ').slice(1);
      const upsert = statement(
        'INSERT INTO file_events(file_id,' + dbFields + ') VALUES(?,' + params + ')' +
        ' ON CONFLICT(file_id,id) DO UPDATE SET ' + columns.map((col) => col + '=excluded.' + col).join(',') +
        ' WHERE ' + columns.map((col) => 'file_events.' + col + ' IS NOT excluded.' + col).join(' OR ')
      );
      const remember = statement('INSERT OR IGNORE INTO touched_events VALUES (?)');
      const deleteRecord = statement('DELETE FROM file_events WHERE file_id = ? AND id = ?');
      const recordTime = statement('SELECT time_ms FROM file_events WHERE file_id = ? AND id = ?');
      let dirtyFrom = Infinity;
      let dirtyTo = -Infinity;
      let changed = false;

      function touch(time) {
        if (!Number.isSafeInteger(time)) return;
        dirtyFrom = Math.min(dirtyFrom, time);
        dirtyTo = Math.max(dirtyTo, time);
      }
      function removeRecord(fileId, id, time) {
        if (!deleteRecord.run(fileId, id).changes) return false;
        remember.run(id);
        touch(time);
        changed = true;
        return true;
      }

      db.exec('DELETE FROM touched_events');
      for (const path of removed) {
        const previous = sourceFile(provider, path);
        if (!previous) continue;
        if (previous.count) {
          const times = statement('SELECT MIN(time_ms) AS first, MAX(time_ms) AS last FROM file_events WHERE file_id = ?')
            .get(previous.id);
          touch(times.first);
          touch(times.last);
          statement('INSERT OR IGNORE INTO touched_events SELECT id FROM file_events WHERE file_id = ?').run(previous.id);
          changed = true;
        }
        statement('DELETE FROM source_files WHERE id = ?').run(previous.id);
      }

      for (const { path, stamp, result } of updates) {
        const previous = sourceFile(provider, path);
        const file = statement(`
          INSERT INTO source_files(provider, path, stamp, count, incomplete, checkpoint) VALUES(?,?,?,?,?,?)
          ON CONFLICT(provider, path) DO UPDATE SET stamp = excluded.stamp,
            incomplete = excluded.incomplete, checkpoint = excluded.checkpoint RETURNING id`)
          .get(provider, path, stamp, 0, result.incomplete ?? 0,
            result.checkpoint == null ? null : JSON.stringify(result.checkpoint));
        if (result.append && !result.records.length && !result.deletedIds?.length) continue;

        const oldEntries = !result.append && previous?.count
          ? new Map(statement('SELECT id, time_ms FROM file_events WHERE file_id = ?').all(file.id)
            .map(({ id, time_ms }) => [id, time_ms]))
          : undefined;
        let count = previous?.count ?? 0;
        if (result.append) {
          for (const id of new Set(result.deletedIds)) {
            const time = recordTime.get(file.id, id)?.time_ms;
            if (removeRecord(file.id, id, time)) count--;
          }
        }

        const seen = new Set();
        for (const record of result.records) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          const time = result.append ? recordTime.get(file.id, record.id)?.time_ms : oldEntries?.get(record.id);
          oldEntries?.delete(record.id);
          if (!upsert.run(file.id, ...normalized(record)).changes) continue;
          if (time === undefined) count++;
          remember.run(record.id);
          touch(time);
          touch(Date.parse(record.date));
          changed = true;
        }
        for (const [id, time] of oldEntries ?? []) {
          if (removeRecord(file.id, id, time)) count--;
        }
        if (count !== (previous?.count ?? 0)) {
          statement('UPDATE source_files SET count = ? WHERE id = ?').run(count, file.id);
        }
      }

      if (changed) {
        // Ownership moves to another copy when a file is replaced or removed.
        statement(`
          INSERT INTO event_owners (provider, id, file_id)
          SELECT ?, id, file_id FROM (
            SELECT event.id, event.file_id,
              ROW_NUMBER() OVER(PARTITION BY event.id
                ORDER BY event.model IS NULL, event.reasoning_known DESC, file.path) AS priority
            FROM touched_events touched
              JOIN file_events event ON event.id = touched.id
              JOIN source_files file ON file.id = event.file_id
            WHERE file.provider = ?
          ) WHERE priority = 1
          ON CONFLICT(provider, id) DO UPDATE SET file_id = excluded.file_id
            WHERE event_owners.file_id <> excluded.file_id`).run(provider, provider);
        const current = statement(`
          SELECT MIN(event.time_ms) AS first, MAX(event.time_ms) AS last FROM touched_events touched
            JOIN event_owners owner ON owner.id = touched.id
            JOIN file_events event ON event.file_id = owner.file_id AND event.id = owner.id
          WHERE owner.provider = ?`).get(provider);
        touch(current.first);
        touch(current.last);
        const remote = statement(`
          SELECT MIN(event.time_ms) AS first, MAX(event.time_ms) AS last FROM touched_events touched
            JOIN sync_owners owner ON owner.id = touched.id AND owner.provider = ?
            JOIN sync_events event USING(device_id, provider, id)`).get(provider);
        touch(remote.first);
        touch(remote.last);
        bumpSyncRevision();
        if (Number.isFinite(dirtyFrom)) {
          markDailyDirty(dirtyFrom, dirtyTo);
        } else {
          invalidateDailyCache();
        }
      }
      return { count: providerCount(provider), changed };
    });
  }

  const cache = {
    list(provider) {
      return new Map(statement('SELECT path, stamp, count, incomplete FROM source_files WHERE provider = ?')
        .all(provider).map(({ path, ...meta }) => [path, meta]));
    },
    getCheckpoint(provider, path) {
      const file = sourceFile(provider, path);
      return file ? checkpoint(file) : undefined;
    },
    get(provider, path) {
      const file = sourceFile(provider, path);
      if (!file) return undefined;
      return {
        records: statement('SELECT * FROM file_events WHERE file_id = ? ORDER BY rowid').all(file.id)
          .map((row) => rawRecord(row, provider)),
        ...checkpoint(file),
      };
    },
    applyChanges,
    apply(provider, updates) {
      return applyChanges(provider, updates).count;
    },
  };

  function usageQuery(timeZone, { from, to, granularity }) {
    if (granularity !== 'day' && granularity !== 'week') throw new Error('汇总周期无效。');
    const first = from == null ? null : asDay(from);
    const last = to == null ? null : asDay(to);
    if (first !== null && last !== null && first > last) throw new Error('开始日期必须早于或等于结束日期。');
    const args = { $zone: timeZone };
    const timestampBounds = [];
    const dayBounds = [];
    if (first !== null) {
      args.$from = from;
      args.$first = first - DAY_MS;
      timestampBounds.push('time_ms >= $first');
      dayBounds.push(['>=', '$from']);
    }
    if (last !== null) {
      args.$to = to;
      args.$last = last + DAY_MS * 2;
      timestampBounds.push('time_ms < $last');
      dayBounds.push(['<=', '$to']);
    }
    const dayFilter = (column) => dayBounds.map(([operator, param]) => `${column} ${operator} ${param}`).join(' AND ');
    const withBounds = timestampBounds.length
      ? `WHERE (date_only IS NOT NULL AND ${dayFilter('date_only')})
        OR (date_only IS NULL AND ${timestampBounds.join(' AND ')})`
      : '';
    const filter = dayBounds.length ? 'WHERE ' + dayFilter('day') : '';
    const bucket = granularity === 'week' ? "date(day, '-' || ((CAST(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')" : 'day';
    const rows = statement(`
      WITH classified AS MATERIALIZED (
        SELECT *, COALESCE(date_only, event_day(time_ms, $zone)) AS day FROM usage_events ${withBounds}
      )
      SELECT ${bucket} AS date, provider, model, source, request_price_tier(model, input, request_level) AS tier,
        ${metrics} FROM classified ${filter}
      GROUP BY 1, provider, model, source, tier ORDER BY date DESC, provider, model, source`).all(args);
    const groups = new Map();
    for (const { date, provider, model, source, tier, ...counts } of rows) {
      const key = JSON.stringify([date, provider, model, source]);
      if (tier === 'flat') {
        groups.set(key, { date, provider, model, source, ...counts });
        continue;
      }
      if (!groups.has(key)) groups.set(key, { date, provider, model, source, ...emptyMetrics, priceBuckets: [] });
      const group = groups.get(key);
      for (const field of Object.keys(emptyMetrics)) group[field] += counts[field];
      group.priceBuckets.push({ tier, ...counts });
    }
    return [...groups.values()];
  }

  function readUsage(timeZone, { from, to, granularity = 'day' } = {}) {
    if (from != null || to != null || granularity !== 'day') return usageQuery(timeZone, { from, to, granularity });
    const lookup = statement('SELECT entries, dirty_from, dirty_to FROM daily_cache WHERE zone = ?');
    const cached = lookup.get(timeZone);
    if (cached?.dirty_from === null) return JSON.parse(cached.entries);
    return transaction(() => {
      const existing = lookup.get(timeZone);
      if (existing?.dirty_from === null) return JSON.parse(existing.entries);
      let entries;
      if (existing) {
        // A UTC day on either side covers local dates in every supported time zone.
        const first = new Date(existing.dirty_from - DAY_MS).toISOString().slice(0, 10);
        const last = new Date(existing.dirty_to + DAY_MS).toISOString().slice(0, 10);
        const unaffected = JSON.parse(existing.entries).filter((entry) => entry.date < first || entry.date > last);
        entries = [...unaffected, ...usageQuery(timeZone, { from: first, to: last, granularity })]
          .sort((a, b) => b.date.localeCompare(a.date) || a.provider.localeCompare(b.provider)
            || (a.model ?? '').localeCompare(b.model ?? '') || a.source.localeCompare(b.source));
      } else {
        entries = usageQuery(timeZone, { granularity });
      }
      statement(`
        INSERT INTO daily_cache (zone, entries) VALUES (?,?)
        ON CONFLICT(zone) DO UPDATE SET entries = excluded.entries, dirty_from = NULL, dirty_to = NULL`)
        .run(timeZone, JSON.stringify(entries));
      statement('DELETE FROM daily_cache WHERE rowid NOT IN (SELECT rowid FROM daily_cache ORDER BY rowid DESC LIMIT 8)').run();
      return entries;
    });
  }

  function readDay(timeZone, day) {
    const start = asDay(day);
    const args = { $zone: timeZone, $day: day, $lower: start - DAY_MS, $upper: start + DAY_MS * 2 };
    const matchingTime = 'date_only IS NULL AND time_ms >= $lower AND time_ms < $upper AND event_day(time_ms, $zone) = $day';
    return transaction(() => {
      const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyMetrics }));
      for (const row of statement(`
        SELECT event_hour(time_ms, $zone) AS hour, ${metrics}
        FROM usage_events WHERE ${matchingTime} GROUP BY 1`).all(args)) {
        hourly[row.hour] = { ...row };
      }

      const sessions = statement(`
        SELECT provider, session, ${metrics},
          MIN(CASE WHEN date_only IS NULL THEN time_ms END) AS started,
          MAX(CASE WHEN date_only IS NULL THEN time_ms END) AS ended
        FROM usage_events WHERE session IS NOT NULL AND (date_only = $day OR (${matchingTime}))
        GROUP BY provider, session ORDER BY total DESC, provider, session LIMIT 15`).all(args)
        .map(({ started, ended, ...row }) => ({
          ...row,
          startedAt: started === null ? null : new Date(started).toISOString(),
          endedAt: ended === null ? null : new Date(ended).toISOString(),
        }));
      const { count: withoutTime } = statement('SELECT COUNT(*) AS count FROM usage_events WHERE date_only = ?').get(day);
      return { hourly, sessions, withoutTime };
    }, false);
  }

  return {
    getPaths: () => Object.fromEntries(statement('SELECT provider, path FROM paths').all().map(({ provider, path }) => [provider, path])),
    setPath: (provider, path) => statement(putPathSql).run(provider, path),
    getImports: () => statement(`SELECT ${importFields} FROM imports ORDER BY ordinal DESC LIMIT 100`).all().map(importInfo),
    previewImport, importBatch, deleteImport, readUsage, readDay, cache,
    getPriceOverrides: () => getSetting('priceOverrides', []),
    setPriceOverrides: (array) => setSetting('priceOverrides', array),
    getScanStatus: () => getSetting('scanStatus', null),
    setScanStatus: (status) => setSetting('scanStatus', status),
    getSyncConfig, setSyncConfig, getSyncIdentity, readOwnSyncRecords, readSyncPeers, applySyncSnapshot,
    clearSyncPeers: () => transaction(removeSyncPeers),
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}
