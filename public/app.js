import { createTrend, createDonut, createSparkline } from './charts.js';
import { demoUsage } from './demo.js';
import { createDayFormatter } from './calendar.js';

const byId = (id) => document.getElementById(id);
const get = (selector) => [...document.querySelectorAll(selector)];
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatDay = createDayFormatter(timeZone);
const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', dateStyle: 'long' });
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clockTime = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit' });
const abbreviated = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const precise = new Intl.NumberFormat('zh-CN');
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const full = (value) => precise.format(value);
const compact = (value) => value >= 1000 ? abbreviated.format(value) : full(value);
const oneDay = 86400000;
const trendPageSize = 90;
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const rhythmOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
const fields = ['input', 'output', 'cached', 'reasoning', 'total'];
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const providers = [
  { id: 'codex', name: 'Codex', cssVar: '--c-codex', fallback: '#2dd4bf', icon: 'code', client: 'Codex 会话日志', path: '~/.codex' },
  { id: 'gemini', name: 'Antigravity', cssVar: '--c-gemini', fallback: '#60a5fa', icon: 'spark', client: 'Gemini / Antigravity 本地用量', path: '~/.gemini/antigravity' },
  { id: 'grok', name: 'Grok', cssVar: '--c-grok', fallback: '#c084fc', icon: 'grok', client: 'Grok Build 会话日志', path: '~/.grok' },
  { id: 'claude', name: 'Claude Code', cssVar: '--c-claude', fallback: '#fbbf24', icon: 'sun', client: 'Claude Code 项目日志', path: '~/.claude/projects' },
  { id: 'gemini-cli', name: 'Gemini CLI', cssVar: '--c-gemini-cli', fallback: '#818cf8', icon: 'code', client: 'Gemini CLI 历史会话', path: '~/.gemini/tmp' },
  { id: 'cline', name: 'Cline', cssVar: '--c-cline', fallback: '#f472b6', icon: 'database', client: 'Cline 会话与编辑器任务用量', path: '~/.cline/data/sessions' },
  { id: 'roo', name: 'Roo Code', cssVar: '--c-roo', fallback: '#fb923c', icon: 'database', client: '编辑器扩展的 Roo Code 任务用量', path: 'User/globalStorage/rooveterinaryinc.roo-cline/tasks' },
  { id: 'other', name: '其他', cssVar: '--c-other', fallback: '#94a3b8', icon: 'database' },
];

const ioSeriesMeta = [
  { id: 'input', name: '输入 Token', cssVar: '--c-input', fallback: '#38bdf8' },
  { id: 'output', name: '输出 Token', cssVar: '--c-output', fallback: '#34d399' },
];

const importOptions = [
  { id: 'auto', name: '自动识别', icon: 'spark' },
  ...providers,
];

const providerById = new Map(providers.map((provider) => [provider.id, provider]));
const priceFields = ['input', 'cached', 'cacheWrite', 'output', 'reasoning'];
const pageNames = { overview: '总览', daily: '每日', sources: '来源', import: '导入' };
const pageOrder = ['overview', 'daily', 'sources', 'import'];
const statusLabels = { connected: '已连接', missing: '未检测到', error: '读取失败', unsupported: '可手动导入', loading: '扫描中' };

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

const state = {
  snapshot: null,
  live: false,
  demo: false,
  theme: 'dark',
  page: 'overview',
  range: '30',
  chartStyle: 'area',
  trendMode: 'provider',
  trendPage: 0,
  day: today(),
  historyPage: 0,
  expanded: new Set(),
  hiddenTools: new Set(),
  hiddenIo: new Set(),
  drafts: new Map(),
  importProvider: 'auto',
  tableQuery: '',
  busy: false,
  error: '',
  overviewTotal: 0,
  lastHeroValue: 0,
  overviewShares: [],
  cmdOpen: false,
  cmdIndex: 0,
  cmdItems: [],
};

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => htmlEscapes[character]);
const svgMarkup = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || ''}"/></svg>`;
const icon = (name) => `<span data-icon="${name}">${svgMarkup(name)}</span>`;
const emptyStats = () => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0, count: 0, withoutReasoning: 0,
  estimatedCost: null, reportedCostUsd: null, pricedTokens: 0 });
const tableEmpty = (message, columns) => `<tr><td colspan="${columns}" class="empty-table">${message}</td></tr>`;
const isLoading = () => state.busy && !state.snapshot && !state.demo;
const isReviewRoute = (provider, model) => provider === 'codex' && model === 'codex-auto-review';

const drawSparkline = createSparkline(byId('hero-sparkline'));
const trendChart = createTrend(byId('trend-canvas'), byId('chart-tooltip'), { compact, full, onDate: openDay });
const donutChart = createDonut(byId('donut-canvas'), { onHover: handleDonutHover });

// Silky Sliding Glider Engine
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
    glider.style.opacity = '0';
    return;
  }
  if (instant) glider.classList.add('no-transition');
  else glider.classList.remove('no-transition');
  glider.style.opacity = '1';
  glider.style.width = `${active.offsetWidth}px`;
  glider.style.transform = `translateX(${active.offsetLeft}px)`;
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
}

// Smooth Hero Number Counter
let heroRaf = 0;
function animateHeroTotal(targetValue) {
  const el = byId('hero-total');
  if (!el) return;
  if (isLoading()) {
    el.innerHTML = '<span class="skeleton" aria-hidden="true"></span>';
    return;
  }
  el.title = full(targetValue);
  cancelAnimationFrame(heroRaf);
  const from = state.lastHeroValue;
  state.lastHeroValue = targetValue;
  if (reducedMotion() || from === targetValue) {
    el.textContent = compact(targetValue);
    return;
  }
  const start = performance.now();
  const duration = 360;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = compact(Math.round(from + (targetValue - from) * eased));
    if (t < 1) heroRaf = requestAnimationFrame(tick);
    else el.textContent = compact(targetValue);
  };
  heroRaf = requestAnimationFrame(tick);
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
    el.style.width = `${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))}%`;
  }
  for (const el of get('[data-bar-h]')) {
    const pct = Number(el.dataset.barH);
    el.style.height = `${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))}%`;
  }
  for (const el of get('[data-ring-pct]')) {
    const r = 18;
    const circ = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(1, Number(el.dataset.ringPct) || 0));
    el.style.strokeDasharray = `${circ.toFixed(2)}`;
    el.style.strokeDashoffset = `${(circ * (1 - pct)).toFixed(2)}`;
  }
}

function today() {
  return formatDay(new Date());
}

