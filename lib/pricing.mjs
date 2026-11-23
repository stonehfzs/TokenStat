const perMillion = 1_000_000;
const costTicksPerDollar = 10_000_000_000;
const rateFields = ['input', 'cached', 'cacheWrite', 'output', 'reasoning'];
const emptyBreakdown = { freshInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const breakdownFields = Object.keys(emptyBreakdown);
const claudePricing = 'https://platform.claude.com/docs/en/about-claude/pricing';

export const pricingBasis = { currency: 'USD', asOf: '2026-11-22', serviceTier: 'standard' };

function openAIRate(model, input, cached, output) {
  return {
    model, input, cached, output,
    longContext: { minInput: 272_001, input: input * 2, cached: cached * 2, output: output * 1.5 },
    source: 'https://developers.openai.com/api/docs/models/' + model,
  };
}

function xaiRate(model, input, cached, output) {
  return {
    model, input, cached, output,
    longContext: { minInput: 200_000, input: input * 2, cached: cached * 2, output: output * 2 },
    source: 'https://docs.x.ai/developers/pricing',
  };
}

export const defaultRates = [
  openAIRate('gpt-6.2-astra', 8, 0.40, 40),
  openAIRate('gpt-6.2-sol', 2, 0.10, 10),
  openAIRate('gpt-6-astra', 10, 1, 50),
  openAIRate('gpt-6.1-sol', 2, 0.10, 10),
  openAIRate('gpt-6.1-terra', 1, 0.05, 5),
  openAIRate('gpt-6-sol', 2, 0.20, 10),
  openAIRate('gpt-6-luna', 0.10, 0.01, 0.50),
  { model: 'gpt-5.3-codex', input: 1.75, cached: 0.175, output: 14, source: 'https://developers.openai.com/api/docs/models/gpt-5.3-codex' },
  { model: 'gemini-4-neon', input: 3, cached: 0.15, output: 15, source: 'https://aistudio.google.com/docs/pricing#gemini-4-neon' },
  { model: 'gemini-4-hydrogen', input: 1.50, cached: 0.075, output: 7.50, source: 'https://aistudio.google.com/docs/pricing#gemini-4-hydrogen' },
  { model: 'gemini-2.5-pro', input: 1.25, cached: 0.125, output: 10,
    longContext: { minInput: 200_001, input: 2.50, cached: 0.25, output: 15 },
    source: 'https://aistudio.google.com/docs/pricing#gemini-2.5-pro' },
  { model: 'gemini-2.5-flash', input: 0.30, cached: 0.03, output: 2.50, source: 'https://aistudio.google.com/docs/pricing#gemini-2.5-flash' },
  { model: 'gemini-2.5-flash-lite', input: 0.10, cached: 0.01, output: 0.40, source: 'https://aistudio.google.com/docs/pricing#gemini-2.5-flash-lite' },
  { model: 'claude-opus-5-5', input: 4, cached: 0.20, output: 20, source: claudePricing },
  { model: 'claude-opus-5', input: 5, cached: 0.50, output: 25, source: claudePricing },
  { model: 'claude-opus-4-8', input: 5, cached: 0.50, output: 25, source: claudePricing },
  { model: 'claude-opus-4-7', input: 5, cached: 0.50, output: 25, source: claudePricing },
  { model: 'claude-opus-4-6', input: 5, cached: 0.50, output: 25, source: claudePricing },
  { model: 'claude-opus-4-5', input: 5, cached: 0.50, output: 25, source: claudePricing },
  { model: 'claude-sonnet-5-5', input: 2, cached: 0.10, output: 10, source: claudePricing },
  { model: 'claude-sonnet-5', input: 2, cached: 0.20, output: 10, source: claudePricing },
  { model: 'claude-sonnet-4-6', input: 3, cached: 0.30, output: 15, source: claudePricing },
  { model: 'claude-sonnet-4-5', input: 3, cached: 0.30, output: 15, source: claudePricing },
  { model: 'claude-haiku-5-5', input: 0.10, cached: 0.01, output: 0.50,
    longContext: { minInput: 100_001, input: 0.50, cached: 0.05, output: 2.50 }, source: claudePricing },
  { model: 'claude-haiku-4-5', input: 1, cached: 0.10, output: 5, source: claudePricing },
  xaiRate('grok-4.7', 2, 0.50, 6),
  xaiRate('grok-4.6', 2, 0.50, 6),
  xaiRate('grok-4.5', 2, 0.30, 6),
  xaiRate('grok-4.3', 1.25, 0.20, 2.50),
  xaiRate('grok-build-0.1', 1, 0.20, 2),
  xaiRate('grok-4.20-multi-agent-0309', 1.25, 0.20, 2.50),
  xaiRate('grok-4.20-0309-reasoning', 1.25, 0.20, 2.50),
  xaiRate('grok-4.20-0309-non-reasoning', 1.25, 0.20, 2.50),
];

const defaultsByModel = new Map(defaultRates.map((rate) => [rate.model, rate]));
const namespaces = [
  /^(?:publishers\/google\/models\/|models\/|google\/)(?=gemini-)/u,
  /^anthropic[./](?=claude-)/u,
  /^openai\/(?=gpt-)/u,
  /^x-?ai\/(?=grok-)/u,
];
const claudeSnapshots = new Map([
  ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
  ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
]);
const openAIReleases = new Map([
  ['gpt-6.2-astra', '2026-11-17'],
  ['gpt-6.2-sol', '2026-11-17'],
  ['gpt-6.1-terra', '2026-10-26'],
  ['gpt-6.1-sol', '2026-09-29'],
  ['gpt-6-sol', '2026-09-22'],
  ['gpt-6-luna', '2026-09-22'],
  ['gpt-6-astra', '2026-09-03'],
  ['gpt-5.3-codex', '2026-02-24'],
]);
const rateKey = (provider, model) => JSON.stringify([provider, model]);

export function resolveDefaultRate(model) {
  if (typeof model !== 'string') return undefined;
  const exact = defaultsByModel.get(model);
  if (exact) return exact;
  const namespace = namespaces.find((prefix) => prefix.test(model));
  const unqualified = namespace ? model.replace(namespace, '') : model;
  const id = unqualified.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)$/u, '$1-$2');
  const known = defaultsByModel.get(claudeSnapshots.get(id) ?? id);
  if (known) return known;
  // Resolve only a calendar-date suffix on known OpenAI families within the verified catalog period.
  const snapshot = /^(gpt-[a-z0-9.-]+)-(\d{4}-\d\d-\d\d)$/u.exec(id);
  if (!snapshot) return undefined;
  const [, family, day] = snapshot;
  const release = openAIReleases.get(family);
  if (!release || day < release || day > pricingBasis.asOf) return undefined;
  const instant = new Date(day + 'T00:00:00Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === day
    ? defaultsByModel.get(family) : undefined;
}

