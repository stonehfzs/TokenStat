import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUsageFile } from '../lib/imports.mjs';

function parse(filename, payload, provider = 'auto') {
  return parseUsageFile({ filename, content: typeof payload === 'string' ? payload : JSON.stringify(payload), provider });
}

test('imports quoted UTF-8 CSV and preserves duplicate occurrences within a batch', () => {
  const csv = [
    '\uFEFFdate,provider,model,input,output,cached,cache_write,reasoning,total,request_level',
    '2026-11-22,claude,"claude-opus-5-5, stable",100,20,30,10,6,120,true',
    '2026-11-22,claude,"claude-opus-5-5, stable",100,20,30,10,6,120,true',
  ].join('\r\n');
  const rows = parse('usage.csv', csv);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(parse('renamed.csv', csv), rows);
  assert.equal(rows[0].date, '2026-11-22T00:00:00.000Z');
  assert.equal(rows[0].dateOnly, true);
  assert.equal(rows[0].model, 'claude-opus-5-5, stable');
  assert.equal(rows[0].cacheWrite, 10);
  assert.equal(rows[0].requestLevel, true);
});

test('normalizes Claude cache reads and writes and retains provider-reported model IDs', () => {
  const [record] = parse('usage.json', {
    timestamp: '2026-11-22T00:15:00+08:00',
    model_id: 'claude-opus-4-5-20251101',
    usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 6 },
  });
  assert.equal(record.date, '2026-11-21T16:15:00.000Z');
  assert.equal(record.dateOnly, undefined);
  assert.equal(record.provider, 'claude');
  assert.equal(record.model, 'claude-opus-4-5-20251101');
  assert.equal(record.input, 20);
  assert.equal(record.cached, 10);
  assert.equal(record.cacheWrite, 6);
  assert.equal(record.total, 22);
  assert.equal(record.reasoningKnown, false);
});

test('normalizes dated Gemini and xAI API response metrics from JSONL', () => {
  const records = [
    { date: '2026-11-22', modelVersion: 'gemini-2.5-pro',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 } },
    { created: 1795305600, model: 'grok-4.7', usage: { prompt_tokens: 25, completion_tokens: 5, total_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 10 } } },
  ];
  const [gemini, grok] = parse('usage.ndjson', '\uFEFF' + records.map((row) => JSON.stringify(row)).join('\r\n'));
  assert.deepEqual([gemini.provider, gemini.output, gemini.reasoning, gemini.total], ['gemini', 25, 5, 125]);
  assert.deepEqual([grok.provider, grok.output, grok.reasoning, grok.total], ['grok', 15, 10, 40]);
  assert.equal(parse('equivalent.json', records)[0].id, gemini.id);
});

test('retains absent model and date-only precision, and permits explicit tool selection', () => {
  for (const provider of ['gemini-cli', 'cline', 'roo', 'kilo', 'opencode']) {
    const [record] = parse('usage.json', { date: '2026-11-22', total: 100 }, provider);
    assert.equal(record.provider, provider);
    assert.equal(record.model, null);
    assert.equal(record.dateOnly, true);
  }
});

test('reports unsafe timestamp ambiguity, invalid counts and malformed files', () => {
  assert.throws(() => parse('usage.json', { date: '2026-11-01T01:30:00', total: 5 }), /有效的日期/);
  assert.throws(() => parse('usage.json', { date: '2026-02-30', total: 5 }), /有效的日期/);
  assert.throws(() => parse('usage.json', { date: '2026-11-22', total: 1.2 }), /非负整数/);
  assert.throws(() => parse('usage.jsonl', '{"date":"2026-11-22","total":5}\n!'), /第 2 行/);
  assert.throws(() => parse('usage.csv', 'date,model,input\n2026-11-22,"broken,10'), /未闭合/);
  assert.throws(() => parse('usage.json', { date: '2026-11-22', total: 5 }, 'bad-provider'), /请选择要导入/);
});
