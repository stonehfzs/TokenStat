import { locale } from './i18n.js';
import { full } from './state.js';

const labels = {
  incompatibleTokenBreakdown: ['Token 口径不一致', 'Inconsistent token breakdown'],
  missingModelRate: ['缺少模型单价', 'Model rate unavailable'],
  unknownRequestTier: ['无法判定请求上下文档位', 'Request context tier unknown'],
  missingCacheWriteRate: ['缺少缓存写入单价', 'Cache write rate unavailable'],
  missingCacheReadRate: ['缺少缓存读取单价', 'Cache read rate unavailable'],
  missingReasoningBreakdown: ['缺少独立推理计数', 'Separate reasoning count unavailable'],
};

function counts(records, tokens, english) {
  return english ? `${full(records)} records · ${full(tokens)} tokens` : `${full(records)} 条记录 · ${full(tokens)} Token`;
}

export function unpricedDetails(reasons) {
  const rows = Object.entries(labels).filter(([key]) => reasons?.[key]?.records > 0);
  if (!rows.length) return '';
  const english = locale === 'en-US';
  const total = rows.reduce((sum, [key]) => ({
    records: sum.records + reasons[key].records,
    tokens: sum.tokens + reasons[key].tokens,
  }), { records: 0, tokens: 0 });
  return `<details class="unpriced-details">
    <summary>${english ? 'Unpriced' : '未计价'} · ${counts(total.records, total.tokens, english)}</summary>
    <ul>${rows.map(([key, text]) =>
      `<li>${text[english ? 1 : 0]} · ${counts(reasons[key].records, reasons[key].tokens, english)}</li>`).join('')}</ul>
  </details>`;
}