function dateMillis(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function offsetDay(date, offset) {
  return new Date(dateMillis(date) + offset * oneDay).toISOString().slice(0, 10);
}

function weekdayLabel(date) {
  return weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function relativeDayTag(date) {
  const now = today();
  if (date === now) return { label: '今天', isToday: true };
  if (date === offsetDay(now, -1)) return { label: '昨天', isToday: false };
  return { label: weekdayLabel(date), isToday: false };
}

function displayDate(date) {
  return fullDate.format(dateMillis(date));
}

function initTheme() {
  let saved = 'dark';
  try {
    const stored = localStorage.getItem('tokenstat-theme');
    if (stored === 'light' || stored === 'dark') saved = stored;
  } catch { /* ignore */ }
  applyTheme(saved, false);
}

function applyTheme(theme, persist = true) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f3f5fa' : '#040508';
  const themeIcon = byId('theme-icon');
  if (themeIcon) {
    themeIcon.dataset.icon = theme === 'dark' ? 'sun' : 'moon';
    themeIcon.innerHTML = svgMarkup(theme === 'dark' ? 'sun' : 'moon');
  }
  if (persist) {
    try { localStorage.setItem('tokenstat-theme', theme); } catch { /* ignore */ }
  }
  if (state.page === 'overview') renderOverview();
}

function rows() {
  return state.demo ? demoUsage(today(), offsetDay) : state.snapshot?.entries ?? [];
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
  if (entry.estimatedCost != null) sum.estimatedCost = (sum.estimatedCost ?? 0) + entry.estimatedCost;
  if (entry.reportedCostUsd != null) sum.reportedCostUsd = (sum.reportedCostUsd ?? 0) + entry.reportedCostUsd;
}
function sourceLabel(source) {
  return source === 'import' ? '文件导入' : source;
}

function sourceChip(source, provider) {
  if (!source) return '—';
  const style = source === '文件导入' || source === '示例数据' ? '' : ' connected';
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
  const label = change === 0 ? '持平' : `${change > 0 ? '+' : '-'}${percent.format(Math.abs(change))}`;
  return `<span class="delta-badge${cls}">${label}</span>`;
}

function renderHeroGauges(current, activeDays, totalDays) {
  const loading = isLoading();
  const cacheRate = current.input > 0 ? Math.min(1, current.cached / current.input) : 0;
  const outputRate = current.total > 0 ? Math.min(1, current.output / current.total) : 0;
  const activeRate = totalDays > 0 ? Math.min(1, activeDays / totalDays) : 0;

  const gauges = [
    { key: 'cache', label: '缓存命中', ratio: cacheRate, sub: loading ? '—' : compact(current.cached) },
    { key: 'output', label: '输出占比', ratio: outputRate, sub: loading ? '—' : compact(current.output) },
    { key: 'active', label: '活跃天数', ratio: activeRate, sub: loading ? '—' : `${activeDays}/${totalDays} 天` },
  ];

  byId('hero-gauges').innerHTML = gauges.map((g) => `
    <div class="gauge-item" data-gauge="${g.key}">
      <div class="gauge-ring">
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <circle class="gauge-track" cx="22" cy="22" r="18"></circle>
          <circle class="gauge-arc" cx="22" cy="22" r="18" data-ring-pct="${loading ? 0 : g.ratio.toFixed(4)}"></circle>
        </svg>
        <span class="gauge-center">${loading ? '—' : `${Math.round(g.ratio * 100)}%`}</span>
      </div>
      <div class="gauge-meta">
        <span>${g.label}</span>
        <strong>${g.sub}</strong>
      </div>
    </div>
  `).join('');
}

function renderOverviewTelemetry(current, previous, days, entries) {
  const loading = isLoading();
  animateHeroTotal(current.total);

  // Peak day badge
  const byDay = new Map();
  for (const e of entries) byDay.set(e.date, (byDay.get(e.date) || 0) + e.total);
  let peakDay = '';
  let peakVal = 0;
  for (const [d, v] of byDay) {
    if (v > peakVal) { peakVal = v; peakDay = d; }
  }
  const peakEl = byId('hero-peak-tag');
  if (!loading && peakVal > 0) {
    peakEl.textContent = `峰值 ${peakDay.slice(5)} · ${compact(peakVal)}`;
    peakEl.hidden = false;
  } else {
    peakEl.hidden = true;
  }

  const subParts = [];
  if (!loading) {
    if (previous && previous.total > 0) {
      subParts.push(`${deltaBadgeHtml(current.total, previous.total)}<span>较上一周期</span>`);
    }
    if (days > 1) {
      subParts.push(`<span>日均 <strong>${compact(Math.round(current.total / days))}</strong></span>`);
    }
    if (current.count > 0) {
      subParts.push(`<span>${full(current.count)} 条记录</span>`);
    }
  } else {
    subParts.push('<span>正在扫描本地日志…</span>');
  }
  byId('hero-subline').innerHTML = subParts.join('<span aria-hidden="true">·</span>');

  renderHeroGauges(current, byDay.size, days);

  const reasoningKnown = current.count === 0 || current.withoutReasoning < current.count;
  const items = [
    {
      key: 'input',
      label: '输入 Token',
      value: current.input,
      prev: previous?.input,
      ratio: current.total > 0 ? current.input / current.total : 0,
      badge: current.total > 0 ? `占 ${percent.format(current.input / current.total)}` : '',
      foot: 'Prompt 上下文',
    },
    {
      key: 'output',
      label: '输出 Token',
      value: current.output,
      prev: previous?.output,
      ratio: current.total > 0 ? current.output / current.total : 0,
      badge: current.total > 0 ? `占 ${percent.format(current.output / current.total)}` : '',
      foot: '模型生成回复',
    },
    {
      key: 'cached',
      label: '缓存命中',
      value: current.cached,
      prev: previous?.cached,
      ratio: current.input > 0 ? Math.min(1, current.cached / current.input) : 0,
      badge: current.input > 0 ? `命中 ${percent.format(Math.min(1, current.cached / current.input))}` : '',
      foot: '复用上下文缓存',
    },
    {
      key: 'reasoning',
      label: '推理 Token',
      value: current.reasoning,
      prev: previous?.reasoning,
      ratio: current.output > 0 ? Math.min(1, current.reasoning / current.output) : 0,
      badge: reasoningKnown && current.output > 0 ? `占输出 ${percent.format(Math.min(1, current.reasoning / current.output))}` : '',
      foot: reasoningKnown ? '深度思考消耗' : '部分日志未单独记录',
      unknown: !reasoningKnown,
    },
  ];

  byId('overview-metrics').innerHTML = items.map((item) => {
    const delta = !loading && !item.unknown ? deltaBadgeHtml(item.value, item.prev) : '';
    const pct = loading || item.unknown ? 0 : (item.ratio * 100).toFixed(1);
    const valStr = loading ? '<span class="skeleton"></span>' : item.unknown ? '—' : compact(item.value);
    return `<div class="tele-cell" data-accent="${item.key}">
      <div class="tele-head">
        <span class="tele-label">${item.label}</span>
        ${!loading && item.badge ? `<span class="tele-badge">${item.badge}</span>` : ''}
      </div>
      <strong class="tele-value" title="${loading || item.unknown ? '' : full(item.value)}">${valStr}</strong>
      <div class="tele-foot">${delta ? `${delta}<span>较上期</span>` : `<span>${item.foot}</span>`}</div>
      <div class="tele-bar"><div class="tele-bar-fill" data-bar-pct="${pct}"></div></div>
    </div>`;
  }).join('');
}

function renderDailyTelemetry(sum) {
  const loading = isLoading();
  const items = [
    { key: 'total', label: '当日总计', value: sum.total, ratio: sum.total > 0 ? 1 : 0, badge: `${full(sum.count)} 条记录` },
    { key: 'input', label: '输入 Token', value: sum.input, ratio: sum.total > 0 ? sum.input / sum.total : 0, badge: sum.total > 0 ? percent.format(sum.input / sum.total) : '' },
    { key: 'output', label: '输出 Token', value: sum.output, ratio: sum.total > 0 ? sum.output / sum.total : 0, badge: sum.total > 0 ? percent.format(sum.output / sum.total) : '' },
    { key: 'cached', label: '缓存命中', value: sum.cached, ratio: sum.input > 0 ? Math.min(1, sum.cached / sum.input) : 0, badge: sum.input > 0 ? `命中 ${percent.format(Math.min(1, sum.cached / sum.input))}` : '' },
  ];

  byId('daily-metrics').innerHTML = items.map((item) => `
    <div class="tele-cell" data-accent="${item.key}">
      <div class="tele-head">
        <span class="tele-label">${item.label}</span>
        ${!loading && item.badge ? `<span class="tele-badge">${item.badge}</span>` : ''}
      </div>
      <strong class="tele-value" title="${loading ? '' : full(item.value)}">${loading ? '<span class="skeleton"></span>' : full(item.value)}</strong>
      <div class="tele-bar"><div class="tele-bar-fill" data-bar-pct="${loading ? 0 : (item.ratio * 100).toFixed(1)}"></div></div>
    </div>
  `).join('');
}

function period(entries) {
  const end = today();
  if (state.range === 'all') {
    const dates = entries.map((entry) => entry.date).sort();
    const start = dates[0] && dates[0] < offsetDay(end, -6) ? dates[0] : offsetDay(end, -6);
    const maxEnd = dates.at(-1) > end ? dates.at(-1) : end;
    const days = Math.max(1, Math.round((dateMillis(maxEnd) - dateMillis(start)) / oneDay) + 1);
    return { start, end: maxEnd, days, entries };
  }
  const days = Number(state.range);
  const start = offsetDay(end, 1 - days);
  const prev = offsetDay(start, -days);
  return {
    start, end, days,
    entries: entries.filter((entry) => entry.date >= start && entry.date <= end),
    previous: totals(entries.filter((entry) => entry.date >= prev && entry.date < start)),
  };
}

function trendData(start, end, entries, mode) {
  const days = Math.round((dateMillis(end) - dateMillis(start)) / oneDay) + 1;
  const pages = Math.ceil(days / trendPageSize);
  state.trendPage = Math.min(state.trendPage, pages - 1);
  const last = offsetDay(end, -state.trendPage * trendPageSize);
  const count = Math.min(trendPageSize, days - state.trendPage * trendPageSize);
  const first = offsetDay(last, 1 - count);
  const buckets = Array.from({ length: count }, (_, index) => ({
    date: offsetDay(first, index),
    values: {},
    total: 0,
  }));

  for (const entry of entries) {
    const index = Math.round((dateMillis(entry.date) - dateMillis(first)) / oneDay);
    const bucket = buckets[index];
    if (!bucket) continue;
    if (mode === 'io') {
      if (!state.hiddenIo.has('input')) {
        bucket.values.input = (bucket.values.input || 0) + entry.input;
        bucket.total += entry.input;
      }
      if (!state.hiddenIo.has('output')) {
        bucket.values.output = (bucket.values.output || 0) + entry.output;
        bucket.total += entry.output;
      }
    } else {
      bucket.total += entry.total;
      bucket.values[entry.provider] = (bucket.values[entry.provider] || 0) + entry.total;
    }
  }
  return { buckets, first, last, pages };
}

function renderModelLeaderboard(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = `${entry.provider}::${entry.model ?? '未记录'}`;
    const cur = map.get(key) || { provider: entry.provider, model: entry.model ?? '模型未记录', total: 0 };
    cur.total += entry.total;
    map.set(key, cur);
  }
  const ranked = [...map.values()].filter((m) => m.total > 0).sort((a, b) => b.total - a.total);
  byId('model-count-pill').textContent = `${ranked.length} 模型`;

  const container = byId('model-leaderboard');
  if (isLoading()) {
    container.innerHTML = '<div class="lb-empty">正在读取模型数据…</div>';
    return;
  }
  if (!ranked.length) {
    container.innerHTML = '<div class="lb-empty">当前周期暂无模型消耗记录</div>';
    return;
  }

  const top = ranked.slice(0, 6);
  const maxVal = top[0].total || 1;
  container.innerHTML = top.map((item, idx) => {
    const pct = ((item.total / maxVal) * 100).toFixed(1);
    return `<div class="lb-row" data-provider="${item.provider}">
      <span class="lb-rank">${idx + 1}</span>
      <span class="lb-model" title="${escapeHtml(item.model)}"><i class="series-dot"></i><span>${escapeHtml(item.model)}</span></span>
      <strong class="lb-val" title="${full(item.total)}">${compact(item.total)}</strong>
      <div class="lb-bar-track"><div class="lb-bar-fill" data-provider="${item.provider}" data-bar-pct="${pct}"></div></div>
    </div>`;
  }).join('');
}

