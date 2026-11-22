import { t as translateText } from './i18n.js';
import { refreshLive, request } from './api.js';
import { state, today } from './state.js';
import { byId } from './ui.js';

const fields = ['dailyTokens', 'dailyUsd', 'monthlyTokens', 'monthlyUsd'];

export function bindPreferences() {
  const panel = byId('preferences-card');
  const form = byId('preferences-form');
  const status = byId('preferences-status');
  const rate = form.elements.cnyPerUsd;
  const submit = form.querySelector('button[type=submit]');
  const backup = byId('backup-file');
  const backupStatus = byId('backup-status');
  const exportButton = byId('export-backup');
  const restoreButton = byId('choose-backup');

  function syncCurrency() {
    rate.required = form.elements.currency.value === 'CNY';
  }

  function populate(settings) {
    for (const key of ['locale', 'currency', 'cnyPerUsd']) form.elements[key].value = settings[key] ?? '';
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
        budgets: Object.fromEntries(fields.map((name) => [name, number(name)])),
      });
      if (preferences.locale !== state.preferences?.locale) {
        location.reload();
        return;
      }
      state.preferences = preferences;
      status.textContent = translateText('偏好已保存。');
      await refreshLive();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    try {
      const data = await request('backup/export', {});
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: `tokenstat-backup-${today()}.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
      backupStatus.textContent = translateText('备份已导出。');
    } catch (error) {
      backupStatus.textContent = error.message;
    } finally {
      exportButton.disabled = false;
    }
  });

  restoreButton.addEventListener('click', () => backup.click());
  backup.addEventListener('change', async () => {
    const file = backup.files[0];
    backup.value = '';
    if (!file) return;
    if (file.size > 128 * 1024 * 1024) {
      backupStatus.textContent = translateText('备份文件超过 128 MiB。');
      return;
    }
    if (!window.confirm(translateText('恢复备份中的自定义路径与单价，并合并导入记录？'))) return;
    restoreButton.disabled = true;
    backupStatus.textContent = translateText('正在恢复备份…');
    try {
      let data;
      try { data = JSON.parse(await file.text()); }
      catch { throw new Error(translateText('备份文件必须为有效的 JSON。')); }
      await request('backup/restore', data);
      if (data.preferences && (data.preferences.locale !== state.preferences?.locale
        || data.preferences.timeZone !== state.preferences?.timeZone)) {
        location.reload();
        return;
      }
      backupStatus.textContent = translateText('备份已恢复并重新扫描。');
      await refreshLive();
    } catch (error) {
      backupStatus.textContent = error.message;
    } finally {
      restoreButton.disabled = false;
    }
  });
}
