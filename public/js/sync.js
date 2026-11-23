import { locale, t as translateText, tr as translateTemplate } from './i18n.js';
import { refreshLive, request } from './api.js';
import { dateTime, full, state } from './state.js';
import { byId, escapeHtml, get } from './ui.js';

const syncStates = {
  disabled: translateText('未启用'), ready: translateText('已启用'), syncing: translateText('同步中'), ok: translateText('已同步'), offline: translateText('文件夹不可用'), error: translateText('同步异常'),
};

const syncForm = byId('sync-form');

const verificationStates = {
  available: ['文件可用', 'Files available'],
  pending: ['等待检查', 'Awaiting check'],
  paused: ['已暂停', 'Paused'],
  ok: ['校验通过', 'Verified'],
  verified: ['已校验', 'verified'],
  repaired: ['已修复', 'Repaired'],
  attention: ['需要处理', 'Needs attention'],
  offline: ['不可用', 'Unavailable'],
  disabled: ['未启用', 'Disabled'],
  error: ['校验失败', 'Verification failed'],
  stale: ['版本较旧', 'Older revision'],
  legacy: ['旧版快照', 'Legacy snapshot'],
  retired: ['已退役', 'Retired'],
  empty: ['无记录', 'empty'],
  missing: ['文件缺失', 'File missing'],
  corrupt: ['校验未通过', 'Integrity check failed'],
  unreadable: ['文件不可读', 'File unreadable'],
};

const verificationReasons = {
  'manifest-missing': ['未找到同步清单。', 'The manifest is missing.'],
  'manifest-invalid': ['同步清单格式或内容无效。', 'The manifest format or content is invalid.'],
  'manifest-authentication-failed': ['同步清单无法通过解密认证。', 'The manifest failed authentication during decryption.'],
  'manifest-unreadable': ['同步清单暂时无法读取。', 'The manifest could not be read.'],
  'snapshot-missing': ['未找到设备快照。', 'The device snapshot is missing.'],
  'snapshot-invalid': ['设备快照格式或内容无效。', 'The snapshot format or content is invalid.'],
  'snapshot-authentication-failed': ['设备快照无法通过解密认证。', 'The snapshot failed authentication during decryption.'],
  'snapshot-unreadable': ['设备快照暂时无法读取。', 'The snapshot could not be read.'],
  'shard-missing': ['共享目录中尚未收到该月文件。', 'The shared folder has not received this month’s file.'],
  'shard-invalid': ['该月文件的格式或内容校验失败。', 'This month’s file failed a format or content check.'],
  'shard-authentication-failed': ['该月文件无法通过解密认证。', 'This month’s file failed authentication during decryption.'],
  'shard-unreadable': ['该月文件暂时不可读。', 'This month’s file could not be read.'],
  'pending-months': ['正在等待共享目录同步，已有用量保留。', 'Waiting for shared files. Previously received usage is still available.'],
  'invalid-months': ['部分月份无法校验，已有用量保留。', 'Some months could not be verified. Previously received usage is still available.'],
  'local-version-older': ['本机版本早于共享清单，未写入修复。', 'This device is behind the shared manifest. No repair was written.'],
  'older-revision': ['共享文件版本较旧，已有用量保留。', 'The shared file is older. Previously received usage is still available.'],
  'legacy-after-upgrade': ['仅找到旧版文件，已保留较新的用量。', 'Only a legacy file was found. Newer usage is still available.'],
  'legacy-snapshot': ['已校验旧版设备快照。', 'The legacy snapshot was verified.'],
  'device-file-missing': ['共享目录中未找到此设备的同步文件。', 'This device has no sync file in the shared folder.'],
  'device-retired': ['本机已停止接收此设备。', 'This computer no longer receives updates from this device.'],
  'local-month-changed': ['本机该月用量已变化，请先立即同步。', 'Local usage for this month has changed. Sync now before repairing.'],
  'local-revision-changed': ['校验期间本机用量更新，请重试。', 'Local usage changed during verification. Try again.'],
  'manifest-changed': ['共享清单正在更新，请重试。', 'The shared manifest changed during verification. Try again.'],
  'repair-write-failed': ['未能写入修复分片。', 'The repaired monthly file could not be written.'],
  'repair-manifest-failed': ['未能提交修复清单。', 'The repaired manifest could not be published.'],
  'rebuilt-from-local-data': ['已使用本机记录重建。', 'Rebuilt from usage on this computer.'],
  'sync-disabled': ['请先启用跨设备同步。', 'Enable device sync before verifying.'],
  'folder-offline': ['同步文件夹暂时不可用。', 'The sync folder is unavailable.'],
  'verification-unavailable': ['暂时无法校验同步文件。', 'Sync files could not be verified.'],
  'device-limit': ['设备数超过校验上限。', 'The device count exceeds the verification limit.'],
};

let syncInfo;
let syncBusy = false;
let verificationReport;
let verificationDetails = new Map();
let renderedReport;
let renderedVerification;
let syncReadVersion = 0;

