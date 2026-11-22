import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { estimateRows, estimateTotals, normalizeRate, pricingTier, resolveDefaultRate } from '../lib/pricing.mjs';
import { openStore } from '../lib/store.mjs';

function usage(model, { provider = 'codex', input = 100, output = 20, cached = 10, reasoning = 5, ...rest } = {}) {
  return { model, provider, input, output, cached, reasoning, total: input + output, count: 1, ...rest };
}

function closeTo(actual, expected) {
  assert.equal(typeof actual, 'number');
  assert(Math.abs(actual - expected) < 1e-12, `Expected ${expected}, received ${actual}`);
}

test('resolves known public namespaced IDs and dated model snapshots', () => {
  assert.equal(resolveDefaultRate('publishers/google/models/gemini-2.5-pro').model, 'gemini-2.5-pro');
  assert.equal(resolveDefaultRate('anthropic/claude-opus-4.5').model, 'claude-opus-4-5');
  assert.equal(resolveDefaultRate('anthropic.claude-haiku-4-5-20251001').cached, 0.10);
  assert.equal(resolveDefaultRate('openai/gpt-6.2-sol-2026-11-17').model, 'gpt-6.2-sol');
  assert.equal(resolveDefaultRate('x-ai/grok-4.7').model, 'grok-4.7');
});

test('leaves internal names, variant names and unverified dates unpriced', () => {
  for (const model of ['gemini-3.8-flash-n', 'gemini-4-argon-trial', 'gemini-2.5-pro-preview-05-06',
    'grok-4.7-build', 'gpt-6.2-sol-mini', 'gpt-6.2-sol-2026-11-16', 'gpt-6.2-sol-2027-01-01',
    'gpt-6.2-sol-2026-11-99', 'claude-haiku-4-5-20251002', 'google/claude-opus-5-5',
    'models/publishers/google/models/gemini-2.5-pro']) {
    assert.equal(resolveDefaultRate(model), undefined, model);
    assert.equal(estimateRows([usage(model)])[0].estimatedCost, null, model);
  }
});

test('preserves request-level context tiers at their exact boundaries', () => {
  for (const [model, boundary] of [['openai/gpt-6.2-sol-2026-11-17', 272_001],
    ['models/gemini-2.5-pro', 200_001], ['anthropic/claude-haiku-5.5', 100_001], ['x-ai/grok-4.7', 200_000]]) {
    assert.equal(pricingTier(model, boundary - 1, 1), 'short');
    assert.equal(pricingTier(model, boundary, true), 'long');
    assert.equal(pricingTier(model, boundary, false), 'unknown');
  }
  closeTo(estimateRows([usage('models/gemini-2.5-pro', { input: 200_000, requestLevel: true })])[0].estimatedCost,
    (199_990 * 1.25 + 10 * 0.125 + 20 * 10) / 1_000_000);
  closeTo(estimateRows([usage('claude-haiku-5-5', { input: 100_001, requestLevel: true })])[0].estimatedCost,
    (99_991 * 0.50 + 10 * 0.05 + 20 * 2.50) / 1_000_000);
});

test('uses the same resolver for SQLite tiers and fee estimates without pricing aggregate totals as requests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenstat-pricing-'));
  const db = openStore(directory);
  try {
    const model = 'models/gemini-2.5-pro';
    const date = '2026-11-22T03:00:00.000Z';
    const records = [
      { ...usage(model, { provider: 'gemini', input: 200_000, requestLevel: true }), id: 'event-1', date, source: 'import' },
      { ...usage(model, { provider: 'gemini', input: 200_001, requestLevel: true }), id: 'event-2', date, source: 'import' },
      { ...usage(model, { provider: 'gemini', input: 900_000 }), id: 'event-3', date, source: 'import' },
    ];
    db.importBatch('fixtures.json', records);
    const [row] = estimateRows(db.readUsage('Asia/Shanghai'));
    assert.equal(row.model, model);
    assert.equal(row.shortRequests, 1);
    assert.equal(row.longRequests, 1);
    assert.equal(row.unclassifiedRecords, 1);
    assert.equal(row.pricedRecords, 2);
    assert.equal(row.pricedTokens, records[0].total + records[1].total);
    closeTo(row.estimatedCost, estimateRows(records).reduce((sum, event) => sum + (event.estimatedCost ?? 0), 0));
    assert.equal(estimateTotals([row]).coverage.records, 3);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves exact custom overrides and avoids charging reasoning twice', () => {
  const model = 'openai/gpt-6.2-sol-2026-11-17';
  const row = usage(model);
  const wrong = normalizeRate({ provider: 'codex', model: 'gpt-6.2-sol', input: 9, output: 9, cached: 9 }, ['codex']);
  const exact = normalizeRate({ provider: 'codex', model, input: 2, output: 10, cached: 1, reasoning: 20 }, ['codex']);
  assert.equal(estimateRows([row], [wrong])[0].estimatedCost, null);
  const [updated] = estimateRows([row], [wrong, exact]);
  closeTo(updated.estimatedCost, (90 * 2 + 10 + 15 * 10 + 5 * 20) / 1_000_000);
  closeTo(updated.costBreakdown.reasoning, 5 * 20 / 1_000_000);
  assert.equal(updated.shortRequests, 0);
  assert.equal(updated.longRequests, 0);
  assert.equal(estimateRows([{ ...row, withoutReasoning: 1 }], [exact])[0].estimatedCost, null);
});

test('keeps source-reported charges separate from API equivalents', () => {
  const rows = estimateRows([
    usage('claude-opus-5-5', { provider: 'claude' }),
    usage('grok-4.7-build', { provider: 'grok', reportedCostTicks: 123_000_000, reportedCostRecords: 1 }),
  ]);
  assert.equal(rows[1].estimatedCost, null);
  const totals = estimateTotals(rows);
  closeTo(totals.estimatedCost, (90 * 4 + 10 * 0.20 + 20 * 20) / 1_000_000);
  closeTo(totals.reportedCostUsd, 0.0123);
  assert.deepEqual(totals.reportedCostCoverage, { reportedRecords: 1, records: 2 });
});
