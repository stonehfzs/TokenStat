import assert from 'node:assert/strict';
import test from 'node:test';
import { createDayFormatter } from '../public/calendar.js';
import { overviewPeriod, overviewTrend, reportSummary, validOverviewDate } from '../public/js/overview-data.js';

test('uses calendar month boundaries and limits this-month comparison to the same days', () => {
  const dates = ['2024-12-01', '2024-12-15', '2025-01-01', '2025-01-15', '2025-01-16'];
  const rows = dates.map((date) => ({ date }));
  const month = overviewPeriod(rows, 'month', '2025-01-15');
  assert.deepEqual(month, {
    start: '2025-01-01', end: '2025-01-15', days: 15,
    entries: rows.slice(2, 4), previous: rows.slice(0, 2),
  });
  const previous = overviewPeriod(rows, 'last-month', '2025-01-15');
  assert.equal(previous.start, '2024-12-01');
  assert.equal(previous.end, '2024-12-31');
  assert.deepEqual(previous.entries, rows.slice(0, 2));

  const localToday = createDayFormatter('America/Los_Angeles')(new Date('2024-03-01T02:00:00Z'));
  const leap = overviewPeriod([], 'month', localToday);
  assert.equal(leap.start, '2024-02-01');
  assert.equal(leap.end, '2024-02-29');
  assert.equal(leap.days, 29);
});

test('selects inclusive custom dates, pages a long range, and rejects invalid dates', () => {
  const custom = { from: '2024-01-01', to: '2024-04-01' };
  const rows = ['2023-12-31', '2024-01-01', '2024-04-01', '2024-04-02'].map((date) => ({ date }));
  const { start, end, entries, days, previous } = overviewPeriod(rows, 'custom', '2024-05-01', custom);
  assert.equal(days, 92);
  assert.deepEqual(entries, rows.slice(1, 3));
  assert.deepEqual(previous, rows.slice(0, 1));
  const options = { start, end, entries: [], mode: 'provider', metric: 'token', hidden: new Set() };
  const recent = overviewTrend({ ...options, page: 0 });
  const earlier = overviewTrend({ ...options, page: 20 });
  assert.deepEqual([recent.pages, recent.first, recent.last], [2, '2024-01-03', end]);
  assert.deepEqual([earlier.page, earlier.first, earlier.last], [1, start, '2024-01-02']);
  assert.equal(validOverviewDate('2024-02-29'), true);
  for (const value of ['2025-02-29', '2024-02-30', '2024-1-01', '0000-01-01', '']) {
    assert.equal(validOverviewDate(value), false);
  }
});

test('charts prices only for priced records and apportions input and output without double counting', () => {
  const date = '2026-11-10';
  const entries = [
    { date, provider: 'codex', input: 80, output: 20, total: 100, count: 4,
      estimatedCost: 2, pricedTokens: 80, pricedRecords: 3,
      costBreakdown: { freshInput: 0.5, cachedInput: 0.25, cacheWrite: 0.25, output: 0.5, reasoning: 0.5 } },
    { date, provider: 'grok', input: 30, output: 20, total: 50, count: 1, estimatedCost: null },
    { date, provider: 'other', input: 20, output: 5, total: 25, count: 1, estimatedCost: 0 },
  ];
  const options = { start: date, end: date, entries, mode: 'provider', page: 0 };
  const [costs] = overviewTrend({ ...options, metric: 'cost', hidden: new Set() }).buckets;
  assert.deepEqual(costs, {
    date, values: { codex: 2, grok: 0, other: 0 }, total: 2,
    records: 6, pricedRecords: 4, pricedTokens: 105, totalTokens: 175,
  });
  const [filtered] = overviewTrend({ ...options, metric: 'cost', hidden: new Set(['grok']) }).buckets;
  assert.deepEqual([filtered.total, filtered.records, filtered.totalTokens], [2, 5, 125]);
  const [input] = overviewTrend({ ...options, mode: 'io', metric: 'cost', hidden: new Set(['output']) }).buckets;
  assert.deepEqual(input.values, { input: 1 });
  const [tokens] = overviewTrend({ ...options, metric: 'token', hidden: new Set() }).buckets;
  assert.equal(tokens.total, 175);
});

test('report summary contains aggregate amounts and excludes local paths and session data', () => {
  const date = '2026-11-02';
  const summary = reportSummary([
    { date, provider: 'opencode', model: 'openai/gpt-6.2-sol', total: 100, estimatedCost: 0.5, cacheSavings: -0.03,
      session: 'private-session', source: '/home/example/private.jsonl' },
    { date, provider: 'kilo', model: '/home/example/local-model', total: 40, estimatedCost: null },
    { date, provider: 'kilo', model: 'C:\\Users\\person\\model', total: 10, estimatedCost: null },
  ], date, '2026-11-03');
  assert.deepEqual(summary, {
    total: 150, estimatedCost: 0.5, cacheSavings: -0.03, pricedTokens: 100, daily: [150, 0],
    tools: [{ provider: 'opencode', total: 100 }, { provider: 'kilo', total: 50 }],
    models: [{ provider: 'opencode', name: 'openai/gpt-6.2-sol', total: 100 }, { provider: 'kilo', name: null, total: 50 }],
  });
});