function tierForRate(rate, input, requestLevel) {
  if (!rate?.longContext) return 'flat';
  if ((requestLevel !== true && requestLevel !== 1) || !Number.isSafeInteger(input) || input < 0) return 'unknown';
  return input >= rate.longContext.minInput ? 'long' : 'short';
}

export function pricingTier(model, input, requestLevel) {
  return tierForRate(resolveDefaultRate(model), input, requestLevel);
}

export function priceIdentity(provider, model, providers) {
  if (!providers.includes(provider) || typeof model !== 'string' || !model.trim() ||
      model.length > 512 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(model)) {
    throw new Error('请选择工具，并填写日志中的完整模型 ID。');
  }
  return { provider, model };
}

export function normalizeRate(data, providers) {
  const id = priceIdentity(data.provider, data.model, providers);
  const rate = { ...id };
  for (const field of rateFields) {
    const value = data[field];
    if (value === '' || value == null) {
      if (field === 'input' || field === 'output') throw new Error('输入和输出单价为必填项。');
      rate[field] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > perMillion) {
      throw new Error('单价必须是 0 到 1,000,000 之间的数字。');
    }
    rate[field] = value;
  }
  return rate;
}

function unpricedReason(bucket, rate, unknownTier) {
  const { input, cached, cacheWrite = 0, output, reasoning, total } = bucket;
  if (bucket.breakdownValid === false
      || ![input, cached, cacheWrite, output, reasoning, total].every((value) => Number.isSafeInteger(value) && value >= 0)
      || input + output !== total || cached + cacheWrite > input || reasoning > output) return 'incompatibleTokenBreakdown';
  if (!rate) return 'missingModelRate';
  if (unknownTier) return 'unknownRequestTier';
  if (cacheWrite && rate.cacheWrite == null) return 'missingCacheWriteRate';
  if (cached && rate.cached == null) return 'missingCacheReadRate';
  if (rate.reasoning != null && rate.reasoning !== rate.output
      && (bucket.withoutReasoning || bucket.reasoningKnown === false)) return 'missingReasoningBreakdown';
  return null;
}

function addUnpriced(reasons, reason, records, tokens) {
  const count = reasons[reason] ??= { records: 0, tokens: 0 };
  count.records += records;
  count.tokens += tokens;
}

function estimateBucket(bucket, rate) {
  const { input, cached, cacheWrite = 0, output, reasoning } = bucket;
  const fresh = input - cached - cacheWrite;
  const costBreakdown = {
    freshInput: fresh * rate.input / perMillion,
    cachedInput: cached * (rate.cached ?? 0) / perMillion,
    cacheWrite: cacheWrite * (rate.cacheWrite ?? 0) / perMillion,
    output: (output - reasoning) * rate.output / perMillion,
    reasoning: reasoning * (rate.reasoning ?? rate.output) / perMillion,
  };
  return {
    costBreakdown,
    estimatedCost: breakdownFields.reduce((total, field) => total + costBreakdown[field], 0),
    cacheSavings: input * rate.input / perMillion - costBreakdown.freshInput - costBreakdown.cachedInput - costBreakdown.cacheWrite,
  };
}

