import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectLocal, localLogTargets } from '../lib/local-sources.mjs';
import { openStore } from '../lib/store.mjs';

const providers = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo'];
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
