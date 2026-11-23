import { t as translateText } from './i18n.js';
import { full, money, percent, state } from './state.js';
import { byId, escapeHtml } from './ui.js';

const labels = {
  dailyTokens: '每日 Token 预算',
  dailyUsd: '每日费用预算',
  monthlyTokens: '每月 Token 预算',
  monthlyUsd: '每月费用预算',
};

function budgetCard({ key, limit, used, unpricedRecords }) {
  const label = escapeHtml(translateText(labels[key]));
  const amount = key.endsWith('Tokens') ? full : money.format;
  const ratio = used == null ? 0 : used / limit;
  const level = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warning' : 'normal';
  const status = ratio > 1 ? translateText('已超预算') : ratio === 1 ? translateText('已达预算') : '';
  const coverage = unpricedRecords
    ? translateText(used == null ? '暂无费用估算' : '仅含已计价用量') : '';
  const details = [status, coverage].filter(Boolean).join(' · ');
  const ratioLabel = ratio >= 10 ? `≥${percent.format(10)}` : percent.format(Math.floor(ratio * 1000) / 1000);
  return `<a class="budget-item" href="#sources/budget" data-budget-state="${level}">
    <span class="budget-item-title"><span>${label}</span><strong>${used == null ? '—' : ratioLabel}</strong></span>
    ${used == null ? '<span class="budget-meter-empty" aria-hidden="true"></span>'
      : `<progress max="1" value="${Math.min(1, ratio)}" aria-label="${label}"></progress>`}
    <span class="budget-item-amount">${used == null ? '—' : amount(used)} / ${amount(limit)}${details ? ` · ${details}` : ''}</span>
  </a>`;
}

export function renderOverviewBudget() {
  const container = byId('overview-budget');
  const progress = state.demo ? [] : state.snapshot?.budgetProgress ?? [];
  container.hidden = !progress.length;
  if (!progress.length) return;
  const markup = `<h2>${translateText('预算进度')}</h2><div class="budget-items">${progress.map(budgetCard).join('')}</div>`;
  if (container.innerHTML !== markup) container.innerHTML = markup;
}