export function estimateRows(entries, overrides = []) {
  const byProviderAndModel = new Map(overrides.map((rate) => [rateKey(rate.provider, rate.model), rate]));
  return entries.map((entry) => {
    const override = byProviderAndModel.get(rateKey(entry.provider, entry.model));
    const rate = override ?? resolveDefaultRate(entry.model);
    const tiered = !override && Boolean(rate?.longContext);
    const buckets = entry.priceBuckets ?? [{ ...entry, tier: tierForRate(rate, entry.input, entry.requestLevel) }];
    let estimatedCost = 0;
    let cacheSavings = 0;
    let pricedRecords = 0;
    let pricedTokens = 0;
    let shortRequests = 0;
    let longRequests = 0;
    let unclassifiedRecords = 0;
    const costBreakdown = { ...emptyBreakdown };
    const unpricedReasons = {};
    for (const bucket of buckets) {
      const count = bucket.count ?? 1;
      const unknownTier = tiered && bucket.tier !== 'short' && bucket.tier !== 'long';
      if (unknownTier) unclassifiedRecords += count;
      const bucketRate = tiered && bucket.tier === 'long' ? rate.longContext : rate;
      const reason = unpricedReason(bucket, bucketRate, unknownTier);
      if (reason) {
        addUnpriced(unpricedReasons, reason, count, bucket.total ?? 0);
        continue;
      }
      const cost = estimateBucket(bucket, bucketRate);
      if (tiered && bucket.tier === 'short') shortRequests += count;
      if (tiered && bucket.tier === 'long') longRequests += count;
      estimatedCost += cost.estimatedCost;
      cacheSavings += cost.cacheSavings;
      pricedRecords += count;
      pricedTokens += bucket.total;
      for (const field of breakdownFields) costBreakdown[field] += cost.costBreakdown[field];
    }
    const hasReportedCost = Number.isSafeInteger(entry.reportedCostRecords) && entry.reportedCostRecords > 0
      && Number.isSafeInteger(entry.reportedCostTicks) && entry.reportedCostTicks >= 0;
    const reportedCostRecords = hasReportedCost ? entry.reportedCostRecords : 0;
    return {
      ...entry,
      estimatedCost: pricedRecords ? estimatedCost : null,
      cacheSavings: pricedRecords ? cacheSavings : null,
      costBreakdown: pricedRecords ? costBreakdown : null,
      pricedTokens, pricedRecords, shortRequests, longRequests, unclassifiedRecords,
      unpricedReasons,
      reportedCostRecords,
      reportedCostUsd: reportedCostRecords ? entry.reportedCostTicks / costTicksPerDollar : null,
    };
  });
}

export function estimateTotals(entries) {
  let estimatedCost = 0;
  let cacheSavings = 0;
  let pricedTokens = 0;
  let totalTokens = 0;
  let pricedRecords = 0;
  let records = 0;
  let shortRequests = 0;
  let longRequests = 0;
  let unclassifiedRecords = 0;
  let reportedCostUsd = 0;
  let reportedRecords = 0;
  const costBreakdown = { ...emptyBreakdown };
  const unpricedReasons = {};
  for (const entry of entries) {
    totalTokens += entry.total;
    records += entry.count ?? 1;
    shortRequests += entry.shortRequests ?? 0;
    longRequests += entry.longRequests ?? 0;
    unclassifiedRecords += entry.unclassifiedRecords ?? 0;
    for (const [reason, { records: count, tokens }] of Object.entries(entry.unpricedReasons ?? {})) {
      addUnpriced(unpricedReasons, reason, count, tokens);
    }
    if (entry.reportedCostUsd != null) {
      reportedCostUsd += entry.reportedCostUsd;
      reportedRecords += entry.reportedCostRecords;
    }
    if (entry.estimatedCost == null) continue;
    estimatedCost += entry.estimatedCost;
    cacheSavings += entry.cacheSavings;
    pricedTokens += entry.pricedTokens ?? entry.total;
    pricedRecords += entry.pricedRecords ?? entry.count ?? 1;
    for (const field of breakdownFields) costBreakdown[field] += entry.costBreakdown?.[field] ?? 0;
  }
  return {
    currency: pricingBasis.currency,
    pricingBasis,
    estimatedCost: pricedRecords ? estimatedCost : null,
    cacheSavings: pricedRecords ? cacheSavings : null,
    costBreakdown: pricedRecords ? costBreakdown : null,
    pricedTokens, pricedRecords, shortRequests, longRequests, unclassifiedRecords,
    unpricedReasons,
    reportedCostUsd: reportedRecords ? reportedCostUsd : null,
    reportedCostCoverage: { reportedRecords, records },
    coverage: { pricedTokens, totalTokens, pricedRecords, records },
  };
}
