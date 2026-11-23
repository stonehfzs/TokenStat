import { t as translateText, tr as translateTemplate } from './i18n.js';
import { createDonut, createSparkline, createTrend } from '../charts.js';
import { openDay } from './daily.js';
import { renderOverviewBudget } from './overview-budget.js';
import { overviewPeriod, overviewTrend, validOverviewDate } from './overview-data.js';
import { exportReportCard } from './report-card.js';
import { clockTime, compact, displayDate, full, ioSeriesMeta, money, offsetDay, percent, reducedMotion, rows, state, today, weekdayLabel, weekdays } from './state.js';
import { applyDynamicStyles, byId, deltaBadgeHtml, escapeHtml, get, getColorVar, isLoading, syncAllGliders, toast, toolList, totals } from './ui.js';
import { providerRows } from './usage-table.js';

const rhythmOrder = [1, 2, 3, 4, 5, 6, 0];

const drawSparkline = createSparkline(byId('hero-sparkline'));

const trendChart = createTrend(byId('trend-canvas'), byId('chart-tooltip'), {
  compact, full, money: money.format, percent: percent.format, onDate: openDay,
});

const donutChart = createDonut(byId('donut-canvas'), { onHover: handleDonutHover });

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

function renderHeroGauges(current, activeDays, totalDays) {
  const loading = isLoading();
  const cacheRate = current.input > 0 ? Math.min(1, current.cached / current.input) : 0;
  const outputRate = current.total > 0 ? Math.min(1, current.output / current.total) : 0;
  const activeRate = totalDays > 0 ? Math.min(1, activeDays / totalDays) : 0;

  const gauges = [
    { key: 'cache', label: translateText('缓存命中'), ratio: cacheRate, sub: loading ? '—' : compact(current.cached) },
    { key: 'output', label: translateText('输出占比'), ratio: outputRate, sub: loading ? '—' : compact(current.output) },
    { key: 'active', label: translateText('活跃天数'), ratio: activeRate, sub: loading ? '—' : translateTemplate`${activeDays}/${totalDays} 天` },
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
    peakEl.textContent = translateTemplate`峰值 ${peakDay.slice(5)} · ${compact(peakVal)}`;
    peakEl.hidden = false;
  } else {
    peakEl.hidden = true;
  }

  const subParts = [];
  if (!loading) {
    if (previous && previous.total > 0) {
      subParts.push(translateTemplate`${deltaBadgeHtml(current.total, previous.total)}<span>较上一周期</span>`);
    }
    if (days > 1) {
      subParts.push(translateTemplate`<span>日均 <strong>${compact(Math.round(current.total / days))}</strong></span>`);
    }
    if (current.count > 0) {
      subParts.push(translateTemplate`<span>${full(current.count)} 条记录</span>`);
    }
  } else {
    subParts.push(translateText('<span>正在扫描本地日志…</span>'));
  }
  byId('hero-subline').innerHTML = subParts.join('<span aria-hidden="true">·</span>');

  renderHeroGauges(current, byDay.size, days);

  const reasoningKnown = current.count === 0 || current.withoutReasoning < current.count;
  const items = [
    {
      key: 'input',
      label: translateText('输入 Token'),
      value: current.input,
      prev: previous?.input,
      ratio: current.total > 0 ? current.input / current.total : 0,
      badge: current.total > 0 ? translateTemplate`占 ${percent.format(current.input / current.total)}` : '',
      foot: translateText('Prompt 上下文'),
    },
    {
      key: 'output',
      label: translateText('输出 Token'),
      value: current.output,
      prev: previous?.output,
      ratio: current.total > 0 ? current.output / current.total : 0,
      badge: current.total > 0 ? translateTemplate`占 ${percent.format(current.output / current.total)}` : '',
      foot: translateText('模型生成回复'),
    },
    {
      key: 'cached',
      label: translateText('缓存命中'),
      value: current.cached,
      prev: previous?.cached,
      ratio: current.input > 0 ? Math.min(1, current.cached / current.input) : 0,
      badge: current.input > 0 ? translateTemplate`命中 ${percent.format(Math.min(1, current.cached / current.input))}` : '',
      foot: translateText('复用上下文缓存'),
    },
    {
      key: 'reasoning',
      label: translateText('推理 Token'),
      value: current.reasoning,
      prev: previous?.reasoning,
      ratio: current.output > 0 ? Math.min(1, current.reasoning / current.output) : 0,
      badge: reasoningKnown && current.output > 0 ? translateTemplate`占输出 ${percent.format(Math.min(1, current.reasoning / current.output))}` : '',
      foot: reasoningKnown ? translateText('深度思考消耗') : translateText('部分日志未单独记录'),
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
      <div class="tele-foot">${delta ? translateTemplate`${delta}<span>较上期</span>` : `<span>${item.foot}</span>`}</div>
      <div class="tele-bar"><div class="tele-bar-fill" data-bar-pct="${pct}"></div></div>
    </div>`;
  }).join('');
}

function period(entries) {
  const selected = overviewPeriod(entries, state.range, today(), state.customRange);
  return { ...selected, previous: selected.previous ? totals(selected.previous) : undefined };
}

function renderModelLeaderboard(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = `${entry.provider}::${entry.model ?? translateText('未记录')}`;
    const cur = map.get(key) || { provider: entry.provider, model: entry.model ?? translateText('模型未记录'), total: 0 };
    cur.total += entry.total;
    map.set(key, cur);
  }
  const ranked = [...map.values()].filter((m) => m.total > 0).sort((a, b) => b.total - a.total);
  byId('model-count-pill').textContent = translateTemplate`${ranked.length} 模型`;

  const container = byId('model-leaderboard');
  if (isLoading()) {
    container.innerHTML = translateText('<div class="lb-empty">正在读取模型数据…</div>');
    return;
  }
  if (!ranked.length) {
    container.innerHTML = translateText('<div class="lb-empty">当前周期暂无模型消耗记录</div>');
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
    return translateTemplate`<div class="rhythm-col${isPeak ? ' is-peak' : ''}" title="${weekdays[dow]}日均 ${full(val)}">
      <span class="rhythm-val">${isLoading() || !val ? '·' : compact(val)}</span>
      <div class="rhythm-track"><div class="rhythm-fill" data-bar-h="${hPct}"></div></div>
      <span class="rhythm-day">${weekdays[dow].slice(1)}</span>
    </div>`;
  }).join('');

  byId('rhythm-peak').textContent = isLoading()
    ? translateText('计算中…')
    : peakVal > 0 ? translateTemplate`最高峰 · ${weekdays[peakDow]} (${compact(peakVal)}/天)` : translateText('暂无节律数据');
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
    ? translateText('正在计算活跃度…')
    : translateTemplate`近 24 周累计活跃 ${activeCount} / ${totalCells} 天`;
  byId('heatmap-hover').textContent = translateText('悬停方格查看当日用量');
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
    subEl.textContent = translateText('总 Token');
  }
}

function renderOverview() {
  const all = rows();
  const { start, end, days, entries, previous } = period(all);
  const tools = toolList(entries);
  const current = totals(entries);
  state.overviewTotal = current.total;

  byId('overview-caption').textContent = translateTemplate`${displayDate(start)} — ${displayDate(end)} · ${days} 天`;
  renderOverviewTelemetry(current, previous, days, entries);
  renderOverviewBudget();

  const isIo = state.trendMode === 'io';
  const isCost = state.trendMetric === 'cost';
  const ioCostLabels = { input: translateText('输入费用'), output: translateText('输出费用') };
  const ioSeries = ioSeriesMeta.map((item) => ({ ...item,
    name: isCost ? ioCostLabels[item.id] : item.name, color: getColorVar(item.cssVar, item.fallback),
  }));
  const legendItems = isIo ? ioSeries : tools;
  const hiddenSet = isIo ? state.hiddenIo : state.hiddenTools;
  const visibleSeries = legendItems.filter((item) => !hiddenSet.has(item.id));
  const { buckets, first, last, pages, page } = overviewTrend({ start, end, entries,
    mode: state.trendMode, metric: state.trendMetric, hidden: hiddenSet, page: state.trendPage,
  });
  state.trendPage = page;
  const sparkline = !isCost && !isIo && !hiddenSet.size && !page ? buckets : overviewTrend({
    start, end, entries, mode: 'provider', metric: 'token', hidden: new Set(), page: 0,
  }).buckets;
  drawSparkline(sparkline.slice(-30).map((bucket) => bucket.total));

  const trendDescription = isCost
    ? (isIo ? translateText('按输入与输出对比每日估算费用') : translateText('按工具统计每日估算费用'))
    : (isIo ? translateText('按输入与输出对比每日 Token 消耗') : translateText('按工具统计每日 Token 消耗'));
  byId('trend-caption').textContent = pages > 1
    ? translateTemplate`${first} 至 ${last} · ${trendDescription}` : trendDescription;
  byId('trend-navigation').hidden = pages <= 1;
  byId('trend-older').disabled = state.trendPage >= pages - 1;
  byId('trend-newer').disabled = state.trendPage === 0;

  byId('chart-legend').innerHTML = legendItems.map((item) =>
    `<button type="button" data-provider="${item.id}" aria-pressed="${!hiddenSet.has(item.id)}"><i class="series-dot"></i>${item.name}</button>`
  ).join('');

  get('#chart-style-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.style === state.chartStyle));
  get('#trend-metric-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.metric === state.trendMetric));
  get('#trend-mode-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.mode === state.trendMode));
  get('#range-controls button').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.range === state.range));

  const hasData = visibleSeries.length > 0 && buckets.some((bucket) => isCost ? bucket.pricedRecords > 0 : bucket.total > 0);
  const avgEl = byId('trend-avg');
  if (hasData && buckets.length > 0) {
    const avgVal = buckets.reduce((sum, bucket) => sum + bucket.total, 0) / buckets.length;
    avgEl.textContent = translateTemplate`日均 ${isCost ? money.format(avgVal) : compact(Math.round(avgVal))}`;
    avgEl.hidden = false;
  } else {
    avgEl.hidden = true;
  }

  byId('trend-canvas').setAttribute('aria-label', translateText(isCost ? '每日估算费用趋势图' : '每日 Token 用量趋势图'));
  trendChart.update(buckets, visibleSeries, state.chartStyle, state.trendMetric);
  byId('chart-empty').hidden = hasData;
  const emptyLabel = isCost && buckets.some((bucket) => bucket.records > 0) ? '该周期暂无可估算费用' : '该周期暂无用量记录';
  byId('chart-empty-title').textContent = isLoading() ? translateText('正在扫描本地日志') : visibleSeries.length ? translateText(emptyLabel) : translateText('请至少选择一个系列');
  byId('chart-empty-detail').textContent = isLoading() ? translateText('首次扫描较大日志可能需要几秒') : visibleSeries.length ? translateText('可切换周期、开启示例数据或在来源中配置日志') : '';
  byId('trend-update').textContent = state.demo ? translateText('当前正在预览示例数据') : state.snapshot?.syncedAt
    ? translateTemplate`最近同步 ${clockTime.format(new Date(state.snapshot.syncedAt))}` : translateText('等待本地同步');

  const shares = tools.map((provider) => ({
    ...provider,
    total: totals(entries.filter((entry) => entry.provider === provider.id)).total,
  }));
  state.overviewShares = shares;
  donutChart.update(shares);
  byId('donut-total').textContent = isLoading() ? '—' : compact(current.total);
  byId('donut-sub').textContent = translateText('总 Token');

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
    expandAllBtn.textContent = allExpanded ? translateText('收起全部') : translateText('展开全部');
  }
  get('[data-export="overview"]')[0].disabled = !entries.length;
  byId('export-report').disabled = !entries.length;
  applyDynamicStyles();
  requestAnimationFrame(() => syncAllGliders());
}

function bindOverview() {
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
  byId('trend-metric-controls').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-metric]');
    if (button && button.dataset.metric !== state.trendMetric) {
      state.trendMetric = button.dataset.metric;
      renderOverview();
    }
  });
  const rangeForm = byId('overview-range-form');
  const rangeError = byId('overview-range-error');
  const customButton = byId('range-controls').querySelector('[data-range="custom"]');
  function showRangeForm(open) {
    rangeForm.hidden = !open;
    rangeError.hidden = true;
    customButton.setAttribute('aria-expanded', open);
    if (open) {
      const { start, end } = period(rows());
      rangeForm.elements.from.value = state.customRange?.from ?? start;
      rangeForm.elements.to.value = state.customRange?.to ?? end;
      rangeForm.elements.from.focus();
    }
  }
  byId('range-controls').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    if (button === customButton) {
      showRangeForm(rangeForm.hidden);
      return;
    }
    showRangeForm(false);
    if (button.dataset.range !== state.range) {
      state.range = button.dataset.range;
      state.trendPage = 0;
      renderOverview();
    }
  });
  rangeForm.addEventListener('input', () => { rangeError.hidden = true; });
  rangeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const { from, to } = Object.fromEntries(new FormData(rangeForm));
    if (!validOverviewDate(from) || !validOverviewDate(to) || from > to) {
      rangeError.textContent = translateText(from > to ? '开始日期不能晚于结束日期' : '请选择有效的日期范围');
      rangeError.hidden = false;
      return;
    }
    state.customRange = { from, to };
    state.range = 'custom';
    state.trendPage = 0;
    rangeError.hidden = true;
    renderOverview();
  });
  byId('export-report').addEventListener('click', async () => {
    const { start, end, entries } = period(rows());
    if (!entries.length) return;
    try {
      await exportReportCard({ start, end, entries, tools: toolList(entries), demo: state.demo });
      toast(translateText('已导出报告图'));
    } catch {
      toast(translateText('无法导出报告图'));
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
    byId('heatmap-hover').textContent = translateText('悬停方格查看当日用量');
  });
  byId('heatmap-grid').addEventListener('click', (event) => {
    const cell = event.target.closest('[data-hm-date]');
    if (cell) openDay(cell.dataset.hmDate);
  });
  byId('table-search').addEventListener('input', (event) => {
    state.tableQuery = event.target.value;
    const all = rows();
    const { entries } = period(all);
    byId('provider-table').innerHTML = providerRows(toolList(entries), entries, false, state.tableQuery);
    applyDynamicStyles();
  });
  byId('toggle-expand-all').addEventListener('click', () => {
    const entries = period(rows()).entries;
    const tools = toolList(entries).filter((t) => entries.some((e) => e.provider === t.id));
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
}

export { bindOverview, period, renderOverview };