const chooseText = (zh, en) => locale === 'en-US' ? en : zh;
const statusText = (value) => Object.hasOwn(verificationStates, value)
  ? chooseText(...verificationStates[value]) : chooseText('未校验', 'Not verified');
const reasonText = (reason) => Object.hasOwn(verificationReasons, reason) ? chooseText(...verificationReasons[reason]) : '';

function monthDetails(months) {
  return months.map(({ month, state, reason, previousReason }) => {
    const description = [reasonText(previousReason), reasonText(reason)].filter(Boolean).join(' ');
    return `<li><strong>${escapeHtml(month)}</strong> · ${escapeHtml(statusText(state))}
      ${description ? ` <span class="insight-note">${escapeHtml(description)}</span>` : ''}</li>`;
  }).join('');
}

function renderVerifiedDevice(device, index) {
  const months = Array.isArray(device.months) ? device.months : [];
  const detailedStates = new Set(['missing', 'corrupt', 'unreadable', 'repaired']);
  const affected = months.filter((item) => detailedStates.has(item.state));
  const verifiedCount = months.filter((item) => item.state === 'verified').length;
  const repairedCount = months.filter((item) => item.state === 'repaired').length;
  const emptyCount = months.filter((item) => item.state === 'empty').length;
  const affectedCount = device.issueMonths == null ? affected.length : device.issueMonths + repairedCount;
  const monthCounts = [
    verifiedCount && chooseText(`${full(verifiedCount)} 月已校验`, `${full(verifiedCount)} verified`),
    repairedCount && chooseText(`${full(repairedCount)} 月已修复`, `${full(repairedCount)} repaired`),
    emptyCount && chooseText(`${full(emptyCount)} 月无记录`, `${full(emptyCount)} empty`),
  ].filter(Boolean).join(' · ');
  let details = '';
  if (affected.length) {
    if (affected.length <= 3 && affectedCount === affected.length) {
      details = `<ul>${monthDetails(affected)}</ul>`;
    } else {
      verificationDetails.set(String(index), affected);
      const label = chooseText(`查看 ${full(affectedCount)} 个月份的详情`, `View details for ${full(affectedCount)} months`);
      const truncated = affectedCount > affected.length
        ? `<p class="insight-note">${escapeHtml(chooseText('运行完整校验查看全部月份。', 'Run verification to see the complete list.'))}</p>` : '';
      details = `<details data-sync-verification-months="${index}"><summary>${escapeHtml(label)}</summary><ul></ul>${truncated}</details>`;
    }
  }
  const deviceName = device.deviceName ?? chooseText('未知设备', 'Unknown device');
  const ownLabel = device.local ? chooseText('（本机）', ' (this computer)') : '';
  const description = reasonText(device.reason);
  return `<tr><th scope="row">${escapeHtml(deviceName)}${escapeHtml(ownLabel)}</th>
    <td><strong>${escapeHtml(statusText(device.status))}</strong>
      ${description ? `<p class="insight-note">${escapeHtml(description)}</p>` : ''}</td>
    <td>${monthCounts ? `<p class="insight-note">${escapeHtml(monthCounts)}</p>` : ''}${details || (monthCounts ? '' : '—')}</td></tr>`;
}

function showVerification(info) {
  const latest = info.lastVerification;
  if (info.report) verificationReport = info.report;
  else if (latest?.checkedAt !== verificationReport?.checkedAt) verificationReport = undefined;
  const issues = info.peerIssues ?? [];
  const visibleIssues = issues.filter((issue) =>
    !verificationReport?.devices.some((device) => device.deviceId === issue.deviceId)
      || Date.parse(issue.checkedAt) > Date.parse(verificationReport.checkedAt));
  const presentation = JSON.stringify([locale, latest, visibleIssues.map(({ checkedAt, ...issue }) => issue)]);
  if (renderedReport === verificationReport && renderedVerification === presentation) return;
  renderedReport = verificationReport;
  renderedVerification = presentation;
  const devices = new Map((verificationReport?.devices ?? []).map((device) => [device.deviceId, device]));
  for (const issue of visibleIssues) devices.set(issue.deviceId, issue);
  const summary = [];
  if (latest) {
    const checkedAt = new Date(latest.checkedAt);
    if (Number.isFinite(checkedAt.getTime())) {
      const time = dateTime.format(checkedAt);
      summary.push(chooseText(`最近校验 ${time}`, `Last verified ${time}`));
    }
    summary.push(statusText(latest.status));
    if (latest.repairedMonths > 0) {
      const count = full(latest.repairedMonths);
      summary.push(chooseText(`已修复 ${count} 个月份`, `Repaired ${count} ${latest.repairedMonths === 1 ? 'month' : 'months'}`));
    }
    const reason = reasonText(latest.reason);
    if (reason) summary.push(reason);
  } else if (issues.length) {
    summary.push(chooseText('发现同步问题', 'Sync issues found'));
  }
  if ([...devices.values()].some((device) => !device.local && device.status === 'attention')) {
    summary.push(chooseText('其他设备的文件请在对应设备修复。', 'Repair files from other devices on those devices.'));
  }

  byId('sync-verification').hidden = !summary.length && !devices.size;
  byId('sync-verification-note').textContent = summary.join(' · ');
  byId('sync-verification-table').hidden = !devices.size;
  verificationDetails = new Map();
  byId('sync-verification-devices').innerHTML = [...devices.values()].map(renderVerifiedDevice).join('');
}