function renderWeekdayRhythm(entries) {
  const byDay = new Map();
  for (const e of entries) byDay.set(e.date, (byDay.get(e.date) || 0) + e.total);

  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  for (const [date, val] of byDay) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    sums[dow] += val;
    counts[dow] += 1;
  }
  const avgs = sums.map((s, i) => counts[i] ? Math.round(s / counts[i]) : 0);
  const maxAvg = Math.max(...avgs, 1);
  let peakDow = -1;
  let peakVal = 0;
  for (const dow of rhythmOrder) {
    if (avgs[dow] > peakVal) { peakVal = avgs[dow]; peakDow = dow; }
  }

  byId('rhythm-bars').innerHTML = rhythmOrder.map((dow) => {
    const val = avgs[dow];
    const hPct = isLoading() ? 0 : Math.max(val > 0 ? 8 : 0, (val / maxAvg) * 100).toFixed(1);
    const isPeak = !isLoading() && dow === peakDow && peakVal > 0;
    return `<div class="rhythm-col${isPeak ? ' is-peak' : ''}" title="${weekdays[dow]}日均 ${full(val)}">
      <span class="rhythm-val">${isLoading() || !val ? '·' : compact(val)}</span>
      <div class="rhythm-track"><div class="rhythm-fill" data-bar-h="${hPct}"></div></div>
      <span class="rhythm-day">${weekdays[dow].slice(1)}</span>
    </div>`;
  }).join('');

  byId('rhythm-peak').textContent = isLoading()
    ? '计算中…'
    : peakVal > 0 ? `最高峰 · ${weekdays[peakDow]} (${compact(peakVal)}/天)` : '暂无节律数据';
}

function renderHeatmap(allEntries) {
  const grid = byId('heatmap-grid');
  if (!grid) return;
  const now = today();
  const totalCells = 24 * 7; // 24 weeks
  const start = offsetDay(now, 1 - totalCells);

  const byDay = new Map();
  for (const entry of allEntries) {
    if (entry.date >= start && entry.date <= now) {
      byDay.set(entry.date, (byDay.get(entry.date) || 0) + entry.total);
    }
  }

  const nonZero = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * p))] : 0;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);

  const levelOf = (val) => {
    if (!val) return 0;
    if (val <= t1) return 1;
    if (val <= t2) return 2;
    if (val <= t3) return 3;
    return 4;
  };

  let activeCount = 0;
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const date = offsetDay(start, i);
    const val = byDay.get(date) || 0;
    if (val > 0) activeCount++;
    const lvl = isLoading() ? 0 : levelOf(val);
    const cls = `hm-cell hm-${lvl}${date === now ? ' is-today' : ''}`;
    cells.push(`<button type="button" class="${cls}" data-hm-date="${date}" data-hm-val="${val}" aria-label="${date} ${full(val)} Tokens"></button>`);
  }
  grid.innerHTML = cells.join('');
  byId('heatmap-summary').textContent = isLoading()
    ? '正在计算活跃度…'
    : `近 24 周累计活跃 ${activeCount} / ${totalCells} 天`;
  byId('heatmap-hover').textContent = '悬停方格查看当日用量';
}

function groupByModel(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const row = groups.get(entry.model) || { model: entry.model, sources: new Set(), ...emptyStats() };
    addUsage(row, entry);
    row.sources.add(sourceLabel(entry.source));
    groups.set(entry.model, row);
  }
  return [...groups.values()].sort((a, b) => Number(a.model === null) - Number(b.model === null) || b.total - a.total);
}

function tableNumbers(row, includeDetails = false) {
  const columns = includeDetails ? fields : ['input', 'output', 'total'];
  return columns.map((field) => {
    if (field === 'reasoning' && row.withoutReasoning > 0) {
      const value = row.withoutReasoning === row.count ? '—' : full(row[field]);
      return `<td class="numeric" title="部分日志未提供独立推理 Token">${value}</td>`;
    }
    return `<td class="numeric${field === 'total' ? ' total' : ''}">${full(row[field])}</td>`;
  }).join('');
}

function shareCell(value, grandTotal, providerId) {
  const ratio = grandTotal > 0 ? value / grandTotal : 0;
  const pct = (ratio * 100).toFixed(1);
  return `<td class="share-cell"><div class="share-wrap"><div class="share-track"><div class="share-fill" data-provider="${providerId}" data-bar-pct="${pct}"></div></div><span class="share-pct">${percent.format(ratio)}</span></div></td>`;
}

function costCell(row) {
  const estimated = row.estimatedCost == null ? '—' : usd.format(row.estimatedCost);
  const coverage = row.estimatedCost != null && row.pricedTokens < row.total
    ? `<small>覆盖 ${percent.format(row.pricedTokens / row.total)}</small>` : '';
  const reported = row.reportedCostUsd == null ? '' : `<small>日志记录 ${usd.format(row.reportedCostUsd)}</small>`;
  return `<td class="numeric price-cell">${estimated}${coverage}${reported}</td>`;
}

function providerRows(tools, entries, isDaily, query = '') {
  const colSpan = 7;
  if (isLoading() || (isDaily && !entries.length)) {
    return tableEmpty(isLoading() ? '正在读取本地用量…' : '这一天没有用量记录。', colSpan);
  }
  const q = query.trim().toLowerCase();
  const grandTotal = totals(entries).total;
  const rendered = tools.map((provider) => {
    const providerEntries = entries.filter((entry) => entry.provider === provider.id);
    const sum = totals(providerEntries);
    const allModels = groupByModel(providerEntries);
    const providerMatches = !q || provider.name.toLowerCase().includes(q) || provider.id.includes(q);
    const matchedModels = q ? allModels.filter((m) => (m.model ?? '模型未记录').toLowerCase().includes(q)) : allModels;
    if (q && !providerMatches && !matchedModels.length) return '';

    const modelsToShow = providerMatches ? allModels : matchedModels;
    const sources = [...new Set(providerEntries.map((entry) => sourceLabel(entry.source)))];
    const expanded = isDaily || Boolean(q && matchedModels.length) || state.expanded.has(provider.id);
    const source = sources.length > 1 ? '多种来源' : sources[0];
    const hasModels = modelsToShow.length > 0;
    const toggle = isDaily ? '' : `<td class="row-end">${hasModels
      ? `<button class="row-expand" type="button" data-expand="${provider.id}" aria-label="${provider.name} 模型用量" aria-expanded="${expanded}">${icon('chevron-right')}</button>`
      : ''}</td>`;
    const rowClass = !isDaily && hasModels ? ' class="provider-row expandable"' : ' class="provider-row"';
    const rowData = !isDaily && hasModels ? ` data-row-expand="${provider.id}"` : '';

    const providerRow = `<tr${rowClass}${rowData}>
      <td>${providerName(provider, !isDaily ? modelsToShow.length : 0)}</td>
      ${isDaily ? '' : `<td>${sourceChip(source, provider.id)}</td>`}
      ${tableNumbers(sum, isDaily)}
      ${isDaily ? costCell(sum) : shareCell(sum.total, grandTotal, provider.id)}
      ${toggle}
    </tr>`;

    if (!expanded) return providerRow;
    return providerRow + modelsToShow.map((model) => {
      const name = escapeHtml(model.model ?? '模型未记录');
      const route = isReviewRoute(provider.id, model.model) ? '<span class="model-route-label">审核路由</span>' : '';
      const modelSource = model.sources.size > 1 ? '多种来源' : [...model.sources][0];
      return `<tr class="model-row${model.model === null ? ' unassigned-model' : ''}">
        <td title="${name}">${name}${route}</td>
        ${isDaily ? '' : `<td>${escapeHtml(modelSource)}</td>`}
        ${tableNumbers(model, isDaily)}
        ${isDaily ? costCell(model) : shareCell(model.total, grandTotal, provider.id)}
        ${isDaily ? '' : '<td></td>'}
      </tr>`;
    }).join('');
  }).filter(Boolean).join('');

  return rendered || tableEmpty(`没有匹配「${escapeHtml(query)}」的工具或模型。`, colSpan);
}

function handleDonutHover(part) {
  const totalEl = byId('donut-total');
  const subEl = byId('donut-sub');
  if (!totalEl || !subEl) return;

  for (const row of get('#distribution .distribution-row')) {
    row.classList.toggle('active', Boolean(part && row.dataset.provider === part.id));
  }

  if (part && state.overviewTotal > 0) {
    totalEl.textContent = compact(part.total);
    subEl.textContent = `${part.name} · ${percent.format(part.total / state.overviewTotal)}`;
  } else {
    totalEl.textContent = isLoading() ? '—' : compact(state.overviewTotal);
    subEl.textContent = '总 Token';
  }
}

