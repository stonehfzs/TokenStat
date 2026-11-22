import { t as translateText } from './i18n.js';
import { state, timeZone } from './state.js';
import { toast } from './ui.js';
import { t } from './i18n.js';

let hooks;
function bindApi(callbacks) { hooks = callbacks; }

async function request(endpoint, data, { query = {}, method = data === undefined ? 'GET' : 'POST', signal } = {}) {
  const params = new URLSearchParams({ timeZone, ...query });
  if (state.device && ['usage', 'day', 'refresh', 'settings'].includes(endpoint)) params.set('device', state.device);
  const options = { method, signal };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const response = await fetch(`/api/${endpoint}?${params}`, options);
  let result;
  try { result = await response.json(); }
  catch { throw new Error(translateText('无法读取本地服务的响应。')); }
  if (!response.ok) throw new Error(t(result.error || translateText('本地服务暂时不可用。')));
  return result;
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.preferences = snapshot.preferences ?? state.preferences;
}

async function load(endpoint = 'usage', data) {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  hooks.render();
  try {
    applySnapshot(await request(endpoint, data));
    if (endpoint === 'settings') state.drafts.delete(data.provider);
    if (endpoint !== 'usage') {
      toast(endpoint === 'settings' ? translateText('已保存路径并完成扫描') : translateText('本地用量已同步'));
    }
  } catch (error) {
    state.error = error.message || translateText('无法连接本地服务。');
  } finally {
    state.busy = false;
    hooks.render();
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
      const selectedDevice = state.device;
      const snapshot = await request('usage');
      if (selectedDevice !== state.device) continue;
      if (force || !state.snapshot || snapshot.revision >= state.snapshot.revision) {
        if (force) hooks.resetDayDetails();
        applySnapshot(snapshot);
        state.error = '';
        hooks.render();
      }
    }
  } catch (error) {
    if (!state.snapshot) {
      state.error = error.message;
      hooks.render();
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
    hooks.updateLiveStatus();
    if (state.snapshot) void refreshLive(true);
  });
  events.addEventListener('usage', (event) => {
    const { revision } = JSON.parse(event.data);
    if (state.snapshot?.revision !== revision) void refreshLive();
  });
  events.addEventListener('sync', () => { void hooks.readSyncInfo(); });
  events.addEventListener('error', () => {
    state.live = false;
    hooks.updateLiveStatus();
  });
}

export { bindApi, connectEvents, load, refreshLive, request };
