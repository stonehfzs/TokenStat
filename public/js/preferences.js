import { locale, t as translateText } from './i18n.js';
import { refreshLive, request } from './api.js';
import { state, timeZone, today } from './state.js';
import { byId } from './ui.js';

const fields = ['dailyTokens', 'dailyUsd', 'monthlyTokens', 'monthlyUsd'];

export function bindPreferences(syncVisualEffects) {
  const panel = byId('preferences-card');
  const form = byId('preferences-form');
  const status = byId('preferences-status');
  const rate = form.elements.cnyPerUsd;
  const submit = form.querySelector('button[type=submit]');

  function syncCurrency() {
    rate.required = form.elements.currency.value === 'CNY';
  }

  function populate(settings) {
    for (const key of ['locale', 'currency', 'cnyPerUsd']) form.elements[key].value = settings[key] ?? '';
    form.elements.visualEffects.value = settings.visualEffects ?? 'full';
    for (const key of fields) form.elements[key].value = settings.budgets[key] ?? '';
    syncCurrency();
  }

  panel.addEventListener('toggle', async () => {
    if (!panel.open) return;
    try {
      const { preferences, notifications } = await request('preferences');
      populate(preferences);
      byId('budget-hint').textContent = notifications
        ? translateText('桌面应用会在预算达到 80% 和 100% 时提醒。预算留空可关闭。')
        : translateText('预算设置保存在本机。系统通知由桌面应用发送。');
    } catch (error) {
      status.textContent = error.message;
    }
  });

  form.elements.currency.addEventListener('change', syncCurrency);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const number = (name) => form.elements[name].value === '' ? null : form.elements[name].valueAsNumber;
    try {
      const { preferences } = await request('preferences', {
        locale: form.elements.locale.value,
        currency: form.elements.currency.value,
        cnyPerUsd: number('cnyPerUsd'),
        visualEffects: form.elements.visualEffects.value,
        budgets: Object.fromEntries(fields.map((name) => [name, number(name)])),
      });
      if (preferences.locale !== state.preferences?.locale) {
        location.reload();
        return;
      }
      state.preferences = preferences;
      syncVisualEffects(preferences.visualEffects);
      status.textContent = translateText('偏好已保存。');
      await refreshLive();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  bindBackup(populate);
}

function bindBackup(populate) {
  const input = byId('backup-file');
  const status = byId('backup-status');
  const exportButton = byId('export-backup');
  const restoreButton = byId('choose-backup');
  const confirmButton = byId('confirm-backup-restore');
  const cancelButton = byId('cancel-backup-restore');
  const downloads = byId('backup-downloads');
  const downloadList = byId('backup-download-list');
  const preview = byId('backup-preview');
  const previewList = byId('backup-preview-items');
  const english = locale === 'en-US';
  const wording = (zh, en) => english ? en : zh;
  const number = new Intl.NumberFormat(locale);
  const volumeLimit = 16 * 1024 * 1024;
  const legacyLimit = 128 * 1024 * 1024;
  let pending;
  let exportId;

  byId('backup-help').textContent = wording(
    '备份包括自定义路径、单价、偏好和本机导入记录。恢复时请选择一个备份文件或同一组的全部分卷。',
    'Backups include custom paths, model rates, preferences, and local imports. Select one backup file or all volumes from the same backup to restore.',
  );
  confirmButton.textContent = wording('确认恢复', 'Confirm restore');
  previewList.setAttribute('aria-label', wording('备份恢复预检', 'Backup restore preview'));
  downloadList.setAttribute('aria-label', wording('备份分卷下载', 'Backup volume downloads'));

  function setBusy(busy) {
    for (const control of [input, exportButton, restoreButton, confirmButton, cancelButton]) control.disabled = busy;
  }

  async function discardTransfer(id) {
    if (id) await request('backup/transfers/' + encodeURIComponent(id), undefined, { method: 'DELETE' }).catch(() => {});
  }

  async function clearPreview() {
    const id = pending?.id;
    pending = undefined;
    preview.hidden = true;
    previewList.replaceChildren();
    await discardTransfer(id);
  }

  function showDownloads(data) {
    const links = document.createDocumentFragment();
    for (const part of data.parts) {
      const url = new URL(part.url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/backup/volumes/')) {
        throw new Error(wording('备份下载地址无效。', 'Invalid backup download URL.'));
      }
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = url.href;
      link.download = part.filename;
      link.textContent = part.filename;
      row.append(link);
      links.append(row);
    }
    downloadList.replaceChildren(links);
    byId('backup-download-hint').textContent = wording(
      `备份共有 ${number.format(data.partCount)} 个分卷。请逐个下载，恢复时一起选中。`,
      `This backup has ${number.format(data.partCount)} volumes. Download each one and select them together when restoring.`,
    );
    downloads.hidden = false;
  }

  function showPreview(summary) {
    const verified = summary.volumes?.verified
      ? [[wording('已校验分卷', 'Verified volumes'), `${number.format(summary.volumes.received)} / ${number.format(summary.volumes.expected)}`]]
      : [];
    const rows = [
      ...verified,
      [wording('新增导入记录', 'New imported records'), number.format(summary.added)],
      [wording('跳过的重复记录', 'Duplicate records to skip'), number.format(summary.duplicate)],
      [wording('更新日志路径', 'Log path changes'), number.format(summary.paths)],
      [wording('更新自定义单价', 'Custom rate changes'), number.format(summary.priceOverrides)],
      [wording('更新应用偏好', 'Preference changes'), number.format(summary.preferences)],
    ];
    previewList.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      const data = document.createElement('span');
      name.textContent = label;
      data.textContent = value;
      row.append(name, data);
      return row;
    }));
    preview.hidden = false;
    status.textContent = wording('预检完成。请确认恢复。', 'Backup checked. Review the changes before restoring.');
  }

  async function readBackup(file, limit) {
    if (file.size > limit) {
      const size = limit / (1024 * 1024);
      throw new Error(wording(`备份文件超过 ${size} MiB。`, `The backup file exceeds ${size} MiB.`));
    }
    try { return JSON.parse(await file.text()); }
    catch { throw new Error(wording('备份文件必须为有效的 JSON。', 'The backup must be valid JSON.')); }
  }

  exportButton.addEventListener('click', async () => {
    setBusy(true);
    status.textContent = wording('正在准备备份…', 'Preparing backup…');
    downloads.hidden = true;
    downloadList.replaceChildren();
    try {
      await discardTransfer(exportId);
      exportId = undefined;
      const data = await request('backup/export', {});
      if (data.format === 'tokenstat-backup-download') {
        exportId = data.backupId;
        showDownloads(data);
        status.textContent = wording('备份分卷已就绪。', 'Backup volumes are ready.');
      } else {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement('a'), { href: url, download: `tokenstat-backup-${today()}.json` });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 2500);
        status.textContent = wording('备份已导出。', 'Backup exported.');
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });

  restoreButton.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;

    setBusy(true);
    status.textContent = wording('正在预检备份…', 'Checking backup…');
    let id;
    try {
      await clearPreview();
      let first = await readBackup(files[0], files.length === 1 ? legacyLimit : volumeLimit);
      let endpoint = 'backup/restore';
      let data = first;
      if (first?.format === 'tokenstat-backup-volume' && first.version === 2) {
        if (files[0].size > volumeLimit) {
          throw new Error(wording('备份分卷超过 16 MiB。', 'A backup volume exceeds 16 MiB.'));
        }
        ({ id } = await request('backup/transfers', {}));
        const transfer = 'backup/transfers/' + encodeURIComponent(id);
        data = {};
        for (const [index, file] of files.entries()) {
          const volume = index === 0 ? first : await readBackup(file, volumeLimit);
          if (index === 0) first = undefined;
          const { received, expected } = await request(transfer + '/volume', volume);
          status.textContent = wording(
            `已接收 ${number.format(received)} / ${number.format(expected)} 个分卷。`,
            `Received ${number.format(received)} of ${number.format(expected)} volumes.`,
          );
        }
        endpoint = transfer + '/restore';
      } else if (files.length !== 1 || first?.format !== 'tokenstat-backup' || first.version !== 1) {
        throw new Error(wording('请选择一个备份文件或同一组的全部分卷。', 'Select one backup file or all volumes from the same backup.'));
      }
      const result = await request(endpoint, data, { query: { dryRun: 'true' } });
      showPreview(result);
      pending = { id, endpoint, data };
    } catch (error) {
      status.textContent = error.message;
      await discardTransfer(id);
    } finally {
      setBusy(false);
    }
  });

  cancelButton.addEventListener('click', async () => {
    setBusy(true);
    try {
      await clearPreview();
      status.textContent = wording('已取消恢复。', 'Restore canceled.');
    } finally {
      setBusy(false);
    }
  });

  confirmButton.addEventListener('click', async () => {
    if (!pending) return;
    const restore = pending;
    setBusy(true);
    status.textContent = wording('正在恢复备份…', 'Restoring backup…');
    try {
      const result = await request(restore.endpoint, restore.data);
      pending = undefined;
      preview.hidden = true;
      previewList.replaceChildren();
      const restored = result.refreshFailed
        ? wording('备份已恢复。采集重扫失败，可在「来源」重试。', 'Backup restored. The source scan failed. Retry it from Sources.')
        : wording('备份已恢复并重新扫描。', 'Backup restored and sources rescanned.');
      status.textContent = restored + ' ' + wording(
        `新增 ${number.format(result.added)} 条，跳过 ${number.format(result.duplicate)} 条重复记录。`,
        `Added ${number.format(result.added)} records and skipped ${number.format(result.duplicate)} duplicates.`,
      );
      try {
        const { preferences } = await request('preferences');
        if (preferences.locale !== (english ? 'en' : 'zh-CN') || preferences.timeZone !== timeZone) {
          location.reload();
          return;
        }
        state.preferences = preferences;
        populate(preferences);
        await refreshLive(true);
      } catch {
        location.reload();
      }
    } catch (error) {
      status.textContent = error.message;
      await clearPreview();
    } finally {
      setBusy(false);
    }
  });
}
