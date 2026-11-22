import { t as translateText, tr as translateTemplate } from './i18n.js';
import { request } from './api.js';
import { clockTime, dateMillis, full, offsetDay, oneDay, percent, providerById, relativeDayTag, rows, state, timeZone, today, money } from './state.js';
import { applyDynamicStyles, byId, escapeHtml, get, isLoading, isReviewRoute, tableEmpty, toolList, totals } from './ui.js';
import { providerRows } from './usage-table.js';

function renderDailyTelemetry(sum) {
  const loading = isLoading();
  const items = [
    { key: 'total', label: translateText('当日总计'), value: sum.total, ratio: sum.total > 0 ? 1 : 0, badge: translateTemplate`${full(sum.count)} 条记录` },
    { key: 'input', label: translateText('输入 Token'), value: sum.input, ratio: sum.total > 0 ? sum.input / sum.total : 0, badge: sum.total > 0 ? percent.format(sum.input / sum.total) : '' },
    { key: 'output', label: translateText('输出 Token'), value: sum.output, ratio: sum.total > 0 ? sum.output / sum.total : 0, badge: sum.total > 0 ? percent.format(sum.output / sum.total) : '' },
    { key: 'cached', label: translateText('缓存命中'), value: sum.cached, ratio: sum.input > 0 ? Math.min(1, sum.cached / sum.input) : 0, badge: sum.input > 0 ? translateTemplate`命中 ${percent.format(Math.min(1, sum.cached / sum.input))}` : '' },
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
  byId('daily-currency').textContent = state.preferences?.currency ?? 'USD';
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
  byId('daily-heading').textContent = translateTemplate`${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;

  const summary = [
    translateTemplate`${new Set(matching.map((entry) => entry.provider)).size} 个工具`,
    translateTemplate`${exactModels.size} 个模型`,
    reviewUsage ? translateTemplate`${full(reviewUsage)} Token 审核路由` : '',
    unattributed ? translateTemplate`${full(unattributed)} Token 模型未记录` : '',
  ];
  byId('daily-summary-caption').textContent = isLoading() ? translateText('正在读取本地用量…') : summary.filter(Boolean).join(' · ');

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

  byId('history-head').innerHTML = translateTemplate`<tr><th scope="col">日期</th>${tools.map((provider) => `<th scope="col" class="num-col">${provider.name}</th>`).join('')}<th scope="col" class="num-col">总 Token</th></tr>`;
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
  renderDaily();
}

let dayRequest;

let dayDetails;

function paintDayInsights(details, unavailable = translateText('正在读取当天明细…')) {
  const hourly = details?.hourly ?? [];
  const total = hourly.reduce((sum, entry) => sum + entry.total, 0);
  const peak = Math.max(1, ...hourly.map((entry) => entry.total));
  byId('hourly-note').textContent = details
    ? [total ? translateTemplate`${full(total)} Token 有小时记录` : translateText('当天暂无带时间的用量记录。'),
      details.withoutTime ? translateTemplate`${full(details.withoutTime)} 条记录仅有日期` : ''].filter(Boolean).join(' · ')
    : unavailable;
  byId('hourly-chart').innerHTML = hourly.map(({ hour, total: tokens }) => {
    const label = String(hour).padStart(2, '0');
    return `<div class="hour-cell" title="${label}:00 · ${full(tokens)} Token">
      <span class="sr-only">${label}:00 · ${full(tokens)} Token</span>
      <i class="hour-track" aria-hidden="true"><i data-bar-h="${100 * tokens / peak}"></i></i>
      <span aria-hidden="true">${hour % 3 === 0 ? label : ''}</span>
    </div>`;
  }).join('');

  byId('estimated-cost').textContent = details?.estimatedCost == null ? '—' : money.format(details.estimatedCost);
  byId('cache-savings').textContent = details?.cacheSavings == null ? '—' : money.format(details.cacheSavings);
  byId('reported-cost-group').hidden = details?.reportedCostUsd == null;
  byId('reported-cost').textContent = details?.reportedCostUsd == null ? '—' : money.format(details.reportedCostUsd);
  const coverage = details?.coverage;
  const tiered = details?.shortRequests || details?.longRequests
    ? translateTemplate`短上下文 ${full(details.shortRequests)} 次 · 长上下文 ${full(details.longRequests)} 次` : '';
  const unclassified = details?.unclassifiedRecords
    ? translateTemplate`${full(details.unclassifiedRecords)} 条记录缺少单次请求用量` : '';
  byId('pricing-coverage').textContent = !coverage ? unavailable :
    coverage.totalTokens === 0 ? translateText('当天暂无用量。') :
      [coverage.pricedTokens ? translateTemplate`覆盖 ${percent.format(coverage.pricedTokens / coverage.totalTokens)} 的 Token` : translateText('当天用量尚无可用估算'),
        tiered, unclassified].filter(Boolean).join(' · ');
  const breakdown = details?.costBreakdown;
  byId('cost-breakdown').hidden = breakdown == null;
  const categories = { freshInput: translateText('普通输入'), cachedInput: translateText('缓存读取'), cacheWrite: translateText('缓存写入'), output: translateText('其余输出'), reasoning: translateText('已记录的推理') };
  byId('cost-breakdown-values').innerHTML = breakdown ? Object.entries(categories).map(([key, label]) =>
    `<div><dt>${label}</dt><dd>${money.format(breakdown[key])}</dd></div>`).join('') : '';

  const sessions = details?.sessions ?? [];
  byId('session-table').innerHTML = sessions.length ? sessions.map(({ provider, session, startedAt, endedAt, total: tokens }) => {
    const label = providerById.get(provider)?.name ?? provider;
    const time = startedAt && endedAt
      ? `${clockTime.format(new Date(startedAt))} – ${clockTime.format(new Date(endedAt))}`
      : '—';
    return `<tr><td>${escapeHtml(label)}</td><td><code title="${escapeHtml(session)}">${escapeHtml(session.slice(0, 12))}</code></td>
      <td>${time}</td><td class="numeric total">${full(tokens)}</td></tr>`;
  }).join('') : tableEmpty(details ? translateText('当天暂无可识别的会话。') : unavailable, 4);
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
  const device = state.device;
  const key = `${state.snapshot.revision}:${date}:${device}`;
  if (dayDetails?.key === key) return;
  if (dayRequest?.key === key) return;
  dayRequest?.controller.abort();
  if (dayDetails?.date !== date) paintDayInsights(null);
  const pending = { key, controller: new AbortController() };
  dayRequest = pending;
  void request('day', undefined, { query: { date }, signal: pending.controller.signal }).then((data) => {
    if (dayRequest !== pending || state.demo || state.day !== date || state.device !== device) return;
    dayDetails = { key, date };
    paintDayInsights(data);
  }).catch((error) => {
    if (dayRequest === pending && error.name !== 'AbortError') paintDayInsights(null, translateText('无法读取当天明细。'));
  }).finally(() => {
    if (dayRequest === pending) dayRequest = undefined;
  });
}

function resetDayDetails() { dayDetails = undefined; }

function bindDaily() {
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
}

export { bindDaily, resetDayDetails, dateBounds, openDay, renderDaily, selectDay, updateDay };
