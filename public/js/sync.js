import { t as translateText, tr as translateTemplate } from './i18n.js';
import { refreshLive, request } from './api.js';
import { t } from './i18n.js';
import { dateTime, full, state } from './state.js';
import { byId, escapeHtml, get } from './ui.js';

const syncStates = {
  disabled: translateText('未启用'), ready: translateText('已启用'), syncing: translateText('同步中'), ok: translateText('已同步'), offline: translateText('文件夹不可用'), error: translateText('同步异常'),
};

const syncForm = byId('sync-form');

let syncInfo;

let syncBusy = false;

function showSyncInfo(info, populate = false) {
  syncInfo = info;
  byId('sync-state').textContent = !info.enabled && info.configured ? translateText('已暂停') : syncStates[info.state] ?? translateText('跨设备同步');
  byId('save-sync').textContent = info.enabled ? translateText('保存并同步') : translateText('启用并同步');
  byId('disable-sync').hidden = !info.enabled;
  byId('run-sync').hidden = !info.enabled;
  byId('reveal-sync-key').hidden = !info.configured;
  if (populate) {
    syncForm.elements.folder.value = info.folder ?? '';
    syncForm.elements.deviceName.value = info.deviceName ?? '';
    syncForm.elements.key.value = '';
  }
  const descriptors = [];
  if (info.lastSyncAt) descriptors.push(translateTemplate`最近检查 ${dateTime.format(new Date(info.lastSyncAt))}`);
  if (info.keyId) descriptors.push(translateTemplate`配对组 ${info.keyId.slice(0, 8)}`);
  if (info.lastError) descriptors.push(t(info.lastError));
  if (info.enabled && !info.peers.length && !info.lastError) descriptors.push(translateText('尚未接收到其他设备的用量'));
  byId('sync-note').textContent = descriptors.join(' · ');
  byId('sync-peer-list').hidden = !info.peers.length;
  byId('sync-peers').innerHTML = info.peers.map((peer) => translateTemplate`<tr>
    <td>${escapeHtml(peer.deviceName)}</td>
    <td>${peer.syncedAt ? dateTime.format(new Date(peer.syncedAt)) : '—'}</td>
    <td class="numeric total">${full(peer.count)}</td>
    <td><button class="ghost-btn record-remove" type="button" data-retire-device="${escapeHtml(peer.deviceId)}">清理本机副本</button></td>
  </tr>`).join('');
  const retired = info.retired ?? [];
  byId('sync-retired-list').hidden = retired.length === 0;
  byId('sync-retired').innerHTML = retired.map((peer) => translateTemplate`<tr>
    <td>${escapeHtml(peer.deviceName)}</td>
    <td><button class="ghost-btn record-remove" type="button" data-restore-device="${escapeHtml(peer.deviceId)}">恢复接收</button></td>
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

async function updateFolderSync(endpoint, config, populate = false, options) {
  if (syncBusy) return;
  syncBusy = true;
  const buttons = get('#sync-form button');
  for (const button of buttons) button.disabled = true;
  byId('sync-note').textContent = translateText('正在处理同步…');
  try {
    const { pairingKey, ...info } = await request(endpoint, config, options);
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

function bindSync() {
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
  byId('sync-peers').addEventListener('click', (event) => {
    const { retireDevice } = event.target.closest('[data-retire-device]')?.dataset ?? {};
    if (!retireDevice || !window.confirm(translateText('清除此设备在本机的同步记录并停止接收？'))) return;
    if (state.device === retireDevice) state.device = '';
    void updateFolderSync(`sync/peers/${encodeURIComponent(retireDevice)}`, undefined, false, { method: 'DELETE' });
  });
  byId('sync-retired').addEventListener('click', (event) => {
    const { restoreDevice } = event.target.closest('[data-restore-device]')?.dataset ?? {};
    if (restoreDevice) void updateFolderSync('sync/restore-peer', { deviceId: restoreDevice });
  });
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
      byId('sync-note').textContent = translateText('配对密钥已复制');
    } catch {
      field.focus();
      field.select();
      byId('sync-note').textContent = translateText('密钥已选中，可按 Ctrl+C 复制');
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
        byId('sync-note').textContent = translateText('无法打开文件夹选择器。可以直接输入路径。');
      }
    });
  }
}

export { bindSync, readSyncInfo, showPairingKey };
