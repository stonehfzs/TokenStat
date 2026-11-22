import { tr as translateTemplate, t as translateText } from './i18n.js';
import { refreshLive, request } from './api.js';
import { full, priceFields, providerById, providers } from './state.js';
import { byId, escapeHtml } from './ui.js';

let pricing;

let editingPrice = false;

const priceForm = byId('price-form');

function showPrices(catalog) {
  pricing = catalog;
  byId('pricing-basis').textContent = translateTemplate`公开标准费率核对日期 ${catalog.pricingBasis.asOf}。自定义费率按固定单价覆盖。`;
  const renderRate = (rate, index, label) => {
    const provider = providerById.get(rate.provider)?.name;
    const actions = provider
      ? translateTemplate`<button class="ghost-btn record-remove" type="button" data-edit-price="${index}">编辑</button>
         <button class="ghost-btn record-remove" type="button" data-remove-price="${index}">删除</button>`
      : `<span class="quiet">${label}</span>`;
    return `<tr><td>${provider ? `${provider} · ` : ''}${escapeHtml(rate.model)}</td>
      ${priceFields.map((field) => `<td class="numeric">${rate[field] == null ? '—' : full(rate[field])}</td>`).join('')}
      <td>${actions}</td></tr>`;
  };
  const references = catalog.defaultRates.flatMap((rate) => rate.longContext ? [
    renderRate(rate, undefined, translateTemplate`输入 < ${full(rate.longContext.minInput)}`),
    renderRate({ model: rate.model, ...rate.longContext }, undefined, translateTemplate`输入 ≥ ${full(rate.longContext.minInput)}`),
  ] : [renderRate(rate, undefined, translateText('标准费率'))]);
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
    result.textContent = data ? translateText('单价已保存。') : translateText('单价已移除。');
    priceForm.reset();
    await refreshLive();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    editingPrice = false;
  }
}

function bindPricing() {
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
}

export { bindPricing };