function renderOverview() {
  const all = rows();
  const tools = toolList(all);
  const { start, end, days, entries, previous } = period(all);
  const current = totals(entries);
  state.overviewTotal = current.total;

  byId('overview-caption').textContent = `${displayDate(start)} — ${displayDate(end)} · ${days} 天`;
  renderOverviewTelemetry(current, previous, days, entries);

  const isIo = state.trendMode === 'io';
  const ioSeries = ioSeriesMeta.map((item) => ({ ...item, color: getColorVar(item.cssVar, item.fallback) }));
  const legendItems = isIo ? ioSeries : tools;
  const hiddenSet = isIo ? state.hiddenIo : state.hiddenTools;
  const visibleSeries = legendItems.filter((item) => !hiddenSet.has(item.id));
  const trendEntries = isIo ? entries : entries.filter((entry) => !state.hiddenTools.has(entry.provider));

  const { buckets, first, last, pages } = trendData(start, end, trendEntries, state.trendMode);
  drawSparkline(buckets.slice(-30).map((b) => b.total));

  byId('trend-caption').textContent = pages > 1
    ? `${first} 至 ${last} · ${isIo ? '每日输入与输出' : '每日工具消耗'}`
    : (isIo ? '按输入与输出对比每日 Token 消耗' : '按工具统计每日 Token 消耗');
  byId('trend-navigation').hidden = pages <= 1;
  byId('trend-older').disabled = state.trendPage >= pages - 1;
  byId('trend-newer').disabled = state.trendPage === 0;

  byId('chart-legend').innerHTML = legendItems.map((item) =>
    `<button type="button" data-provider="${item.id}" aria-pressed="${!hiddenSet.has(item.id)}"><i class="series-dot"></i>${item.name}</button>`
  ).join('');

  get('#chart-style-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.style === state.chartStyle));
  get('#trend-mode-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.mode === state.trendMode));
  get('#range-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.range === state.range));

  const hasData = buckets.some((bucket) => bucket.total > 0);
  const avgEl = byId('trend-avg');
  if (hasData && buckets.length > 0) {
    const avgVal = Math.round(buckets.reduce((s, b) => s + b.total, 0) / buckets.length);
    avgEl.textContent = `日均 ${compact(avgVal)}`;
    avgEl.hidden = false;
  } else {
    avgEl.hidden = true;
  }

  trendChart.update(buckets, visibleSeries, state.chartStyle);
  byId('chart-empty').hidden = hasData;
  byId('chart-empty-title').textContent = isLoading() ? '正在扫描本地日志' : visibleSeries.length ? '该周期暂无用量记录' : '请至少选择一个系列';
  byId('chart-empty-detail').textContent = isLoading() ? '首次扫描较大日志可能需要几秒' : visibleSeries.length ? '可切换周期、开启示例数据或在来源中配置日志' : '';
  byId('trend-update').textContent = state.demo ? '当前正在预览示例数据' : state.snapshot?.syncedAt
    ? `最近同步 ${clockTime.format(new Date(state.snapshot.syncedAt))}` : '等待本地同步';

  const shares = tools.map((provider) => ({
    ...provider,
    total: totals(entries.filter((entry) => entry.provider === provider.id)).total,
  }));
  state.overviewShares = shares;
  donutChart.update(shares);
  byId('donut-total').textContent = isLoading() ? '—' : compact(current.total);
  byId('donut-sub').textContent = '总 Token';

  byId('distribution').innerHTML = shares.map((provider) => {
    const ratio = current.total ? provider.total / current.total : 0;
    const pctNum = (ratio * 100).toFixed(1);
    return `<div class="distribution-row" data-provider="${provider.id}">
      <span class="dist-name"><i class="series-dot"></i>${provider.name}</span>
      <span class="dist-meta">
        <span class="dist-tokens">${isLoading() ? '' : compact(provider.total)}</span>
        <strong class="dist-pct">${isLoading() ? '—' : percent.format(ratio)}</strong>
      </span>
      <div class="dist-track"><div class="dist-fill" data-provider="${provider.id}" data-bar-pct="${isLoading() ? 0 : pctNum}"></div></div>
    </div>`;
  }).join('');

  renderModelLeaderboard(entries);
  renderWeekdayRhythm(entries);
  renderHeatmap(all);

  byId('provider-table').innerHTML = providerRows(tools, entries, false, state.tableQuery);
  const expandableIds = tools.filter((t) => entries.some((e) => e.provider === t.id)).map((t) => t.id);
  const allExpanded = expandableIds.length > 0 && expandableIds.every((id) => state.expanded.has(id));
  const expandAllBtn = byId('toggle-expand-all');
  if (expandAllBtn) {
    expandAllBtn.hidden = expandableIds.length === 0;
    expandAllBtn.textContent = allExpanded ? '收起全部' : '展开全部';
  }
  get('[data-export="overview"]')[0].disabled = !entries.length;
  applyDynamicStyles();
  requestAnimationFrame(() => syncAllGliders());
}

function dateBounds(entries) {
  let max = today();
  let min = offsetDay(max, -29);
  for (const entry of entries) {
    if (entry.date > max) max = entry.date;
    if (entry.date < min) min = entry.date;
  }
  return { min, max };
}

function renderDaily() {
  const entries = rows();
  const tools = toolList(entries);
  const { min, max } = dateBounds(entries);
  const day = state.day;
  const matching = entries.filter((entry) => entry.date === day);
  const sum = totals(matching);
  const exactModels = new Set(matching.filter(({ provider, model }) => model !== null && !isReviewRoute(provider, model))
    .map(({ provider, model }) => JSON.stringify([provider, model])));
  const unattributed = totals(matching.filter((entry) => entry.model === null)).total;
  const reviewUsage = totals(matching.filter(({ provider, model }) => isReviewRoute(provider, model))).total;
  const periodLength = Math.max(1, Math.ceil((dateMillis(max) - dateMillis(min) + oneDay) / (7 * oneDay)));
  state.historyPage = Math.min(state.historyPage, periodLength - 1);

  const picker = byId('day-picker');
  picker.value = day;
  picker.max = max;
  byId('day-next').disabled = day >= max;
  byId('today-button').disabled = day === today();

  const tag = relativeDayTag(day);
  byId('daily-caption').textContent = `${day.slice(0, 4)} · ${tag.label} · ${timeZone}`;
  byId('daily-heading').textContent = `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;

  const summary = [
    `${new Set(matching.map((entry) => entry.provider)).size} 个工具`,
    `${exactModels.size} 个模型`,
    reviewUsage ? `${full(reviewUsage)} Token 审核路由` : '',
    unattributed ? `${full(unattributed)} Token 模型未记录` : '',
  ];
  byId('daily-summary-caption').textContent = isLoading() ? '正在读取本地用量…' : summary.filter(Boolean).join(' · ');

  renderDailyTelemetry(sum);

  const compWrap = byId('daily-composition');
  const activeParts = tools
    .map((p) => ({ ...p, total: totals(matching.filter((e) => e.provider === p.id)).total }))
    .filter((p) => p.total > 0);

  if (sum.total > 0 && activeParts.length > 0 && !isLoading()) {
    compWrap.hidden = false;
    byId('daily-composition-bar').innerHTML = activeParts.map((p) =>
      `<span class="comp-seg" data-provider="${p.id}" data-bar-pct="${((p.total / sum.total) * 100).toFixed(2)}" title="${p.name}: ${full(p.total)}"></span>`
    ).join('');
    byId('daily-composition-legend').innerHTML = activeParts.map((p) =>
      `<span class="comp-legend-item" data-provider="${p.id}"><i class="series-dot"></i><span>${p.name}</span><strong>${percent.format(p.total / sum.total)}</strong></span>`
    ).join('');
  } else {
    compWrap.hidden = true;
  }

  byId('daily-table').innerHTML = providerRows(tools, matching, true);
  get('[data-export="daily"]')[0].disabled = !matching.length;

  byId('history-head').innerHTML = `<tr><th scope="col">日期</th>${tools.map((provider) => `<th scope="col" class="num-col">${provider.name}</th>`).join('')}<th scope="col" class="num-col">总 Token</th></tr>`;
  byId('history-page').textContent = `${state.historyPage + 1} / ${periodLength}`;
  byId('history-newer').disabled = state.historyPage === 0;
  byId('history-older').disabled = state.historyPage + 1 >= periodLength;

  const dateValues = new Map();
  for (const entry of entries) {
    if (!dateValues.has(entry.date)) dateValues.set(entry.date, {});
    const values = dateValues.get(entry.date);
    values[entry.provider] = (values[entry.provider] || 0) + entry.total;
  }
  const days = Array.from({ length: 7 }, (_, index) => offsetDay(max, -7 * state.historyPage - index)).filter((date) => date >= min);
  const dayTotals = days.map((date) => {
    const counts = dateValues.get(date) || {};
    return tools.reduce((acc, p) => acc + (counts[p.id] || 0), 0);
  });
  const maxDayTotal = Math.max(...dayTotals, 1);

  byId('history-table').innerHTML = days.map((date, idx) => {
    const counts = dateValues.get(date) || {};
    const values = tools.map((provider) => counts[provider.id] || 0);
    const rowTotal = dayTotals[idx];
    const barPct = isLoading() ? 0 : ((rowTotal / maxDayTotal) * 100).toFixed(1);
    const dayTag = relativeDayTag(date);
    return `<tr${date === day ? ' class="selected"' : ''} data-date-row="${date}">
      <td><span class="history-date-cell"><button class="history-date" data-date="${date}" type="button" aria-pressed="${date === day}">${date}</button><span class="day-tag${dayTag.isToday ? ' is-today' : ''}">${dayTag.label}</span></span></td>
      ${values.map((value) => `<td class="numeric">${isLoading() ? '—' : full(value)}</td>`).join('')}
      <td class="numeric total"><span class="history-total-wrap"><span class="history-bar-track" aria-hidden="true"><span class="history-bar-fill" data-bar-pct="${barPct}"></span></span><span>${isLoading() ? '—' : full(rowTotal)}</span></span></td>
    </tr>`;
  }).join('');

  applyDynamicStyles();
  renderDayInsights();
}

function renderSources() {
  const realEntries = state.snapshot?.entries ?? [];
  byId('source-grid').innerHTML = providers.filter((provider) => provider.path).map((provider) => {
    const source = state.snapshot?.sources.find((candidate) => candidate.provider === provider.id);
    const status = source?.status || (state.busy ? 'loading' : 'missing');
    const savedPath = state.snapshot?.paths[provider.id] ?? '';
    const path = state.drafts.get(provider.id) ?? savedPath;
    const message = source?.message || (state.busy ? '正在检测本机日志。' : '同步后可查看检测结果。');
    const localEntries = realEntries.filter((e) => e.provider === provider.id && e.source !== 'import' && !e.source.startsWith('同步 · '));
    const totalTokens = totals(localEntries).total;
    const activeDays = new Set(localEntries.map((e) => e.date)).size;
    const hasCustomPath = Boolean(path.trim() || savedPath.trim());

    return `<article class="card source-card" data-provider="${provider.id}">
      <div class="source-head">
        <div class="source-title">
          <span class="provider-badge" data-provider="${provider.id}">${icon(provider.icon)}</span>
          <div><h2>${provider.name}</h2><p>${provider.client}</p></div>
        </div>
        <span class="chip ${status}"><i class="status-dot"></i>${statusLabels[status] || '待同步'}</span>
      </div>
      <div class="source-stats">
        <div class="source-stat"><span>已扫描 Token</span><strong>${isLoading() ? '—' : compact(totalTokens)}</strong></div>
        <div class="source-stat"><span>活跃天数</span><strong>${isLoading() ? '—' : `${activeDays} 天`}</strong></div>
      </div>
      <p class="source-status">${escapeHtml(message)}</p>
      <form data-settings="${provider.id}">
        <label class="field-label" for="path-${provider.id}">自定义路径</label>
        <input class="field-input" name="path" id="path-${provider.id}" placeholder="${escapeHtml(provider.path)}" value="${escapeHtml(path)}" maxlength="4096" spellcheck="false" autocomplete="off">
        <div class="form-actions">
          <button class="outline-btn" type="submit" ${state.busy ? 'disabled' : ''}>保存并扫描</button>
          ${hasCustomPath ? `<button class="ghost-btn" type="button" data-reset-path="${provider.id}" ${state.busy ? 'disabled' : ''}>恢复默认</button>` : ''}
        </div>
      </form>
    </article>`;
  }).join('');
}

function installDesktopPreferences() {
  const desktop = window.tokenstatDesktop;
  if (!desktop) return;
  const checkbox = byId('desktop-autostart');
  const status = byId('desktop-autostart-status');
  let enabled = false;
  let pending = false;

  function apply(value) {
    enabled = value;
    checkbox.checked = enabled;
    status.textContent = enabled ? '登录后在托盘启动' : '关闭';
  }

  async function read() {
    if (pending) return;
    try {
      const value = await desktop.getAutostart();
      if (!pending) {
        apply(value);
        checkbox.disabled = false;
      }
    } catch {
      status.textContent = '无法读取系统启动项';
    }
  }

  byId('desktop-preferences').hidden = false;
  desktop.onAutostartChanged(apply);
  window.addEventListener('focus', read);
  checkbox.addEventListener('change', async () => {
    pending = true;
    checkbox.disabled = true;
    try {
      apply(await desktop.setAutostart(checkbox.checked));
    } catch {
      checkbox.checked = enabled;
      status.textContent = '无法更新，请检查系统启动项或应用位置';
    } finally {
      checkbox.disabled = false;
      pending = false;
    }
  });
  void read();
}

const syncStates = {
  disabled: '未启用', ready: '已启用', syncing: '同步中', ok: '已同步', offline: '文件夹不可用', error: '同步异常',
};
const syncForm = byId('sync-form');
let syncInfo;
let syncBusy = false;

function showSyncInfo(info, populate = false) {
  syncInfo = info;
  byId('sync-state').textContent = !info.enabled && info.configured ? '已暂停' : syncStates[info.state] ?? '跨设备同步';
  byId('save-sync').textContent = info.enabled ? '保存并同步' : '启用并同步';
  byId('disable-sync').hidden = !info.enabled;
  byId('run-sync').hidden = !info.enabled;
  byId('reveal-sync-key').hidden = !info.configured;
  if (populate) {
    syncForm.elements.folder.value = info.folder ?? '';
    syncForm.elements.deviceName.value = info.deviceName ?? '';
    syncForm.elements.key.value = '';
  }
  const descriptors = [];
  if (info.lastSyncAt) descriptors.push(`最近检查 ${dateTime.format(new Date(info.lastSyncAt))}`);
  if (info.keyId) descriptors.push(`配对组 ${info.keyId.slice(0, 8)}`);
  if (info.lastError) descriptors.push(info.lastError);
  if (info.enabled && !info.peers.length && !info.lastError) descriptors.push('尚未接收到其他设备的用量');
  byId('sync-note').textContent = descriptors.join(' · ');
  byId('sync-peer-list').hidden = !info.peers.length;
  byId('sync-peers').innerHTML = info.peers.map((peer) => `<tr>
    <td>${escapeHtml(peer.deviceName)}</td>
    <td>${peer.syncedAt ? dateTime.format(new Date(peer.syncedAt)) : '—'}</td>
    <td class="numeric total">${full(peer.count)}</td>
  </tr>`).join('');
}

function showPairingKey(key = '') {
  byId('sync-pairing-key').value = key;
  byId('sync-pairing').hidden = !key;
}

async function readSyncInfo(populate = false) {
  if (syncBusy || state.page !== 'sources' || !byId('sync-card').open) return;
  try {
    const info = await request('sync');
    if (!syncBusy) showSyncInfo(info, populate || !syncInfo);
  } catch (error) {
    byId('sync-note').textContent = error.message;
  }
}

async function updateFolderSync(endpoint, config, populate = false) {
  if (syncBusy) return;
  syncBusy = true;
  const buttons = get('#sync-form button');
  for (const button of buttons) button.disabled = true;
  byId('sync-note').textContent = '正在处理同步…';
  try {
    const { pairingKey, ...info } = await request(endpoint, config);
    showSyncInfo(info, populate);
    if (pairingKey) showPairingKey(pairingKey);
    void refreshLive();
  } catch (error) {
    byId('sync-note').textContent = error.message;
  } finally {
    syncBusy = false;
    for (const button of buttons) button.disabled = false;
  }
}

function renderImportPills() {
  const container = byId('import-provider-pills');
  if (!container) return;
  container.innerHTML = importOptions.map((opt) =>
    `<button class="provider-pill" type="button" role="radio" data-import-opt="${opt.id}" aria-checked="${state.importProvider === opt.id}">
      <span class="btn-icon">${icon(opt.icon)}</span>
      <span>${opt.name}</span>
    </button>`
  ).join('');
  byId('import-provider').value = state.importProvider;
}

function renderImports() {
  const imports = state.snapshot?.imports ?? [];
  byId('import-table').innerHTML = imports.length ? imports.map(({ id, filename, date, added, removable }) => `<tr>
    <td class="import-file" title="${escapeHtml(filename)}">${escapeHtml(filename)}</td>
    <td>${dateTime.format(new Date(date))}</td>
    <td class="numeric total">${full(added)}</td>
    <td>${removable ? `<button type="button" class="ghost-btn record-remove" data-import-id="${escapeHtml(id)}">撤回</button>` : '<span class="insight-note">旧版记录</span>'}</td>
  </tr>`).join('') : tableEmpty('还没有导入记录。', 4);
}

function updateLiveStatus() {
  const status = byId('local-status');
  status.classList.toggle('busy', state.busy);
  status.classList.toggle('failed', Boolean(state.error));
  status.querySelector('span').textContent = state.busy ? '同步中' : state.error ? '异常' : state.live ? '实时' : '本地';
}

function render() {
  updateLiveStatus();

  byId('load-error').hidden = !state.error;
  byId('load-error-text').textContent = state.error;
  byId('demo-toggle').setAttribute('aria-pressed', state.demo);
  byId('demo-notice').hidden = !state.demo;

  for (const button of get('.sync-button')) {
    button.disabled = state.busy;
    button.classList.toggle('is-syncing', state.busy);
  }

  if (state.page === 'overview') renderOverview();
  if (state.page === 'daily') renderDaily();
  if (state.page === 'sources' && !document.activeElement?.matches('#source-grid input')) renderSources();
  if (state.page === 'import') renderImports();
  hydrateStaticIcons();
}

function navigate(scroll = true, instantGlider = false) {
  const [page, date] = location.hash.slice(1).split('/');
  state.page = Object.hasOwn(pageNames, page) ? page : 'overview';
  if (state.page === 'daily' && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateMillis(date))) {
    selectDay(date);
  }
  for (const key of Object.keys(pageNames)) byId(`page-${key}`).hidden = key !== state.page;
  for (const link of get('[data-page]')) {
    if (link.dataset.page === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${pageNames[state.page]} · TokenStat`;
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.page !== 'sources') showPairingKey();
  render();
  if (page === 'sources' && date === 'pricing') {
    byId('pricing-card').open = true;
    requestAnimationFrame(() => byId('pricing-card').scrollIntoView({ block: 'start' }));
  }
  if (page === 'sources' && date === 'sync') {
    byId('sync-card').open = true;
    requestAnimationFrame(() => byId('sync-card').scrollIntoView({ block: 'start' }));
  } else if (state.page === 'sources' && byId('sync-card').open) {
    void readSyncInfo();
  }
  requestAnimationFrame(() => syncAllGliders(instantGlider));
}

function selectDay(day) {
  state.day = day;
  const { max } = dateBounds(rows());
  const daysBack = Math.round((dateMillis(max) - dateMillis(day)) / oneDay);
  state.historyPage = Math.max(0, Math.floor(daysBack / 7));
}

function openDay(day) {
  selectDay(day);
  location.hash = `daily/${day}`;
}

function updateDay(day) {
  selectDay(day);
  history.replaceState(null, '', `#daily/${day}`);
  render();
}

/* Raycast / Linear Command Palette */
function buildCommandItems(query) {
  const q = query.trim().toLowerCase();
  const base = [
    { id: 'nav-overview', title: '前往 · 用量总览', cat: '页面', icon: 'grid', run: () => { location.hash = 'overview'; } },
    { id: 'nav-daily', title: '前往 · 每日记录', cat: '页面', icon: 'calendar', run: () => { location.hash = 'daily'; } },
    { id: 'nav-sources', title: '前往 · 数据来源', cat: '页面', icon: 'database', run: () => { location.hash = 'sources'; } },
    { id: 'nav-import', title: '前往 · 导入记录', cat: '页面', icon: 'upload', run: () => { location.hash = 'import'; } },
    { id: 'act-sync', title: '同步本地用量日志', cat: '操作', icon: 'refresh', run: () => load('refresh', {}) },
    { id: 'act-demo', title: state.demo ? '关闭示例数据，返回真实记录' : '开启示例数据预览', cat: '操作', icon: 'flask', run: () => setDemo(!state.demo) },
    { id: 'act-theme', title: state.theme === 'dark' ? '切换为浅色主题' : '切换为深色主题', cat: '外观', icon: state.theme === 'dark' ? 'sun' : 'moon', run: () => applyTheme(state.theme === 'dark' ? 'light' : 'dark') },
    { id: 'act-area', title: '趋势图切换为「面积图」', cat: '图表', icon: 'chart', run: () => { state.chartStyle = 'area'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-bar', title: '趋势图切换为「柱状图」', cat: '图表', icon: 'chart', run: () => { state.chartStyle = 'bar'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-line', title: '趋势图切换为「折线图」', cat: '图表', icon: 'chart', run: () => { state.chartStyle = 'line'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-export', title: '导出当前周期 CSV', cat: '数据', icon: 'download', run: () => exportUsage(state.page === 'daily' ? 'daily' : 'overview') },
  ];

  // Dynamic model search items
  const modelNames = [...new Set(rows().map((e) => e.model).filter(Boolean))];
  const modelItems = modelNames.map((m) => ({
    id: `model-${m}`,
    title: `筛选模型 · ${m}`,
    cat: '模型',
    icon: 'spark',
    run: () => {
      state.tableQuery = m;
      const input = byId('table-search');
      if (input) input.value = m;
      location.hash = 'overview';
      renderOverview();
      byId('provider-table')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  }));

  const all = [...base, ...modelItems];
  return q ? all.filter((item) => item.title.toLowerCase().includes(q) || item.cat.toLowerCase().includes(q)) : all.slice(0, 10);
}

function renderCommandList() {
  const query = byId('cmd-input').value;
  state.cmdItems = buildCommandItems(query);
  state.cmdIndex = Math.min(state.cmdIndex, Math.max(0, state.cmdItems.length - 1));
  const list = byId('cmd-list');
  if (!state.cmdItems.length) {
    list.innerHTML = '<div class="cmd-empty">没有匹配的命令或模型</div>';
    return;
  }
  list.innerHTML = state.cmdItems.map((item, idx) => `
    <button type="button" class="cmd-item${idx === state.cmdIndex ? ' active' : ''}" role="option" data-cmd-idx="${idx}">
      <span class="cmd-item-left">${icon(item.icon)}<span class="cmd-item-title">${escapeHtml(item.title)}</span></span>
      <span class="cmd-item-cat">${item.cat}</span>
    </button>
  `).join('');
}

function openCommandPalette() {
  state.cmdOpen = true;
  state.cmdIndex = 0;
  const modal = byId('cmd-modal');
  const input = byId('cmd-input');
  modal.hidden = false;
  input.value = '';
  renderCommandList();
  input.focus();
}

function closeCommandPalette() {
  state.cmdOpen = false;
  byId('cmd-modal').hidden = true;
}

function runCommand(idx) {
  const item = state.cmdItems[idx];
  closeCommandPalette();
  item?.run();
}

async function request(endpoint, data, { query = {}, method = data === undefined ? 'GET' : 'POST', signal } = {}) {
  const params = new URLSearchParams({ timeZone, ...query });
  const options = { method, signal };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const response = await fetch(`/api/${endpoint}?${params}`, options);
  let result;
  try { result = await response.json(); }
  catch { throw new Error('无法读取本地服务的响应。'); }
  if (!response.ok) throw new Error(result.error || '本地服务暂时不可用。');
  return result;
}

let dayRequest;
let dayDetails;

function paintDayInsights(details, unavailable = '正在读取当天明细…') {
  const hourly = details?.hourly ?? [];
  const total = hourly.reduce((sum, entry) => sum + entry.total, 0);
  const peak = Math.max(1, ...hourly.map((entry) => entry.total));
  byId('hourly-note').textContent = details
    ? [total ? `${full(total)} Token 有小时记录` : '当天暂无带时间的用量记录。',
      details.withoutTime ? `${full(details.withoutTime)} 条记录仅有日期` : ''].filter(Boolean).join(' · ')
    : unavailable;
  byId('hourly-chart').innerHTML = hourly.map(({ hour, total: tokens }) => {
    const label = String(hour).padStart(2, '0');
    return `<div class="hour-cell" title="${label}:00 · ${full(tokens)} Token">
      <span class="sr-only">${label}:00 · ${full(tokens)} Token</span>
      <i class="hour-track" aria-hidden="true"><i data-bar-h="${100 * tokens / peak}"></i></i>
      <span aria-hidden="true">${hour % 3 === 0 ? label : ''}</span>
    </div>`;
  }).join('');

  byId('estimated-cost').textContent = details?.estimatedCost == null ? '—' : usd.format(details.estimatedCost);
  byId('cache-savings').textContent = details?.cacheSavings == null ? '—' : usd.format(details.cacheSavings);
  byId('reported-cost-group').hidden = details?.reportedCostUsd == null;
  byId('reported-cost').textContent = details?.reportedCostUsd == null ? '—' : usd.format(details.reportedCostUsd);
  const coverage = details?.coverage;
  const tiered = details?.shortRequests || details?.longRequests
    ? `短上下文 ${full(details.shortRequests)} 次 · 长上下文 ${full(details.longRequests)} 次` : '';
  const unclassified = details?.unclassifiedRecords
    ? `${full(details.unclassifiedRecords)} 条记录缺少单次请求用量` : '';
  byId('pricing-coverage').textContent = !coverage ? unavailable :
    coverage.totalTokens === 0 ? '当天暂无用量。' :
      [coverage.pricedTokens ? `覆盖 ${percent.format(coverage.pricedTokens / coverage.totalTokens)} 的 Token` : '当天用量尚无可用估算',
        tiered, unclassified].filter(Boolean).join(' · ');
  const breakdown = details?.costBreakdown;
  byId('cost-breakdown').hidden = breakdown == null;
  const categories = { freshInput: '普通输入', cachedInput: '缓存读取', cacheWrite: '缓存写入', output: '其余输出', reasoning: '已记录的推理' };
  byId('cost-breakdown-values').innerHTML = breakdown ? Object.entries(categories).map(([key, label]) =>
    `<div><dt>${label}</dt><dd>${usd.format(breakdown[key])}</dd></div>`).join('') : '';

  const sessions = details?.sessions ?? [];
  byId('session-table').innerHTML = sessions.length ? sessions.map(({ provider, session, startedAt, endedAt, total: tokens }) => {
    const label = providerById.get(provider)?.name ?? provider;
    const time = startedAt && endedAt
      ? `${clockTime.format(new Date(startedAt))} – ${clockTime.format(new Date(endedAt))}`
      : '—';
    return `<tr><td>${escapeHtml(label)}</td><td><code title="${escapeHtml(session)}">${escapeHtml(session.slice(0, 12))}</code></td>
      <td>${time}</td><td class="numeric total">${full(tokens)}</td></tr>`;
  }).join('') : tableEmpty(details ? '当天暂无可识别的会话。' : unavailable, 4);
  applyDynamicStyles();
}

function renderDayInsights() {
  byId('day-insights').hidden = state.demo;
  if (state.demo || !state.snapshot) {
    dayRequest?.controller.abort();
    dayRequest = undefined;
    paintDayInsights(null);
    return;
  }
  const date = state.day;
  const key = `${state.snapshot.revision}:${date}`;
  if (dayDetails?.key === key) return;
  if (dayRequest?.key === key) return;
  dayRequest?.controller.abort();
  if (dayDetails?.date !== date) paintDayInsights(null);
  const pending = { key, controller: new AbortController() };
  dayRequest = pending;
  void request('day', undefined, { query: { date }, signal: pending.controller.signal }).then((data) => {
    if (dayRequest !== pending || state.demo || state.day !== date) return;
    dayDetails = { key, date };
    paintDayInsights(data);
  }).catch((error) => {
    if (dayRequest === pending && error.name !== 'AbortError') paintDayInsights(null, '无法读取当天明细。');
  }).finally(() => {
    if (dayRequest === pending) dayRequest = undefined;
  });
}

let pricing;
let editingPrice = false;
const priceForm = byId('price-form');

function showPrices(catalog) {
  pricing = catalog;
  byId('pricing-basis').textContent = `公开标准费率核对日期 ${catalog.pricingBasis.asOf}。自定义费率按固定单价覆盖。`;
  const renderRate = (rate, index, label) => {
    const provider = providerById.get(rate.provider)?.name;
    const actions = provider
      ? `<button class="ghost-btn record-remove" type="button" data-edit-price="${index}">编辑</button>
         <button class="ghost-btn record-remove" type="button" data-remove-price="${index}">删除</button>`
      : `<span class="quiet">${label}</span>`;
    return `<tr><td>${provider ? `${provider} · ` : ''}${escapeHtml(rate.model)}</td>
      ${priceFields.map((field) => `<td class="numeric">${rate[field] == null ? '—' : full(rate[field])}</td>`).join('')}
      <td>${actions}</td></tr>`;
  };
  const references = catalog.defaultRates.flatMap((rate) => rate.longContext ? [
    renderRate(rate, undefined, `输入 < ${full(rate.longContext.minInput)}`),
    renderRate({ model: rate.model, ...rate.longContext }, undefined, `输入 ≥ ${full(rate.longContext.minInput)}`),
  ] : [renderRate(rate, undefined, '标准费率')]);
  byId('price-table').innerHTML = [...catalog.overrides.map((rate, index) => renderRate(rate, index)), ...references].join('');
}

function loadPrices() {
  if (!byId('pricing-card').open || editingPrice) return;
  void request('pricing').then(showPrices).catch((error) => { byId('price-result').textContent = error.message; });
}

async function changePrice(endpoint, data, options) {
  if (editingPrice) return;
  editingPrice = true;
  const result = byId('price-result');
  try {
    showPrices(await request(endpoint, data, options));
    result.textContent = data ? '单价已保存。' : '单价已移除。';
    priceForm.reset();
    await refreshLive();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    editingPrice = false;
  }
}

let toastTimer;
function toast(message) {
  const target = byId('toast');
  target.innerHTML = `${icon('check')}<span>${escapeHtml(message)}</span>`;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3400);
}

async function load(endpoint = 'usage', data) {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  render();
  try {
    state.snapshot = await request(endpoint, data);
    if (endpoint === 'settings') state.drafts.delete(data.provider);
    if (endpoint !== 'usage') {
      toast(endpoint === 'settings' ? '已保存路径并完成扫描' : '本地用量已同步');
    }
  } catch (error) {
    state.error = error.message || '无法连接本地服务。';
  } finally {
    state.busy = false;
    render();
    if (liveQueued) void refreshLive();
  }
}

let liveQueued = false;
let liveFetching = false;
let liveReset = false;

async function refreshLive(reset = false) {
  liveQueued = true;
  liveReset ||= reset;
  if (state.busy || liveFetching) return;
  liveFetching = true;
  try {
    while (liveQueued && !state.busy) {
      liveQueued = false;
      const force = liveReset;
      liveReset = false;
      const snapshot = await request('usage');
      if (force || !state.snapshot || snapshot.revision >= state.snapshot.revision) {
        if (force) dayDetails = undefined;
        state.snapshot = snapshot;
        state.error = '';
        render();
      }
    }
  } catch (error) {
    if (!state.snapshot) {
      state.error = error.message;
      render();
    }
  } finally {
    liveFetching = false;
    if (liveQueued && !state.busy) void refreshLive();
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('ready', () => {
    state.live = true;
    updateLiveStatus();
    if (state.snapshot) void refreshLive(true);
  });
  events.addEventListener('usage', (event) => {
    const { revision } = JSON.parse(event.data);
    if (state.snapshot?.revision !== revision) void refreshLive();
  });
  events.addEventListener('sync', () => { void readSyncInfo(); });
  events.addEventListener('error', () => {
    state.live = false;
    updateLiveStatus();
  });
}

function setDemo(enabled) {
  state.demo = enabled;
  render();
}

function csvCell(value) {
  let cell = String(value ?? '');
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

function download(name, lines) {
  const content = '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

const csvHeader = ['date', 'provider', 'model', 'input', 'output', 'cached', 'reasoning', 'total'];
function exportUsage(page) {
  const data = page === 'daily' ? rows().filter((entry) => entry.date === state.day) : period(rows()).entries;
  if (!data.length) return;
  const label = state.demo ? 'demo' : page === 'daily' ? state.day : state.range;
  const lines = data.map((entry) => [...csvHeader.map((property) =>
    property === 'reasoning' && entry.withoutReasoning === entry.count ? '' : entry[property]), entry.cacheWrite ?? 0]);
  download(`tokenstat-${label}.csv`, [[...csvHeader, 'cache_write'], ...lines]);
  toast(`已导出 tokenstat-${label}.csv`);
}

let importing = false;
let importDraft;

function showImportState(message, failed = false) {
  const result = byId('import-result');
  result.hidden = !message;
  result.classList.toggle('failed', failed);
  result.textContent = message;
}

function setImportBusy(value) {
  importing = value;
  byId('choose-file').disabled = value;
  byId('confirm-import').disabled = value || !importDraft?.preview?.added;
  byId('cancel-import').disabled = value;
  for (const button of get('[data-import-opt]')) button.disabled = value;
}

async function previewImport() {
  byId('import-preview').hidden = true;
  showImportState(`正在预检 ${importDraft.filename}…`);
  importDraft.provider = state.importProvider;
  importDraft.preview = await request('import', importDraft, { query: { dryRun: true } });
  const { total, added, duplicate, models } = importDraft.preview;
  showImportState(`识别 ${full(total)} 条 · 新增 ${full(added)} 条 · 重复 ${full(duplicate)} 条`);
  const limit = 12;
  byId('import-models').innerHTML = models.slice(0, limit).map(({ provider, model, count }) =>
    `<li><span>${escapeHtml(providerById.get(provider)?.name ?? provider)} · ${escapeHtml(model ?? '模型未记录')}</span><strong>${full(count)}</strong></li>`
  ).join('') + (models.length > limit ? `<li>另有 ${full(models.length - limit)} 个模型分组</li>` : '');
  byId('import-preview').hidden = false;
}

async function importFiles(files) {
  if (!files.length || importing) return;
  importDraft = undefined;
  byId('import-preview').hidden = true;
  if (files.length !== 1 || files[0].size > 8 * 1024 * 1024) {
    showImportState('请选择一个不超过 8 MB 的文件。', true);
    byId('file-picker').value = '';
    return;
  }
  setImportBusy(true);
  try {
    const file = files[0];
    importDraft = { filename: file.name, content: await file.text() };
    await previewImport();
  } catch (error) {
    showImportState(error.message || '预检失败。', true);
  } finally {
    setImportBusy(false);
    byId('file-picker').value = '';
  }
}

async function confirmImport() {
  if (importing || !importDraft?.preview?.added) return;
  setImportBusy(true);
  try {
    const { filename, content, provider } = importDraft;
    const data = await request('import', { filename, content, provider });
    importDraft = undefined;
    byId('import-preview').hidden = true;
    showImportState(data.added ? `已导入 ${full(data.added)} 条，跳过 ${full(data.total - data.added)} 条重复记录。` : '记录均已存在。');
    await refreshLive();
  } catch (error) {
    showImportState(error.message || '导入失败。', true);
  } finally {
    setImportBusy(false);
  }
}

// Event Listeners
window.addEventListener('hashchange', () => navigate(true, false));
byId('time-zone').textContent = timeZone;
byId('theme-toggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
byId('demo-toggle').addEventListener('click', () => setDemo(!state.demo));
byId('exit-demo').addEventListener('click', () => setDemo(false));
byId('cmd-trigger').addEventListener('click', openCommandPalette);
get('.sync-button').forEach((button) => button.addEventListener('click', () => load('refresh', {})));
get('.export-button').forEach((button) => button.addEventListener('click', () => exportUsage(button.dataset.export)));

byId('cmd-modal').addEventListener('click', (event) => {
  if (event.target === byId('cmd-modal')) closeCommandPalette();
  const btn = event.target.closest('[data-cmd-idx]');
  if (btn) runCommand(Number(btn.dataset.cmdIdx));
});
byId('cmd-input').addEventListener('input', () => { state.cmdIndex = 0; renderCommandList(); });
byId('cmd-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (state.cmdItems.length) {
      state.cmdIndex = (state.cmdIndex + 1) % state.cmdItems.length;
      renderCommandList();
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (state.cmdItems.length) {
      state.cmdIndex = (state.cmdIndex - 1 + state.cmdItems.length) % state.cmdItems.length;
      renderCommandList();
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runCommand(state.cmdIndex);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandPalette();
  }
});

byId('chart-style-controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-style]');
  if (button && button.dataset.style !== state.chartStyle) {
    state.chartStyle = button.dataset.style;
    renderOverview();
  }
});

byId('trend-mode-controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (button && button.dataset.mode !== state.trendMode) {
    state.trendMode = button.dataset.mode;
    renderOverview();
  }
});

byId('range-controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (button && button.dataset.range !== state.range) {
    state.range = button.dataset.range;
    state.trendPage = 0;
    renderOverview();
  }
});

byId('chart-legend').addEventListener('click', (event) => {
  const { provider } = event.target.closest('[data-provider]')?.dataset ?? {};
  if (!provider) return;
  const set = state.trendMode === 'io' ? state.hiddenIo : state.hiddenTools;
  if (set.has(provider)) set.delete(provider);
  else set.add(provider);
  renderOverview();
  byId('chart-legend').querySelector(`[data-provider="${provider}"]`)?.focus();
});

byId('trend-older').addEventListener('click', () => { state.trendPage++; renderOverview(); });
byId('trend-newer').addEventListener('click', () => { state.trendPage--; renderOverview(); });

byId('distribution').addEventListener('pointerover', (event) => {
  const row = event.target.closest('.distribution-row[data-provider]');
  if (!row) return;
  const part = state.overviewShares.find((p) => p.id === row.dataset.provider);
  if (part && part.total > 0) {
    donutChart.setActive(part.id);
    handleDonutHover(part);
  }
});
byId('distribution').addEventListener('pointerleave', () => {
  donutChart.setActive(null);
  handleDonutHover(null);
});

byId('heatmap-grid').addEventListener('pointerover', (event) => {
  const cell = event.target.closest('[data-hm-date]');
  if (!cell) return;
  const d = cell.dataset.hmDate;
  const v = Number(cell.dataset.hmVal || 0);
  byId('heatmap-hover').textContent = `${d} (${weekdayLabel(d)}) · ${full(v)} Tokens`;
});
byId('heatmap-grid').addEventListener('pointerleave', () => {
  byId('heatmap-hover').textContent = '悬停方格查看当日用量';
});
byId('heatmap-grid').addEventListener('click', (event) => {
  const cell = event.target.closest('[data-hm-date]');
  if (cell) openDay(cell.dataset.hmDate);
});

byId('table-search').addEventListener('input', (event) => {
  state.tableQuery = event.target.value;
  const all = rows();
  const { entries } = period(all);
  byId('provider-table').innerHTML = providerRows(toolList(all), entries, false, state.tableQuery);
  applyDynamicStyles();
});

byId('toggle-expand-all').addEventListener('click', () => {
  const entries = period(rows()).entries;
  const tools = toolList(rows()).filter((t) => entries.some((e) => e.provider === t.id));
  const allExpanded = tools.every((t) => state.expanded.has(t.id));
  if (allExpanded) state.expanded.clear();
  else tools.forEach((t) => state.expanded.add(t.id));
  renderOverview();
});

byId('provider-table').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-expand]');
  const row = event.target.closest('[data-row-expand]');
  const expand = btn?.dataset.expand || row?.dataset.rowExpand;
  if (!expand) return;
  if (state.expanded.has(expand)) state.expanded.delete(expand);
  else state.expanded.add(expand);
  renderOverview();
  if (btn) document.querySelector(`[data-expand="${expand}"]`)?.focus();
});

