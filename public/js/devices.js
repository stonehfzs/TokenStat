import { t as translateText } from './i18n.js';
import { load, request } from './api.js';
import { resetDayDetails } from './daily.js';
import { full, money, offsetDay, state, today } from './state.js';
import { byId, escapeHtml } from './ui.js';

const selector = byId('device-filter');
const panel = byId('device-comparison');
let options;
let displayedRevision;

function label(device) {
  return device.local ? device.deviceName + translateText('（本机）') : device.deviceName;
}

export function renderDevices() {
  const devices = state.snapshot?.devices;
  if (!devices) {
    selector.disabled = true;
    return;
  }
  const comparable = devices.length > 1;
  byId('device-controls').hidden = !comparable || !['overview', 'daily'].includes(state.page);
  panel.hidden = !comparable || state.demo;
  const markup = translateText('<option value="">全部设备</option>') + devices.map((device) =>
    `<option value="${escapeHtml(device.id)}">${escapeHtml(label(device))}</option>`).join('');
  if (markup !== options) {
    selector.innerHTML = markup;
    options = markup;
  }
  if (state.device && !devices.some((device) => device.id === state.device)) {
    state.device = '';
    resetDayDetails();
    queueMicrotask(() => { void load(); });
  }
  selector.value = state.device;
  selector.disabled = state.busy || state.demo;
  if (state.page === 'overview' && panel.open && !panel.hidden) void comparison();
}

async function comparison() {
  const to = today();
  const revision = state.snapshot?.revision + ':' + to;
  if (revision === displayedRevision) return;
  displayedRevision = revision;
  try {
    const { devices } = await request('devices', undefined, { query: { from: offsetDay(to, -29), to } });
    if (revision !== displayedRevision) return;
    byId('device-comparison-rows').innerHTML = devices.map((device) => `<tr>
      <td>${escapeHtml(label(device))}</td><td class="numeric total">${full(device.total ?? 0)}</td>
      <td class="numeric">${device.estimatedCost == null ? '—' : money.format(device.estimatedCost)}</td>
    </tr>`).join('');
    byId('device-comparison-status').textContent = translateText('同一条记录可能出现在多台设备。全部设备视图会去重。');
  } catch (error) {
    if (revision !== displayedRevision) return;
    displayedRevision = undefined;
    byId('device-comparison-status').textContent = error.message;
  }
}

export function bindDevices() {
  selector.addEventListener('change', () => {
    if (state.busy || state.device === selector.value) return;
    state.device = selector.value;
    resetDayDetails();
    void load();
  });
  panel.addEventListener('toggle', () => { if (panel.open && !panel.hidden) void comparison(); });
}
