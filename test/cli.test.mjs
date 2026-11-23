import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultPreferences } from '../lib/preferences.mjs';
import { openStore } from '../lib/store.mjs';
import { createDayFormatter } from '../public/calendar.js';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const providers = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo', 'kilo', 'opencode'];
const today = createDayFormatter('UTC')(new Date());

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tokenstat-cli-test-'));
  const dataDir = join(root, 'data');
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  const store = openStore(dataDir);
  for (const provider of providers) store.setPath(provider, logDir);
  store.setPreferences({ ...defaultPreferences, locale: 'en', timeZone: 'UTC' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    store, dataDir, logDir,
    run(...args) {
      const result = spawnSync(process.execPath, [cli, '--data-dir', dataDir, '--tz', 'UTC', ...args], { encoding: 'utf8', timeout: 8000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
}

test('CLI formats today and emits structured calendar-month, week, and rolling summaries', (t) => {
  const f = fixture(t);
  const monthStart = today.slice(0, 7) + '-01';
  const previous = new Date(Date.parse(monthStart) - 86_400_000).toISOString().slice(0, 10);
  f.store.importBatch('fixture.json', [today, monthStart, previous].map((date, index) => ({
    id: 'cli-import-' + index, date, provider: 'codex', model: 'gpt-6.2-sol', input: 100, output: 25,
    cached: 40, reasoning: 5, total: 125, source: 'import', requestLevel: true,
  })));
  const daily = JSON.parse(f.run('--today', '--json', '--no-scan'));
  assert.deepEqual(daily, JSON.parse(f.run('--json', '--no-scan')));
  assert.equal(daily.from, today);
  assert.equal(daily.totalTokens, today === monthStart ? 250 : 125);
  assert.equal(daily.cacheHitRate, 0.4);
  assert.equal(daily.providers[0].provider, 'codex');
  assert(daily.estimatedCost > 0);
  assert(daily.cacheSavings > 0);
  assert.match(f.run('--today', '--no-scan'), /Cache hit\s+40%.*Estimated cost\s+USD/u);

  const month = JSON.parse(f.run('--month', '--json', '--no-scan'));
  assert.equal(month.from, monthStart);
  assert.equal(month.to, today);
  assert.equal(month.totalTokens, 250);
  const week = JSON.parse(f.run('--week', '--json', '--no-scan'));
  assert.equal(new Date(week.from).getUTCDay(), 1);
  const rolling = JSON.parse(f.run('--days', '3', '--json', '--no-scan'));
  assert.equal(Date.parse(rolling.to) - Date.parse(rolling.from), 2 * 86_400_000);
});

test('CLI cache-only read works under a WAL writer and a fresh scan is isolated', (t) => {
  const f = fixture(t);
  const log = { type: 'token_usage_record', timestamp: today + 'T12:00:00Z', payload: {
    model: 'gpt-6.2-sol', response_id: 'cli-fixture', usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
  } };
  writeFileSync(join(f.logDir, 'rollout-cli.jsonl'), JSON.stringify(log) + '\n');
  const writer = new DatabaseSync(join(f.dataDir, 'tokenstat.db'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(JSON.parse(f.run('--no-scan', '--json')).totalTokens, 0);
    assert.equal(JSON.parse(f.run('--json')).totalTokens, 100);
    assert.equal(f.store.cache.list('codex').size, 0);
    assert.equal(f.store.getScanStatus(), null);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});