byId('day-prev').addEventListener('click', () => updateDay(offsetDay(state.day, -1)));
byId('day-next').addEventListener('click', () => updateDay(offsetDay(state.day, 1)));
byId('today-button').addEventListener('click', () => updateDay(today()));
byId('day-picker').addEventListener('change', (event) => { if (event.target.value) updateDay(event.target.value); });

byId('history-table').addEventListener('click', (event) => {
  const date = event.target.closest('[data-date]')?.dataset.date || event.target.closest('[data-date-row]')?.dataset.dateRow;
  if (date) {
    updateDay(date);
    byId('daily-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
byId('history-newer').addEventListener('click', () => { state.historyPage--; renderDaily(); });
byId('history-older').addEventListener('click', () => { state.historyPage++; renderDaily(); });

byId('source-grid').addEventListener('input', (event) => {
  if (event.target.form?.dataset.settings) {
    state.drafts.set(event.target.form.dataset.settings, event.target.value);
  }
});
byId('source-grid').addEventListener('focusout', (event) => {
  if (event.target.matches('input') && !event.relatedTarget) {
    setTimeout(() => { if (state.page === 'sources' && !document.activeElement?.matches('#source-grid input')) renderSources(); }, 0);
  }
});
byId('source-grid').addEventListener('click', (event) => {
  const resetBtn = event.target.closest('[data-reset-path]');
  if (!resetBtn) return;
  const provider = resetBtn.dataset.resetPath;
  state.drafts.delete(provider);
  load('settings', { provider, path: '' });
});
byId('source-grid').addEventListener('submit', (event) => {
  event.preventDefault();
  load('settings', { provider: event.target.dataset.settings, path: new FormData(event.target).get('path') });
});

byId('sync-card').addEventListener('toggle', () => {
  if (byId('sync-card').open) void readSyncInfo(true);
  else showPairingKey();
});
syncForm.addEventListener('submit', (event) => {
  event.preventDefault();
  showPairingKey();
  void updateFolderSync('sync/settings', { enabled: true, ...Object.fromEntries(new FormData(syncForm)) }, true);
});
byId('run-sync').addEventListener('click', () => { void updateFolderSync('sync/run', {}); });
byId('disable-sync').addEventListener('click', () => {
  showPairingKey();
  void updateFolderSync('sync/settings', { enabled: false }, true);
});
byId('reveal-sync-key').addEventListener('click', async () => {
  try {
    const { pairingKey } = await request('sync/pairing-key', {});
    showPairingKey(pairingKey);
  } catch (error) {
    byId('sync-note').textContent = error.message;
  }
});
byId('hide-sync-key').addEventListener('click', () => showPairingKey());
byId('copy-sync-key').addEventListener('click', async () => {
  const field = byId('sync-pairing-key');
  try {
    await navigator.clipboard.writeText(field.value);
    byId('sync-note').textContent = '配对密钥已复制';
  } catch {
    field.focus();
    field.select();
    byId('sync-note').textContent = '密钥已选中，可按 Ctrl+C 复制';
  }
});
if (window.tokenstatDesktop?.chooseSyncFolder) {
  const choose = byId('choose-sync-folder');
  choose.hidden = false;
  choose.addEventListener('click', async () => {
    try {
      const folder = await window.tokenstatDesktop.chooseSyncFolder();
      if (folder) syncForm.elements.folder.value = folder;
    } catch {
      byId('sync-note').textContent = '无法打开文件夹选择器。可以直接输入路径。';
    }
  });
}

byId('import-provider-pills').addEventListener('click', async (event) => {
  const pill = event.target.closest('[data-import-opt]');
  if (!pill || importing || state.importProvider === pill.dataset.importOpt) return;
  state.importProvider = pill.dataset.importOpt;
  renderImportPills();
  if (!importDraft) return;
  setImportBusy(true);
  importDraft.preview = undefined;
  try { await previewImport(); }
  catch (error) { showImportState(error.message || '预检失败。', true); }
  finally { setImportBusy(false); }
});
byId('confirm-import').addEventListener('click', confirmImport);
byId('cancel-import').addEventListener('click', () => {
  importDraft = undefined;
  byId('import-preview').hidden = true;
  showImportState('');
});
byId('import-table').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-import-id]');
  if (!button) return;
  const entry = state.snapshot?.imports.find(({ id }) => id === button.dataset.importId);
  if (!entry || !window.confirm(`撤回「${entry.filename}」新增的 ${full(entry.added)} 条记录？`)) return;
  button.disabled = true;
  try {
    const result = await request(`imports/${encodeURIComponent(entry.id)}`, undefined, { method: 'DELETE' });
    toast(`已撤回 ${full(result.removed)} 条导入记录`);
    await refreshLive();
  } catch (error) {
    showImportState(error.message || '撤回失败。', true);
    button.disabled = false;
  }
});
byId('pricing-card').addEventListener('toggle', loadPrices);
priceForm.elements.provider.innerHTML = providers.map(({ id, name }) => `<option value="${id}">${name}</option>`).join('');
priceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(priceForm);
  const values = Object.fromEntries(form);
  for (const field of priceFields) values[field] = values[field] === '' ? null : Number(values[field]);
  void changePrice('pricing', values);
});
byId('price-table').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-price]');
  const remove = event.target.closest('[data-remove-price]');
  const rate = pricing?.overrides[edit?.dataset.editPrice ?? remove?.dataset.removePrice];
  if (!rate) return;
  if (edit) {
    for (const name of ['provider', 'model', ...priceFields]) priceForm.elements[name].value = rate[name] ?? '';
    priceForm.elements.model.focus();
  } else {
    void changePrice('pricing', undefined, { method: 'DELETE', query: { provider: rate.provider, model: rate.model } });
  }
});
byId('choose-file').addEventListener('click', () => byId('file-picker').click());
byId('file-picker').addEventListener('change', (event) => importFiles(event.target.files));
byId('template-button').addEventListener('click', () => {
  download('tokenstat-template.csv', [
    csvHeader, [today(), 'gemini', 'gemini-2.5-pro', 1500, 320, 500, 0, 1820],
  ]);
  toast('已下载 CSV 模板');
});

