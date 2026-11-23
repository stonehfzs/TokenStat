import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectLocal, localLogTargets, localWatchRoots } from '../lib/local-sources.mjs';
import { openStore } from '../lib/store.mjs';

const providers = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo', 'kilo', 'opencode'];
const timestamp = '2026-11-21T16:00:00.000Z';
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

async function fixture(testContext) {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-collectors-'));
  const databases = [];
  testContext.after(async () => {
    for (const database of databases) database.close();
    await rm(root, { recursive: true, force: true });
  });
  const paths = Object.fromEntries(providers.map((name) => [name, join(root, name)]));
  await Promise.all(Object.values(paths).map((path) => mkdir(path)));
  return { root, paths, databases };
}

function createSessionDatabase(path, databases) {
  const database = new DatabaseSync(path);
  databases.push(database);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, type TEXT, data TEXT);
  `);
  return database;
}

test('Kilo Code combines copied legacy request logs and current SQLite usage without recounting requests', async (t) => {
  const { root, paths, databases } = await fixture(t);
  const settings = { paths };
  const store = openStore(join(root, 'db'));
  databases.push(store);
  const date = Date.parse(timestamp);
  const started = { type: 'say', say: 'api_req_started', ts: date, text: '{"modelId":"gpt-6-sol"}' };
  const finished = {
    type: 'say', say: 'api_req_finished', ts: date + 1000,
    text: '{"tokensIn":100,"tokensOut":20,"cacheReads":35,"cacheWrites":15,"apiProtocol":"anthropic"}',
  };
  for (const copy of ['legacy', 'copy']) {
    const task = join(paths.kilo, 'tasks', copy, 'same-task');
    await mkdir(task, { recursive: true });
    await writeFile(join(task, 'ui_messages.json'), JSON.stringify([started, finished]));
  }
  const database = createSessionDatabase(join(paths.kilo, 'kilo.db'), databases);
  database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_current', 'ses_current', date, JSON.stringify({
    role: 'assistant', modelID: 'gpt-6-sol',
    tokens: { input: 100, output: 20, reasoning: 5, total: 150, cache: { read: 30, write: 0 } },
  }));

  const { sources } = await collectLocal(settings, { cache: store.cache });
  const source = sources.find((item) => item.provider === 'kilo');
  assert.equal(source.status, 'connected');
  assert.equal(source.scannedFiles, 3);
  assert.equal(source.count, 2);
  const [row] = store.readUsage('UTC');
  assert.deepEqual([row.provider, row.model, row.input, row.output, row.cached, row.cacheWrite, row.reasoning, row.total],
    ['kilo', 'gpt-6-sol', 230, 40, 65, 15, 5, 270]);
});

test('OpenCode merges current and legacy projections and watches new WAL commits', async (t) => {
  const { root, paths, databases } = await fixture(t);
  const settings = { paths };
  const store = openStore(join(root, 'db'));
  databases.push(store);
  const databasePath = join(paths.opencode, 'opencode.db');
  const database = createSessionDatabase(databasePath, databases);
  const oldMessage = {
    id: 'msg_duplicate', sessionID: 'ses_same', role: 'assistant', modelID: 'gpt-6-sol',
    time: { created: Date.parse(timestamp) },
    tokens: { input: 70, output: 25, reasoning: 5, total: 115, cache: { read: 20, write: 0 } },
  };
  const modernMessage = {
    model: { id: 'gpt-6-sol', providerID: 'openai' },
    tokens: { input: 70, output: 20, reasoning: 5, cache: { read: 20, write: 0 } },
  };
  const time = oldMessage.time.created;
  const legacyDirectory = join(paths.opencode, 'storage', 'message', oldMessage.sessionID);
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, 'msg_duplicate.json'), JSON.stringify(oldMessage));
  await writeFile(join(legacyDirectory, 'msg_broken.json'), '{');
  database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(oldMessage.id, oldMessage.sessionID, time, JSON.stringify(oldMessage));
  const put = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  put.run(oldMessage.id, oldMessage.sessionID, time, 'assistant', JSON.stringify(modernMessage));
  put.run('msg_user', oldMessage.sessionID, time, 'user', JSON.stringify(modernMessage));

  const first = await collectLocal(settings, { cache: store.cache });
  const source = first.sources.find((item) => item.provider === 'opencode');
  assert.equal(source.count, 1);
  assert.equal(source.scannedFiles, 3);
  assert.deepEqual(source.skippedReasons, { invalidJson: 1 });
  assert.equal(store.readUsage('UTC')[0].total, 115);

  put.run('msg_new', oldMessage.sessionID, time + 1, 'assistant', JSON.stringify(modernMessage));
  const targets = localLogTargets(databasePath + '-wal', settings);
  assert.deepEqual(targets, [['opencode', databasePath]]);
  const next = await collectLocal(settings, { cache: store.cache, previousSources: first.sources,
    changedFiles: new Map([['opencode', new Set([databasePath])]]),
  });
  assert.equal(next.changed, true);
  const [row] = store.readUsage('UTC');
  assert.deepEqual([row.count, row.input, row.output, row.cached, row.reasoning, row.total], [2, 180, 50, 40, 10, 230]);

  const directSettings = { paths: { ...paths, opencode: databasePath } };
  assert.ok(localWatchRoots(directSettings).includes(dirname(databasePath)));
  assert.deepEqual(localLogTargets(databasePath + '-wal', directSettings), [['opencode', databasePath]]);
});

test('OpenCode honors its XDG data root and environment override', async (t) => {
  const { root, paths } = await fixture(t);
  const names = ['XDG_DATA_HOME', 'OPENCODE_DATA_DIR', 'OPENCODE_DB'];
  const initial = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    const value = initial[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }));
  process.env.XDG_DATA_HOME = root;
  delete process.env.OPENCODE_DATA_DIR;
  delete process.env.OPENCODE_DB;
  delete paths.opencode;
  assert.ok(localWatchRoots({ paths }).includes(join(root, 'opencode')));
  process.env.OPENCODE_DATA_DIR = join(root, 'custom');
  assert.ok(localWatchRoots({ paths }).includes(join(root, 'custom')));
});

test('Codex tails long JSONL lines, preserves model context, and uses one copy of compressed log twins', async (t) => {
  const { root, paths, databases } = await fixture(t);
  const store = openStore(join(root, 'db'));
  databases.push(store);
  const file = join(paths.codex, 'rollout-fixture.jsonl');
  const event = (id, input) => ({
    details: 'skip'.repeat(500), timestamp, type: 'token_usage_record',
    payload: { response_id: id, turn_id: 'test-turn', usage: { input_tokens: input, output_tokens: 8, total_tokens: input + 8 } },
  });
  const original = jsonl([
    { timestamp, type: 'session_meta', payload: { id: 'test-session' } },
    { timestamp, type: 'turn_context', payload: { turn_id: 'test-turn', model: 'gpt-6.2-sol' } },
    event('one', 92),
  ]);
  await writeFile(file, original);
  await writeFile(file + '.zst', zstdCompressSync(Buffer.from(original)));
  const first = await collectLocal({ paths }, { cache: store.cache });
  assert.equal(first.sources.find((source) => source.provider === 'codex').count, 1);
  const targets = localLogTargets(file, { paths });
  assert.deepEqual(targets, [['codex', file], ['codex', file + '.zst']]);
  const changedFiles = new Map([['codex', new Set(targets.map(([, path]) => path))]]);
  await appendFile(file, jsonl([{ timestamp, type: 'agent_message', payload: { text: 'no usage' } }]));
  const same = await collectLocal({ paths }, { cache: store.cache, previousSources: first.sources,
    changedFiles });
  assert.equal(same.changed, false);
  await appendFile(file, jsonl([event('two', 192)]));
  const next = await collectLocal({ paths }, { cache: store.cache, previousSources: first.sources,
    changedFiles });
  assert.equal(next.changed, true);
  const [row] = store.readUsage('Asia/Shanghai');
  assert.equal(row.date, '2026-11-22');
  assert.equal(row.model, 'gpt-6.2-sol');
  assert.equal(row.total, 300);
  assert.equal(row.count, 2);
});

function protobufVarint(number) {
  const result = [];
  while (number > 127) { result.push(number % 128 + 128); number = Math.floor(number / 128); }
  result.push(number);
  return Buffer.from(result);
}
function protobuf(field, value) {
  if (typeof value === 'number') return Buffer.concat([protobufVarint(field * 8), protobufVarint(value)]);
  const bytes = Buffer.from(value);
  return Buffer.concat([protobufVarint(field * 8 + 2), protobufVarint(bytes.length), bytes]);
}

test('Antigravity trusts Protobuf model metadata only for matching conversation, step, time and usage', async (t) => {
  const { paths } = await fixture(t);
  const conversation = 'test-conversation';
  const log = join(paths.gemini, 'brain', conversation, '.system_generated', 'logs', 'transcript.jsonl');
  const databasePath = join(paths.gemini, 'conversations', conversation + '.db');
  await mkdir(dirname(log), { recursive: true });
  await mkdir(dirname(databasePath));
  const usage = Buffer.concat([protobuf(1, 7), protobuf(2, 90), protobuf(3, 36), protobuf(5, 10)]);
  const complete = Buffer.concat([usage, protobuf(9, 6), protobuf(10, 30)]);
  const stamp = protobuf(1, Date.parse(timestamp) / 1000);
  const generation = Buffer.concat([protobuf(3, 7), protobuf(4, usage), protobuf(19, 'gemini-4-neon')]);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE trajectory_meta(cascade_id); CREATE TABLE steps(idx,metadata); CREATE TABLE gen_metadata(data);');
    database.prepare('INSERT INTO trajectory_meta VALUES (?)').run(conversation);
    database.prepare('INSERT INTO steps VALUES (?,?)').run(0, Buffer.concat([protobuf(1, stamp), protobuf(9, complete)]));
    database.prepare('INSERT INTO gen_metadata VALUES (?)').run(Buffer.concat([protobuf(1, generation), protobuf(2, 0)]));
  } finally {
    database.close();
  }
  const usageRow = { status: 'DONE', type: 'LLM', created_at: timestamp, input_tokens: 90, output_tokens: 36, cache_read_tokens: 10 };
  await writeFile(log, jsonl([{ ...usageRow, step_index: 0 }, { ...usageRow, step_index: 1, input_tokens: 91 }]));
  const collected = await collectLocal({ paths });
  const records = collected.records.filter((row) => row.provider === 'gemini');
  assert.equal(records.length, 2);
  assert.ok(records.some((row) => row.model === 'gemini-4-neon' && row.total === 136 && row.reasoning === 6));
  assert.ok(records.some((row) => row.model !== 'gemini-4-neon' && row.total === 137));
});

test('reports per-tool collection timestamps and distinct parse and file failures', async (t) => {
  const { root, paths, databases } = await fixture(t);
  const store = openStore(join(root, 'db'));
  databases.push(store);
  const file = join(paths.codex, 'rollout-diagnostics.jsonl');
  const valid = {
    timestamp, type: 'token_usage_record',
    payload: { model: 'gpt-6.2-sol', response_id: 'diagnostic', usage: { input_tokens: 42, output_tokens: 3 } },
  };
  const malformed = '{"timestamp":"' + timestamp + '","type":"token_usage_record","payload":{\n';
  await writeFile(file, malformed + jsonl([
    { ...valid, data: 'x'.repeat(4 * 1024 * 1024) }, { ...valid, timestamp: 'invalid-timestamp' }, valid,
  ]));
  await writeFile(join(paths.claude, 'broken.jsonl'), '{"type":"assistant","message":{\n');
  paths.grok = join(root, 'missing-grok-root');
  const first = await collectLocal({ paths }, { cache: store.cache });
  const codex = first.sources.find((source) => source.provider === 'codex');
  assert.equal(codex.count, 1);
  assert.equal(codex.collectionState, 'partial');
  assert.equal(codex.scannedFiles, 1);
  assert.equal(codex.failedFiles, 0);
  assert.equal(codex.skippedCount, 3);
  assert.deepEqual(codex.skippedReasons, { invalidJson: 1, oversizedLine: 1, invalidTimestamp: 1 });
  assert.ok(Number.isFinite(Date.parse(codex.lastCollectedAt)));

  const grok = first.sources.find((source) => source.provider === 'grok');
  assert.equal(grok.collectionState, 'unavailable');
  assert.equal(grok.failedFiles, 1);
  assert.deepEqual(grok.failedReasons, { missingPath: 1 });
  assert.equal(grok.lastCollectedAt, null);
  assert.equal(first.sources.find((source) => source.provider === 'claude').collectionState, 'unavailable');

  const second = await collectLocal({ paths }, { cache: store.cache, previousSources: first.sources });
  assert.deepEqual(second.sources.find((source) => source.provider === 'codex'), codex);
  assert.equal(second.changed, false);

  // The diagnostics column starts empty when an older database is migrated.
  const migrated = new DatabaseSync(join(root, 'db', 'tokenstat.db'));
  try {
    migrated.prepare('UPDATE source_files SET diagnostics = NULL WHERE provider = ?').run('codex');
  } finally {
    migrated.close();
  }
  const legacySources = [{ provider: 'codex', status: 'connected', count: 1 }];
  const upgraded = await collectLocal({ paths }, { cache: store.cache, previousSources: legacySources });
  const upgradedCodex = upgraded.sources.find((source) => source.provider === 'codex');
  assert.deepEqual(upgradedCodex.skippedReasons, codex.skippedReasons);
  assert.ok(Number.isFinite(Date.parse(upgradedCodex.lastCollectedAt)));
  assert.equal(upgraded.changed, false);
});

test('a failed read of a retained historical file cannot establish a successful collection time', async (t) => {
  const { root, paths, databases } = await fixture(t);
  const store = openStore(join(root, 'db'));
  databases.push(store);
  const log = join(paths.codex, 'rollout-retained.jsonl.zst');
  const valid = jsonl([{
    timestamp, type: 'token_usage_record',
    payload: { model: 'gpt-6.2-sol', response_id: 'retained', usage: { input_tokens: 20, output_tokens: 2 } },
  }]);
  await writeFile(log, zstdCompressSync(Buffer.from(valid)));
  await collectLocal({ paths }, { cache: store.cache });
  await writeFile(log, 'not a Zstandard frame');
  const result = await collectLocal({ paths }, { cache: store.cache });
  const source = result.sources.find(({ provider }) => provider === 'codex');
  assert.equal(source.count, 1);
  assert.equal(source.lastCollectedAt, null);
  assert.equal(source.collectionState, 'partial');
  assert.equal(source.failedReasons.readError, 1);
});
