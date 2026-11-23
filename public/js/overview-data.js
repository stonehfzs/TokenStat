import { dateMillis, offsetDay, oneDay } from '../calendar.js';

const trendPageSize = 90;

export function validOverviewDate(date) {
  if (typeof date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const timestamp = dateMillis(date);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

export function overviewPeriod(entries, range, today, customRange) {
  let end = today;
  let start;
  let previousStart;
  const monthStart = (date) => `${date.slice(0, 7)}-01`;
  const previousMonth = (date) => monthStart(offsetDay(monthStart(date), -1));

  if (range === 'all') {
    start = offsetDay(today, -6);
    for (const entry of entries) {
      if (entry.date < start) start = entry.date;
      if (entry.date > end) end = entry.date;
    }
    return { start, end, days: (dateMillis(end) - dateMillis(start)) / oneDay + 1, entries };
  }
  if (range === 'month') {
    start = monthStart(today);
    previousStart = previousMonth(today);
  } else if (range === 'last-month') {
    end = offsetDay(monthStart(today), -1);
    start = monthStart(end);
    previousStart = previousMonth(end);
  } else if (range === 'custom' && customRange) {
    ({ from: start, to: end } = customRange);
  } else {
    const days = ['7', '30', '90'].includes(range) ? Number(range) : 30;
    start = offsetDay(end, 1 - days);
  }

  const startTime = dateMillis(start);
  const days = (dateMillis(end) - startTime) / oneDay + 1;
  const compareFrom = previousStart ? dateMillis(previousStart) : startTime - days * oneDay;
  const compareTo = range === 'month' ? Math.min(startTime, compareFrom + days * oneDay) : startTime;
  const current = [];
  const previous = [];
  for (const entry of entries) {
    if (entry.date >= start && entry.date <= end) current.push(entry);
    else if (entry.date < start) {
      const timestamp = dateMillis(entry.date);
      if (timestamp >= compareFrom && timestamp < compareTo) previous.push(entry);
    }
  }
  return { start, end, days, entries: current, previous };
}

export function overviewTrend({ start, end, entries, mode, metric, hidden, page }) {
  const days = (dateMillis(end) - dateMillis(start)) / oneDay + 1;
  const pages = Math.ceil(days / trendPageSize);
  page = Math.min(page, pages - 1);
  const last = offsetDay(end, -page * trendPageSize);
  const count = Math.min(trendPageSize, days - page * trendPageSize);
  const first = offsetDay(last, 1 - count);
  const firstTime = dateMillis(first);
  const costs = metric === 'cost';
  const buckets = Array.from({ length: count }, (_, index) => ({
    date: offsetDay(first, index), values: {}, total: 0, records: 0, pricedRecords: 0, pricedTokens: 0, totalTokens: 0,
  }));

  for (const entry of entries) {
    if (mode === 'provider' && hidden.has(entry.provider)) continue;
    const bucket = buckets[(dateMillis(entry.date) - firstTime) / oneDay];
    if (!bucket) continue;
    if (costs) {
      const records = entry.count ?? 1;
      const priced = entry.estimatedCost != null;
      bucket.records += records;
      bucket.pricedRecords += entry.pricedRecords ?? (priced ? records : 0);
      bucket.pricedTokens += entry.pricedTokens ?? (priced ? entry.total : 0);
      bucket.totalTokens += entry.total;
    }

    if (mode === 'io') {
      const cost = entry.costBreakdown;
      const input = costs ? (cost ? cost.freshInput + cost.cachedInput + cost.cacheWrite : 0) : entry.input;
      const output = costs ? (cost ? cost.output + cost.reasoning : 0) : entry.output;
      if (!hidden.has('input')) {
        bucket.values.input = (bucket.values.input ?? 0) + input;
        bucket.total += input;
      }
      if (!hidden.has('output')) {
        bucket.values.output = (bucket.values.output ?? 0) + output;
        bucket.total += output;
      }
    } else {
      const value = costs ? entry.estimatedCost ?? 0 : entry.total;
      bucket.values[entry.provider] = (bucket.values[entry.provider] ?? 0) + value;
      bucket.total += value;
    }
  }
  return { buckets, first, last, pages, page };
}

function reportModelName(model) {
  // Recognize conventional model IDs and public provider prefixes without copying arbitrary imported paths.
  const name = /^(?:(?:openai|anthropic|google|xai|x-ai|deepseek|qwen|meta-llama|mistralai|models|publishers\/google\/models)\/)?[\p{L}\p{N}][\p{L}\p{N}_.:+-]{0,127}$/u;
  return typeof model === 'string' && name.test(model) ? model : null;
}

export function reportSummary(entries, start, end) {
  const first = dateMillis(start);
  const count = (dateMillis(end) - first) / oneDay + 1;
  const daily = Array(Math.min(count, 60)).fill(0);
  const tools = new Map();
  const models = new Map();
  let total = 0;
  let estimatedCost = null;
  let cacheSavings = null;
  let pricedTokens = 0;

  for (const entry of entries) {
    const { date, provider, model, total: tokens, estimatedCost: cost, cacheSavings: savings } = entry;
    total += tokens;
    if (cost != null) {
      estimatedCost = (estimatedCost ?? 0) + cost;
      pricedTokens += entry.pricedTokens ?? tokens;
    }
    if (savings != null) cacheSavings = (cacheSavings ?? 0) + savings;
    tools.set(provider, (tools.get(provider) ?? 0) + tokens);
    const name = reportModelName(model);
    const key = JSON.stringify([provider, name]);
    const item = models.get(key) ?? { provider, name, total: 0 };
    item.total += tokens;
    models.set(key, item);
    const index = Math.floor((dateMillis(date) - first) / oneDay * daily.length / count);
    if (index >= 0 && index < daily.length) daily[index] += tokens;
  }

  const top = (items) => items.sort((a, b) => b.total - a.total).slice(0, 3);
  return { total, estimatedCost, cacheSavings, pricedTokens, daily,
    tools: top([...tools].map(([provider, tokens]) => ({ provider, total: tokens }))), models: top([...models.values()]),
  };
}