const dropzone = byId('dropzone');
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', (event) => { if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  importFiles(event.dataTransfer.files);
});

// Keyboard shortcuts (including ⌘K / Ctrl+K)
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.cmdOpen) closeCommandPalette();
    else openCommandPalette();
    return;
  }
  if (state.cmdOpen) {
    if (event.key === 'Escape') closeCommandPalette();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;

  if (event.key >= '1' && event.key <= '4') {
    const target = pageOrder[Number(event.key) - 1];
    if (target && target !== state.page) location.hash = target;
  } else if (event.key === 'r' || event.key === 'R') {
    load('refresh', {});
  } else if (state.page === 'daily' && event.key === '[') {
    updateDay(offsetDay(state.day, -1));
  } else if (state.page === 'daily' && event.key === ']') {
    const { max } = dateBounds(rows());
    if (state.day < max) updateDay(offsetDay(state.day, 1));
  }
});

// Tactile ripple wave on interactive pills & buttons
document.addEventListener('pointerdown', (event) => {
  if (reducedMotion()) return;
  const target = event.target.closest('.primary-pill, .ghost-pill, .icon-pill, .outline-btn, .cmd-trigger, .topnav a');
  if (!target || target.disabled) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const wave = document.createElement('span');
  wave.className = 'ripple';
  wave.style.width = `${size}px`;
  wave.style.height = `${size}px`;
  wave.style.left = `${event.clientX - rect.left - size / 2}px`;
  wave.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.append(wave);
  wave.addEventListener('animationend', () => wave.remove(), { once: true });
}, { passive: true });

initTheme();
hydrateStaticIcons();
installDesktopPreferences();
renderImportPills();
navigate(false, true);
load();
connectEvents();
