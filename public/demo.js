import { t as translateText } from './js/i18n.js';
export function demoUsage(today, offsetDay) {
  const providers = [
    { provider: 'codex', model: 'gpt-5.4', ratio: .55, inputRatio: .84 },
    { provider: 'gemini', model: 'gemini-2.5-pro', ratio: .28, inputRatio: .76 },
    { provider: 'grok', model: 'grok-4', ratio: .17, inputRatio: .71 },
  ];
  const waves = [38, 28, 53, 73, 52, 33, 66, 40, 57, 87, 72, 55, 102, 80, 62, 43, 60, 83, 60, 113, 83, 57, 90, 65, 101, 120, 93, 71, 102, 88];
  return Array.from({ length: 60 }, (_, index) => {
    const date = offsetDay(today, -59 + index);
    const baseline = waves[index % waves.length] * (index < 30 ? 8100 : 10300);
    return providers.map(({ provider, model, ratio, inputRatio }, tool) => {
      const total = Math.round(baseline * ratio * (1 + .13 * Math.cos(index + tool)));
      const input = Math.round(total * inputRatio);
      const output = total - input;
      return {
        date, provider, model, total, input, output, source: translateText('示例数据'),
        cached: Math.round(input * (.22 + tool * .1)),
        reasoning: Math.round(output * .24),
        count: 4 + (index + tool) % 10,
      };
    });
  }).flat();
}
