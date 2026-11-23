import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../lib/store.mjs';

test('daily sessions combine model prices at their request tiers and retain unpriced activity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenstat-sessions-'));
  const store = openStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const session = 'codex-' + 'a'.repeat(24);
  const day = '2026-11-23';
  const first = '2026-11-22T17:00:00.000Z';
  const last = '2026-11-23T07:00:00.000Z';
  const record = (id, input, output, fields = {}) => ({
    id, input, output, total: input + output, provider: 'codex', model: 'custom-model', date: first,
    session, cached: 0, reasoning: 0, ...fields,
  });
  store.setPriceOverrides([{ provider: 'codex', model: 'custom-model', input: 2, cached: 0.2, output: 8, reasoning: 16 }]);
  store.importBatch('sessions.json', [
    record('custom-rate', 100_000, 200, { cached: 9_000, reasoning: 100 }),
    record('missing-cache-write-rate', 10_000, 100, { cacheWrite: 20, date: day, dateOnly: true }),
    record('long-context-rate', 272_001, 100, { model: 'gpt-6.2-sol', cached: 1_000, requestLevel: true, date: last }),
    record('prior-day', 600_000, 200, { date: '2026-11-22T15:00:00.000Z' }),
    record('other-provider', 100_000, 1, { provider: 'claude', cached: 10_000 }),
    record('output-only', 0, 10, { session: 'codex-' + 'b'.repeat(24) }),
  ]);

  const [mixed, other, outputOnly] = store.readDay('Asia/Shanghai', day).sessions;
  assert.equal(mixed.session, session);
  assert.equal(mixed.provider, 'codex');
  assert.equal(mixed.count, 3);
  assert.equal(mixed.input, 382_001);
  assert.equal(mixed.total, 382_401);
  assert.equal(mixed.cacheHitRate, 10_000 / 382_001);
  assert.equal(mixed.pricedRecords, 2);
  const customCost = (91_000 * 2 + 9_000 * 0.2 + 100 * 8 + 100 * 16) / 1_000_000;
  const longCost = (271_001 * 4 + 1_000 * 0.2 + 100 * 15) / 1_000_000;
  assert.ok(Math.abs(mixed.estimatedCost - (customCost + longCost)) < 1e-12);
  assert.equal(mixed.startedAt, first);
  assert.equal(mixed.endedAt, last);
  assert.equal(other.session, session);
  assert.equal(other.provider, 'claude');
  assert.equal(other.cacheHitRate, 0.1);
  assert.equal(other.estimatedCost, null);
  assert.equal(outputOnly.cacheHitRate, null);
});
