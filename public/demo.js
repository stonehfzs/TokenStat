import { t as translateText } from './js/i18n.js';
export function demoUsage(today, offsetDay) {
  const providers = [
    { provider: 'codex', model: 'gpt-5.4', ratio: .55, inputRatio: .84, rates: { input: 2, cached: .2, output: 10 } },
    { provider: 'gemini', model: 'gemini-2.5-pro', ratio: .28, inputRatio: .76, rates: { input: 1.25, cached: .125, output: 10 } },
    { provider: 'grok', model: 'grok-4', ratio: .17, inputRatio: .71 },
  ];
  const waves = [38, 28, 53, 73, 52, 33, 66, 40, 57, 87, 72, 55, 102, 80, 62, 43, 60, 83, 60, 113, 83, 57, 90, 65, 101, 120, 93, 71, 102, 88];
  return Array.from({ length: 60 }, (_, index) => {
    const date = offsetDay(today, -59 + index);
    const baseline = waves[index % waves.length] * (index < 30 ? 8100 : 10300);
    return providers.map(({ provider, model, ratio, inputRatio, rates }, tool) => {
      const total = Math.round(baseline * ratio * (1 + .13 * Math.cos(index + tool)));
      const input = Math.round(total * inputRatio);
      const output = total - input;
      const cached = Math.round(input * (.22 + tool * .1));
      const reasoning = Math.round(output * .24);
      const count = 4 + (index + tool) % 10;
      // Fixed sample rates keep the preview self-contained and independent of user settings.
      const costBreakdown = rates ? {
        freshInput: (input - cached) * rates.input / 1_000_000,
        cachedInput: cached * rates.cached / 1_000_000,
        cacheWrite: 0,
        output: (output - reasoning) * rates.output / 1_000_000,
        reasoning: reasoning * rates.output / 1_000_000,
      } : null;
      return {
        date, provider, model, total, input, output, cached, reasoning, count, source: translateText('示例数据'),
        costBreakdown,
        estimatedCost: costBreakdown ? Object.values(costBreakdown).reduce((sum, cost) => sum + cost, 0) : null,
        cacheSavings: rates ? cached * (rates.input - rates.cached) / 1_000_000 : null,
        pricedRecords: rates ? count : 0,
        pricedTokens: rates ? total : 0,
        unpricedReasons: rates ? {} : { missingModelRate: { records: count, tokens: total } },
      };
    });
  }).flat();
}
