import { tr as translateTemplate, t as translateText } from './i18n.js';
import { fields, full, percent, state, money } from './state.js';
import { unpricedDetails } from './pricing-display.js';
import { addUsage, emptyStats, escapeHtml, icon, isLoading, isReviewRoute, providerName, sourceChip, sourceLabel, tableEmpty, totals } from './ui.js';

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
      return translateTemplate`<td class="numeric" title="部分日志未提供独立推理 Token">${value}</td>`;
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
  const estimated = row.estimatedCost == null ? '—' : money.format(row.estimatedCost);
  const coverage = row.estimatedCost != null && row.pricedTokens < row.total
    ? translateTemplate`<small>覆盖 ${percent.format(row.pricedTokens / row.total)}</small>` : '';
  const reported = row.reportedCostUsd == null ? '' : translateTemplate`<small>日志记录 ${money.format(row.reportedCostUsd)}</small>`;
  return `<td class="numeric price-cell">${estimated}${coverage}${reported}${unpricedDetails(row.unpricedReasons)}</td>`;
}

function providerRows(tools, entries, isDaily, query = '') {
  const colSpan = 7;
  if (isLoading() || (isDaily && !entries.length)) {
    return tableEmpty(isLoading() ? translateText('正在读取本地用量…') : translateText('这一天没有用量记录。'), colSpan);
  }
  const q = query.trim().toLowerCase();
  const grandTotal = totals(entries).total;
  const rendered = tools.map((provider) => {
    const providerEntries = entries.filter((entry) => entry.provider === provider.id);
    const sum = totals(providerEntries);
    const allModels = groupByModel(providerEntries);
    const providerMatches = !q || provider.name.toLowerCase().includes(q) || provider.id.includes(q);
    const matchedModels = q ? allModels.filter((m) => (m.model ?? translateText('模型未记录')).toLowerCase().includes(q)) : allModels;
    if (q && !providerMatches && !matchedModels.length) return '';

    const modelsToShow = providerMatches ? allModels : matchedModels;
    const sources = [...new Set(providerEntries.map((entry) => sourceLabel(entry.source)))];
    const expanded = isDaily || Boolean(q && matchedModels.length) || state.expanded.has(provider.id);
    const source = sources.length > 1 ? translateText('多种来源') : sources[0];
    const hasModels = modelsToShow.length > 0;
    const toggle = isDaily ? '' : `<td class="row-end">${hasModels
      ? translateTemplate`<button class="row-expand" type="button" data-expand="${provider.id}" aria-label="${provider.name} 模型用量" aria-expanded="${expanded}">${icon('chevron-right')}</button>`
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
      const name = escapeHtml(model.model ?? translateText('模型未记录'));
      const route = isReviewRoute(provider.id, model.model) ? translateText('<span class="model-route-label">审核路由</span>') : '';
      const modelSource = model.sources.size > 1 ? translateText('多种来源') : [...model.sources][0];
      return `<tr class="model-row${model.model === null ? ' unassigned-model' : ''}">
        <td title="${name}">${name}${route}</td>
        ${isDaily ? '' : `<td>${escapeHtml(modelSource)}</td>`}
        ${tableNumbers(model, isDaily)}
        ${isDaily ? costCell(model) : shareCell(model.total, grandTotal, provider.id)}
        ${isDaily ? '' : '<td></td>'}
      </tr>`;
    }).join('');
  }).filter(Boolean).join('');

  return rendered || tableEmpty(translateTemplate`没有匹配「${escapeHtml(query)}」的工具或模型。`, colSpan);
}

export { providerRows };
