import { t as translateText } from './i18n.js';
import { fields, percent, providers, state } from './state.js';
import { t } from './i18n.js';
import { setElementStyle } from './dynamic-style.js';

const byId = (id) => document.getElementById(id);

const get = (selector) => [...document.querySelectorAll(selector)];

const icons = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M7 3v4 M17 3v4 M3 10h18',
  database: 'M21 5c0 1.7-4 3-9 3S3 6.7 3 5s4-3 9-3 9 1.3 9 3z M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5 M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
  upload: 'M12 16V3m-5 5 5-5 5 5 M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  download: 'M12 3v13m-5-5 5 5 5-5 M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  shield: 'M12 22c5-2 8-6 8-11V5l-8-3-8 3v6c0 5 3 9 8 11z M8.5 12l2.2 2.2 4.8-4.8',
  flask: 'M9 3h6m-5 0v7l-5.5 9a1.3 1.3 0 0 0 1.2 2h12.6a1.3 1.3 0 0 0 1.2-2L14 10V3 M8 14h8',
  refresh: 'M20 7V3m0 4h-4M4 17v4m0-4h4 M20 7a9 9 0 0 0-15-1l-1.5 3 M4 17a9 9 0 0 0 15 1l1.5-3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  'arrow-right': 'M4 12h16m-5-5 5 5-5 5',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-left': 'm15 5-7 7 7 7',
  chart: 'M3 3v17h18 M7 16v-4m5 4V8m5 8V4',
  spark: 'M12 2c1.5 6 4 8.5 10 10-6 1.5-8.5 4-10 10-1.5-6-4-8.5-10-10 6-1.5 8.5-4 10-10z',
  code: 'M4 6l6 6-6 6m9 0h7',
  grok: 'M4 18 20 3 M19 8c3 5-.2 11-6 12-5 1-10-3-10-8s4-9 9-9c2 0 4 .7 5 1.5',
  sun: 'M12 3v2m0 14v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M3 12h2m14 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z',
  alert: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  check: 'M20 6 9 17l-5-5',
};

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => htmlEscapes[character]);

const svgMarkup = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || ''}"/></svg>`;

const icon = (name) => `<span data-icon="${name}">${svgMarkup(name)}</span>`;

const emptyStats = () => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0, count: 0, withoutReasoning: 0,
  estimatedCost: null, reportedCostUsd: null, pricedTokens: 0, unpricedReasons: {} });

const tableEmpty = (message, columns) => `<tr><td colspan="${columns}" class="empty-table">${message}</td></tr>`;

const isLoading = () => state.busy && !state.snapshot && !state.demo;

const isReviewRoute = (provider, model) => provider === 'codex' && model === 'codex-auto-review';

const gliderMap = new WeakMap();

