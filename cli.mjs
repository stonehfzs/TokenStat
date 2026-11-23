import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { userDataDir } from './lib/data-dir.mjs';
import { defaultPreferences } from './lib/preferences.mjs';
import { estimateRows, estimateTotals } from './lib/pricing.mjs';
import { openStore } from './lib/store.mjs';
import { createDayFormatter } from './public/calendar.js';

const help = 'Usage: node cli.mjs [--today | --week | --month | --days N] [--json] [--no-scan] [--data-dir PATH] [--tz IANA]';
const providerNames = {
  codex: 'Codex', gemini: 'Antigravity', grok: 'Grok', claude: 'Claude Code',
  'gemini-cli': 'Gemini CLI', cline: 'Cline', roo: 'Roo Code', kilo: 'Kilo Code', opencode: 'OpenCode',
};

function periodBounds(period, timeZone, days) {
  const to = createDayFormatter(timeZone)(new Date());
  if (period === 'month') return { from: to.slice(0, 7) + '-01', to };
  if (period === 'today') return { from: to, to };
  const start = new Date(to + 'T00:00:00Z');
  const offset = period === 'week' ? (start.getUTCDay() + 6) % 7 : days - 1;
  start.setUTCDate(start.getUTCDate() - offset);
  if (!Number.isFinite(start.getTime()) || start.getUTCFullYear() < 1) throw new Error('Date range is outside the supported calendar.');
  return { from: start.toISOString().slice(0, 10), to };
}

function usageSummary(entries, exchangeRate) {
  const usage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const entry of entries) {
    usage.totalTokens += entry.total;
    usage.inputTokens += entry.input;
    usage.outputTokens += entry.output;
    usage.cachedTokens += entry.cached;
  }
  const { estimatedCost, cacheSavings, coverage } = estimateTotals(entries);
  return {
    ...usage,
    cacheHitRate: usage.inputTokens ? usage.cachedTokens / usage.inputTokens : null,
    estimatedCost: estimatedCost === null ? null : estimatedCost * exchangeRate,
    cacheSavings: cacheSavings === null ? null : cacheSavings * exchangeRate,
    coverage,
  };
}

function readSummary(store, options) {
  const preferences = store?.getPreferences() ?? defaultPreferences;
  const locale = preferences.locale === 'en' ? 'en-US' : 'zh-CN';
  const zone = options.tz ?? preferences.timeZone ?? defaultPreferences.timeZone;
  if (/^[+-]/u.test(zone)) throw new Error('Use a named IANA time zone, such as Asia/Shanghai.');
  const timeZone = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  const bounds = periodBounds(options.period, timeZone, options.days);
  const currency = preferences.currency === 'CNY' && preferences.cnyPerUsd > 0 ? 'CNY' : 'USD';
  const exchangeRate = currency === 'CNY' ? preferences.cnyPerUsd : 1;
  const entries = estimateRows(store?.readUsage(timeZone, bounds) ?? [], store?.getPriceOverrides());
  const tools = Object.groupBy(entries, (entry) => entry.provider);
  const providers = Object.entries(tools).map(([provider, rows]) => ({
    provider,
    ...usageSummary(rows, exchangeRate),
  })).sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  return { locale, data: {
    period: options.period, ...bounds, timeZone, currency,
    ...usageSummary(entries, exchangeRate), providers,
  } };
}

async function summary(dataDir, options) {
  const filename = join(dataDir, 'tokenstat.db');
  const file = statSync(filename, { throwIfNoEntry: false });
  if (file && !file.isFile()) throw new Error('The TokenStat database path is not a regular file.');
  const hasCache = Boolean(file);
  if (options['no-scan']) {
    const store = hasCache ? openStore(dataDir, { readOnly: true }) : null;
    try { return readSummary(store, options); }
    finally { store?.close(); }
  }

  // Collect in an isolated snapshot, so a terminal refresh cannot contend for the app's writer lock.
  const temporary = await mkdtemp(join(tmpdir(), 'tokenstat-summary-'));
  try {
    if (hasCache) {
      const source = new DatabaseSync(filename, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 5000;');
        source.prepare('VACUUM INTO ?').run(join(temporary, 'tokenstat.db'));
      } finally { source.close(); }
    }
    const store = openStore(temporary);
    try {
      const { collectLocal } = await import('./lib/local-sources.mjs');
      await collectLocal({ paths: store.getPaths() }, { cache: store.cache });
      return readSummary(store, options);
    } finally { store.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function formatText({ data, locale }) {
  const english = locale === 'en-US';
  const numbers = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const currency = new Intl.NumberFormat(locale, { style: 'currency', currency: data.currency, currencyDisplay: 'code', maximumFractionDigits: 6 });
  const amount = (value) => value === null ? '—' : currency.format(value);
  const hitRate = (value) => value === null ? '—' : percent.format(value);
  const lines = [
    `TokenStat  ${data.from} → ${data.to}  (${data.timeZone})`,
    `${english ? 'Tokens' : '总 Token'}  ${numbers.format(data.totalTokens)}  ·  ${english ? 'In / Out' : '输入 / 输出'}  ${numbers.format(data.inputTokens)} / ${numbers.format(data.outputTokens)}`,
    `${english ? 'Cache hit' : '缓存命中'}  ${hitRate(data.cacheHitRate)}  ·  ${english ? 'Estimated cost' : '估算费用'}  ${amount(data.estimatedCost)}  ·  ${english ? 'Cache savings' : '缓存节省'}  ${amount(data.cacheSavings)}`,
  ];
  if (data.coverage.pricedRecords < data.coverage.records) {
    lines.push(`${english ? 'Pricing coverage' : '计价覆盖'}  ${numbers.format(data.coverage.pricedRecords)} / ${numbers.format(data.coverage.records)}`);
  }
  if (data.providers.length) lines.push('', english ? 'By tool' : '按工具');
  for (const tool of data.providers) {
    const label = providerNames[tool.provider] ?? (english ? 'Other' : '其他');
    lines.push(`  ${label.padEnd(14)}  ${numbers.format(tool.totalTokens).padStart(14)}  ${hitRate(tool.cacheHitRate).padStart(8)}  ${amount(tool.estimatedCost)}`);
  }
  return lines.join('\n');
}

try {
  const { values } = parseArgs({ options: {
    today: { type: 'boolean' }, week: { type: 'boolean' }, month: { type: 'boolean' }, days: { type: 'string' },
    json: { type: 'boolean' }, 'no-scan': { type: 'boolean' }, 'data-dir': { type: 'string' },
    tz: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(help);
  } else {
    const periods = ['today', 'week', 'month', 'days'].filter((option) => Object.hasOwn(values, option));
    if (periods.length > 1) throw new Error('Choose one time period.');
    const days = Number(values.days);
    if (values.days !== undefined && (!/^\d+$/u.test(values.days) || !Number.isSafeInteger(days) || days < 1)) {
      throw new Error('--days requires a positive integer.');
    }
    const dataDir = resolve(values['data-dir'] ?? (process.env.TOKENSTAT_DATA_DIR || userDataDir()));
    const options = { ...values, period: periods[0] ?? 'today', days };
    const result = await summary(dataDir, options);
    console.log(values.json ? JSON.stringify(result.data) : formatText(result));
  }
} catch (error) {
  console.error(`TokenStat: ${error.message}`);
  process.exitCode = 1;
}
