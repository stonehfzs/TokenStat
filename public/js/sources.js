import { locale, t as translateText, tr as translateTemplate } from './i18n.js';
import { load } from './api.js';
import { compact, dateTime, full, providers, state, statusLabels } from './state.js';
import { byId, escapeHtml, icon, isLoading, totals } from './ui.js';

const reasonLabels = {
  invalidJson: ['JSON 语法不完整', 'Malformed JSON'],
  invalidTimestamp: ['用量时间戳无效', 'Invalid usage timestamp'],
  oversizedLine: ['单行超出读取限制', 'Line exceeds size limit'],
  oversizedFile: ['文件超出读取限制', 'File exceeds size limit'],
  unclassified: ['未识别内容或旧缓存的未知原因', 'Unrecognized or legacy log entries'],
  missingPath: ['目录或文件不存在', 'Path not found'],
  invalidPath: ['路径类型无效', 'Invalid path type'],
  permissionDenied: ['权限不足', 'Permission denied'],
  changedDuringScan: ['文件正在写入', 'File changed during scan'],
  readError: ['读取失败', 'Read failure'],
};

function collectionDetails(source) {
  if (source?.scannedFiles == null) return '';
  const english = locale === 'en-US';
  const rows = [
    [english ? 'Last collected' : '最后成功采集', source.lastCollectedAt ? dateTime.format(new Date(source.lastCollectedAt)) : '—'],
    [english ? 'Files read' : '已读取文件', full(source.scannedFiles)],
    [english ? 'File or path failures' : '失败文件或路径', full(source.failedFiles)],
    [english ? 'Skipped log entries' : '跳过条数', full(source.skippedCount)],
  ];
  const reasons = [...Object.entries(source.skippedReasons), ...Object.entries(source.failedReasons)];
  return `<dl class="source-diagnostics">${rows.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    ${reasons.length ? `<details class="source-diagnostic-reasons">
      <summary>${english ? 'Collection issues' : '查看失败与跳过原因'}</summary>
      <ul>${reasons.map(([reason, count]) => `<li>${reasonLabels[reason]?.[english ? 1 : 0] ?? (english ? 'Other issue' : '其他原因')} · ${full(count)}</li>`).join('')}</ul>
    </details>` : ''}`;
}

function renderSources() {
  const realEntries = state.snapshot?.entries ?? [];
  byId('source-grid').innerHTML = providers.filter((provider) => provider.path).map((provider) => {
    const source = state.snapshot?.sources.find((candidate) => candidate.provider === provider.id);
    const status = source?.status || (state.busy ? 'loading' : 'missing');
    const savedPath = state.snapshot?.paths[provider.id] ?? '';
    const path = state.drafts.get(provider.id) ?? savedPath;
    const partial = source?.collectionState === 'partial';
    const unavailable = source?.collectionState === 'unavailable';
    const label = partial ? (locale === 'en-US' ? 'Partial data' : '采集不完整')
      : unavailable ? (locale === 'en-US' ? 'No usable records' : '暂无可用记录')
      : statusLabels[status] || translateText('待同步');
    const message = source?.scannedFiles != null && status === 'connected'
      ? (locale === 'en-US' ? `Collected ${full(source.count)} usage records` : `已读取 ${full(source.count)} 条用量记录`)
      : source?.message ? translateText(source.message) : (state.busy ? translateText('正在检测本机日志。') : translateText('同步后可查看检测结果。'));
    const localEntries = realEntries.filter((e) => e.provider === provider.id && e.source !== 'import' && !/^同步 · /u.test(e.source));
    const totalTokens = totals(localEntries).total;
    const activeDays = new Set(localEntries.map((e) => e.date)).size;
    const hasCustomPath = Boolean(path.trim() || savedPath.trim());

    return translateTemplate`<article class="card source-card" data-provider="${provider.id}">
      <div class="source-head">
        <div class="source-title">
          <span class="provider-badge" data-provider="${provider.id}">${icon(provider.icon)}</span>
          <div><h2>${provider.name}</h2><p>${provider.client}</p></div>
        </div>
        <span class="chip ${partial ? 'partial' : unavailable ? 'error' : status}"><i class="status-dot"></i>${label}</span>
      </div>
      <div class="source-stats">
        <div class="source-stat"><span>已扫描 Token</span><strong>${isLoading() || (state.device && state.device !== 'local') ? '—' : compact(totalTokens)}</strong></div>
        <div class="source-stat"><span>活跃天数</span><strong>${isLoading() || (state.device && state.device !== 'local') ? '—' : translateTemplate`${activeDays} 天`}</strong></div>
      </div>
      <p class="source-status">${escapeHtml(message)}</p>
      ${collectionDetails(source)}
      <form data-settings="${provider.id}">
        <label class="field-label" for="path-${provider.id}">自定义路径</label>
        <input class="field-input" name="path" id="path-${provider.id}" placeholder="${escapeHtml(provider.path)}" value="${escapeHtml(path)}" maxlength="4096" spellcheck="false" autocomplete="off">
        <div class="form-actions">
          <button class="outline-btn" type="submit" ${state.busy ? 'disabled' : ''}>保存并扫描</button>
          ${hasCustomPath ? translateTemplate`<button class="ghost-btn" type="button" data-reset-path="${provider.id}" ${state.busy ? 'disabled' : ''}>恢复默认</button>` : ''}
        </div>
      </form>
    </article>`;
  }).join('');
}

function installDesktopPreferences() {
  const desktop = window.tokenstatDesktop;
  if (!desktop) return;
  const checkbox = byId('desktop-autostart');
  const status = byId('desktop-autostart-status');
  let enabled = false;
  let pending = false;

  function apply(value) {
    enabled = value;
    checkbox.checked = enabled;
    status.textContent = enabled ? translateText('登录后在托盘启动') : translateText('关闭');
  }

  async function read() {
    if (pending) return;
    try {
      const value = await desktop.getAutostart();
      if (!pending) {
        apply(value);
        checkbox.disabled = false;
      }
    } catch {
      status.textContent = translateText('无法读取系统启动项');
    }
  }

  byId('desktop-preferences').hidden = false;
  desktop.onAutostartChanged(apply);
  window.addEventListener('focus', read);
  checkbox.addEventListener('change', async () => {
    pending = true;
    checkbox.disabled = true;
    try {
      apply(await desktop.setAutostart(checkbox.checked));
    } catch {
      checkbox.checked = enabled;
      status.textContent = translateText('无法更新，请检查系统启动项或应用位置');
    } finally {
      checkbox.disabled = false;
      pending = false;
    }
  });
  void read();
}

function bindSources() {
  byId('source-grid').addEventListener('input', (event) => {
    if (event.target.form?.dataset.settings) {
      state.drafts.set(event.target.form.dataset.settings, event.target.value);
    }
  });
  byId('source-grid').addEventListener('focusout', (event) => {
    if (event.target.matches('input') && !event.relatedTarget) {
      setTimeout(() => { if (state.page === 'sources' && !document.activeElement?.matches('#source-grid input')) renderSources(); }, 0);
    }
  });
  byId('source-grid').addEventListener('click', (event) => {
    const resetBtn = event.target.closest('[data-reset-path]');
    if (!resetBtn) return;
    const provider = resetBtn.dataset.resetPath;
    state.drafts.delete(provider);
    load('settings', { provider, path: '' });
  });
  byId('source-grid').addEventListener('submit', (event) => {
    event.preventDefault();
    load('settings', { provider: event.target.dataset.settings, path: new FormData(event.target).get('path') });
  });
}

export { bindSources, installDesktopPreferences, renderSources };
