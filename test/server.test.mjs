import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startServer } from '../server.mjs';
import { openStore } from '../lib/store.mjs';
import { usagePeriods } from '../lib/preferences.mjs';

const sources = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo'];

async function fixture(testContext, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-api-'));
  let backend;
  testContext.after(async () => {
    try { await backend?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const empty = join(root, 'logs');
  const dataDir = join(root, 'data');
  await mkdir(empty);
  const store = openStore(dataDir);
  try { for (const provider of sources) store.setPath(provider, empty); }
  finally { store.close(); }
  backend = await startServer({ port: 0, dataDir, ...config });
  const api = (path, body, origin = backend.url) => fetch(backend.url + '/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  const json = async (...args) => {
    const response = await api(...args);
    assert.equal(response.ok, true, args[0] + ': ' + response.status);
    return response.json();
  };
  return { ...backend, api, json };
}

function rawRequest(origin, path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    http.get({ hostname, port, path, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

const upload = (date, id, tokens) => ({
  filename: id + '.json', provider: 'auto',
  content: JSON.stringify({ date, id, provider: 'codex', model: 'gpt-6.2-sol', input: tokens, total: tokens }),
});

test('serves nested ES modules and CSS while rejecting encoded path traversal and foreign writes', async (t) => {
  const app = await fixture(t);
  const index = await fetch(app.url);
  assert.equal(index.ok, true);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await index.text(), /TokenStat/);
  assert.match((await fetch(app.url + '/js/state.js')).headers.get('content-type'), /javascript/);
  assert.match((await fetch(app.url + '/css/base.css')).headers.get('content-type'), /css/);
  for (const path of ['/../package.json', '/js/%2e%2e/%2e%2e/server.mjs', '/js/%5c..%5capp.js', '/%252e%252e/server.mjs']) {
    assert.equal(await rawRequest(app.url, path), 403, path);
  }
  assert.equal(await rawRequest(app.url, '/server.mjs'), 404);
  assert.equal((await app.api('preferences', { currency: 'USD' }, 'https://example.org')).status, 403);
  assert.equal((await app.api('backup/export', {}, 'https://example.org')).status, 403);
  assert.equal((await app.api('preferences', { currency: 'CNY', cnyPerUsd: 0 })).status, 400);
});

test('backup round-trips local configuration and imports with deduplication and no sync key', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.json('preferences', { locale: 'en', currency: 'CNY', cnyPerUsd: 7, budgets: { dailyTokens: 300 } });
  await first.json('pricing', { provider: 'codex', model: 'gpt-6.2-sol', input: 0.5, output: 0.8 });
  await first.json('import', upload('2026-11-22', 'kept-backup', 67));
  const backup = await first.json('backup/export', {});
  assert.equal(backup.format, 'tokenstat-backup');
  assert.equal(backup.records.length, 1);
  assert.equal(backup.preferences.locale, 'en');
  assert.equal('key' in backup || 'sync' in backup, false);
  assert.equal((await second.json('backup/restore', backup)).added, 1);
  assert.equal((await second.json('backup/restore', backup)).duplicate, 1);
  assert.equal((await second.json('usage')).coverage.totalTokens, 67);
  assert.equal((await second.json('preferences')).preferences.cnyPerUsd, 7);
  assert.equal((await second.json('pricing')).overrides[0].input, 0.5);
  const scoped = await second.json('usage?device=local');
  assert.equal(scoped.coverage.totalTokens, 67);
  assert.equal((await second.api('usage?device=bad')).status, 400);
});

test('delivers one notification per budget threshold as usage crosses 80% then 100%', async (t) => {
  const shown = [];
  const app = await fixture(t, { notifyBudget: async (item) => { shown.push(item); return true; } });
  const day = usagePeriods({ timeZone: 'Asia/Shanghai' }).day;
  const waitFor = async (expected) => {
    for (let count = 0; count < 40 && shown.length < expected; count++) await delay(100);
    assert.equal(shown.length, expected);
  };
  await app.json('preferences?timeZone=Asia%2FShanghai', { budgets: { dailyTokens: 100 }, locale: 'en' });
  await app.json('import', upload(day, 'first-budget', 79));
  await delay(550);
  assert.equal(shown.length, 0);
  await app.json('import', upload(day, 'cross-eighty', 1));
  await waitFor(1);
  assert.match(shown[0].title, /80%/);
  await app.json('import', upload(day, 'cross-hundred', 20));
  await waitFor(2);
  assert.match(shown[1].title, /100%/);
  await app.json('import', upload(day, 'above-limit', 25));
  await delay(550);
  assert.equal(shown.length, 2);
  assert.deepEqual((await app.json('tray')).totalTokens, 125);
});

test('turning off a budget while another notification is in flight cancels pending alerts', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const shown = [];
  const app = await fixture(t, { notifyBudget: async (item) => {
    shown.push(item);
    started.resolve();
    return release.promise;
  } });
  const day = usagePeriods({ timeZone: 'Asia/Shanghai' }).day;
  try {
    await app.json('preferences?timeZone=Asia%2FShanghai', { locale: 'en', budgets: { dailyTokens: 100, monthlyTokens: 100 } });
    await app.json('import', upload(day, 'started-while-enabled', 105));
    await Promise.race([started.promise, delay(4_000, undefined, { ref: false }).then(() => { throw new Error('No notification sent'); })]);
    await app.json('preferences?timeZone=Asia%2FShanghai', { budgets: { monthlyTokens: null } });
  } finally {
    release.resolve(true);
  }
  await delay(950);
  assert.deepEqual(shown.map(({ title }) => title), ['Daily Token budget reached 100%']);
});