function syncGlider(container, activeSelector, instant = false) {
  if (!container) return;
  const active = container.querySelector(activeSelector);
  let glider = gliderMap.get(container);
  if (!glider) {
    glider = document.createElement('span');
    glider.className = 'glider no-transition';
    glider.setAttribute('aria-hidden', 'true');
    container.prepend(glider);
    gliderMap.set(container, glider);
    new ResizeObserver(() => syncGlider(container, activeSelector, true)).observe(container);
  }
  if (!active || active.offsetWidth === 0) {
    setElementStyle(glider, { opacity: '0' });
    return;
  }
  if (instant) glider.classList.add('no-transition');
  else glider.classList.remove('no-transition');
  setElementStyle(glider, {
    opacity: '1', width: `${active.offsetWidth}px`, height: `${active.offsetHeight}px`,
    transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`,
  });
  if (instant) {
    glider.getBoundingClientRect();
    glider.classList.remove('no-transition');
  }
}

function syncAllGliders(instant = false) {
  syncGlider(document.querySelector('.topnav'), 'a[aria-current="page"]', instant);
  syncGlider(byId('range-controls'), 'button[aria-pressed="true"]', instant);
  syncGlider(byId('chart-style-controls'), 'button[aria-pressed="true"]', instant);
  syncGlider(byId('trend-mode-controls'), 'button[aria-pressed="true"]', instant);
  syncGlider(byId('trend-metric-controls'), 'button[aria-pressed="true"]', instant);
}

function getColorVar(cssVar, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || fallback;
}

function hydrateStaticIcons() {
  for (const el of get('[data-icon]')) {
    if (!el.firstElementChild) {
      el.innerHTML = svgMarkup(el.dataset.icon);
    }
  }
}

function applyDynamicStyles() {
  for (const el of get('[data-bar-pct]')) {
    const pct = Number(el.dataset.barPct);
    setElementStyle(el, { width: `${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))}%` });
  }
  for (const el of get('[data-bar-h]')) {
    const pct = Number(el.dataset.barH);
    setElementStyle(el, { height: `${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))}%` });
  }
  for (const el of get('[data-ring-pct]')) {
    const r = 18;
    const circ = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(1, Number(el.dataset.ringPct) || 0));
    el.setAttribute('stroke-dasharray', circ.toFixed(2));
    el.setAttribute('stroke-dashoffset', (circ * (1 - pct)).toFixed(2));
  }
}

function toolList(entries) {
  const used = new Set(entries.map((entry) => entry.provider));
  return providers
    .filter((provider, index) => index < 3 || used.has(provider.id))
    .map((provider) => ({ ...provider, color: getColorVar(provider.cssVar, provider.fallback) }));
}

function totals(entries) {
  return entries.reduce((sum, entry) => {
    addUsage(sum, entry);
    return sum;
  }, emptyStats());
}

function addUsage(sum, entry) {
  for (const property of fields) sum[property] += entry[property];
  sum.count += entry.count;
  sum.withoutReasoning += entry.withoutReasoning ?? 0;
  sum.pricedTokens += entry.pricedTokens ?? 0;
  for (const [reason, { records, tokens }] of Object.entries(entry.unpricedReasons ?? {})) {
    const bucket = sum.unpricedReasons[reason] ??= { records: 0, tokens: 0 };
    bucket.records += records;
    bucket.tokens += tokens;
  }
  if (entry.estimatedCost != null) sum.estimatedCost = (sum.estimatedCost ?? 0) + entry.estimatedCost;
  if (entry.reportedCostUsd != null) sum.reportedCostUsd = (sum.reportedCostUsd ?? 0) + entry.reportedCostUsd;
}

function sourceLabel(source) {
  return source === 'import' ? translateText('文件导入') : source.replace(/^同步 · /u, t('同步') + ' · ');
}

function sourceChip(source, provider) {
  if (!source) return '—';
  const style = source === translateText('文件导入') || source === translateText('示例数据') ? '' : ' connected';
  return `<span class="chip${style}" data-provider="${provider}"><i class="status-dot"></i>${escapeHtml(source)}</span>`;
}

function providerName(provider, modelCount = 0) {
  const badge = modelCount > 0 ? `<span class="model-count-badge">${modelCount}</span>` : '';
  return `<span class="table-provider"><span class="provider-badge" data-provider="${provider.id}">${icon(provider.icon)}</span><span>${provider.name}</span>${badge}</span>`;
}

function deltaBadgeHtml(currentVal, prevVal) {
  if (!prevVal || prevVal <= 0) return '';
  const change = (currentVal - prevVal) / prevVal;
  const cls = change === 0 ? ' flat' : change < 0 ? ' down' : '';
  const label = change === 0 ? translateText('持平') : `${change > 0 ? '+' : '-'}${percent.format(Math.abs(change))}`;
  return `<span class="delta-badge${cls}">${label}</span>`;
}

let toastTimer;

function toast(message) {
  const target = byId('toast');
  target.innerHTML = `${icon('check')}<span>${escapeHtml(message)}</span>`;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3400);
}

export { addUsage, applyDynamicStyles, byId, deltaBadgeHtml, emptyStats, escapeHtml, get, getColorVar, hydrateStaticIcons, icon, isLoading, isReviewRoute, providerName, sourceChip, sourceLabel, svgMarkup, syncAllGliders, tableEmpty, toast, toolList, totals };