function showSyncInfo(info, populate = false) {
  syncInfo = info;
  byId('sync-state').textContent = !info.enabled && info.configured ? translateText('已暂停') : syncStates[info.state] ?? translateText('跨设备同步');
  byId('save-sync').textContent = info.enabled ? translateText('保存并同步') : translateText('启用并同步');
  byId('disable-sync').hidden = !info.enabled;
  byId('run-sync').hidden = !info.enabled;
  byId('verify-sync').hidden = !info.enabled;
  byId('reveal-sync-key').hidden = !info.configured;
  if (populate) {
    syncForm.elements.folder.value = info.folder ?? '';
    syncForm.elements.deviceName.value = info.deviceName ?? '';
    syncForm.elements.key.value = '';
  }
  const descriptors = [];
  if (info.lastSyncAt) descriptors.push(translateTemplate`最近检查 ${dateTime.format(new Date(info.lastSyncAt))}`);
  if (info.keyId) descriptors.push(translateTemplate`配对组 ${info.keyId.slice(0, 8)}`);
  if (info.lastError) descriptors.push(translateText(info.lastError));
  if (info.enabled && !info.peers.length && !info.lastError) descriptors.push(translateText('尚未接收到其他设备的用量'));
  byId('sync-note').textContent = descriptors.join(' · ');
  showVerification(info);
  byId('sync-peer-list').hidden = !info.peers.length;
  const peerIssues = new Map((info.peerIssues ?? []).map(({ deviceId, status }) => [deviceId, status]));
  byId('sync-peers').innerHTML = info.peers.map((peer) => {
    const availability = peer.available == null ? 'pending' : peer.available ? 'available' : 'offline';
    const health = !info.enabled ? 'paused' : info.state === 'offline' ? 'offline' : peerIssues.get(peer.deviceId) ?? availability;
    return translateTemplate`<tr>
      <td>${escapeHtml(peer.deviceName)}<p class="insight-note">${escapeHtml(statusText(health))}</p></td>
      <td>${peer.syncedAt ? dateTime.format(new Date(peer.syncedAt)) : '—'}</td>
      <td class="numeric total">${full(peer.count)}</td>
      <td><button class="ghost-btn record-remove" type="button" data-retire-device="${escapeHtml(peer.deviceId)}">清理本机副本</button></td>
    </tr>`;
  }).join('');
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
  const version = ++syncReadVersion;
  try {
    const info = await request('sync');
    if (!syncBusy && version === syncReadVersion) showSyncInfo(info, populate || !syncInfo);
  } catch (error) {
    if (!syncBusy && version === syncReadVersion) byId('sync-note').textContent = error.message;
  }
}

async function updateFolderSync(endpoint, config, populate = false, options) {
  if (syncBusy) return;
  syncBusy = true;
  syncReadVersion++;
  for (const button of get('#sync-card button')) button.disabled = true;
  const verifying = endpoint === 'sync/verify';
  byId('sync-note').textContent = verifying
    ? chooseText('正在校验各设备的同步文件…', 'Verifying sync files for each device…')
    : translateText('正在处理同步…');
  try {
    const { pairingKey, ...info } = await request(endpoint, config, options);
    showSyncInfo(info, populate);
    if (pairingKey) showPairingKey(pairingKey);
    if (!verifying) void refreshLive();
  } catch (error) {
    byId('sync-note').textContent = error.message;
  } finally {
    syncBusy = false;
    for (const button of get('#sync-card button')) button.disabled = false;
  }
}

function bindSync() {
  byId('verify-sync').textContent = chooseText('校验并修复同步', 'Verify and repair sync');
  byId('sync-verification-title').textContent = chooseText('同步校验', 'Sync verification');
  byId('sync-verify-device').textContent = chooseText('设备', 'Device');
  byId('sync-verify-result').textContent = chooseText('校验结果', 'Verification result');
  byId('sync-verify-months').textContent = chooseText('月份', 'Months');
  byId('sync-verification-devices').addEventListener('toggle', (event) => {
    const detail = event.target;
    if (!detail.open || !detail.hasAttribute('data-sync-verification-months')) return;
    const months = verificationDetails.get(detail.dataset.syncVerificationMonths);
    const list = detail.querySelector('ul');
    if (months && !list.hasChildNodes()) list.innerHTML = monthDetails(months);
  }, true);
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
  byId('verify-sync').addEventListener('click', () => { void updateFolderSync('sync/verify', {}); });
  byId('sync-peers').addEventListener('click', (event) => {
    if (syncBusy) return;
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
