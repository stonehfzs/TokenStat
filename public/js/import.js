import { tr as translateTemplate, t as translateText } from './i18n.js';
import { refreshLive, request } from './api.js';
import { period } from './overview.js';
import { dateTime, full, importOptions, providerById, rows, state, today } from './state.js';
import { byId, escapeHtml, get, icon, tableEmpty, toast } from './ui.js';

function renderImportPills() {
  const container = byId('import-provider-pills');
  if (!container) return;
  container.innerHTML = importOptions.map((opt) =>
    `<button class="provider-pill" type="button" role="radio" data-import-opt="${opt.id}" aria-checked="${state.importProvider === opt.id}">
      <span class="btn-icon">${icon(opt.icon)}</span>
      <span>${opt.name}</span>
    </button>`
  ).join('');
  byId('import-provider').value = state.importProvider;
}

function renderImports() {
  const imports = state.snapshot?.imports ?? [];
  byId('import-table').innerHTML = imports.length ? imports.map(({ id, filename, date, added, removable }) => `<tr>
    <td class="import-file" title="${escapeHtml(filename)}">${escapeHtml(filename)}</td>
    <td>${dateTime.format(new Date(date))}</td>
    <td class="numeric total">${full(added)}</td>
    <td>${removable ? translateTemplate`<button type="button" class="ghost-btn record-remove" data-import-id="${escapeHtml(id)}">撤回</button>` : translateText('<span class="insight-note">旧版记录</span>')}</td>
  </tr>`).join('') : tableEmpty(translateText('还没有导入记录。'), 4);
}

function csvCell(value) {
  let cell = String(value ?? '');
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

function download(name, lines) {
  const content = '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

const csvHeader = ['date', 'provider', 'model', 'input', 'output', 'cached', 'reasoning', 'total'];

function exportUsage(page) {
  const range = page === 'daily' ? null : period(rows());
  const data = range?.entries ?? rows().filter((entry) => entry.date === state.day);
  if (!data.length) return;
  const label = state.demo ? 'demo' : !range ? state.day : /^(?:month|last-month|custom)$/u.test(state.range)
    ? `${range.start}_${range.end}` : state.range;
  const lines = data.map((entry) => [...csvHeader.map((property) =>
    property === 'reasoning' && entry.withoutReasoning === entry.count ? '' : entry[property]), entry.cacheWrite ?? 0]);
  download(`tokenstat-${label}.csv`, [[...csvHeader, 'cache_write'], ...lines]);
  toast(translateTemplate`已导出 tokenstat-${label}.csv`);
}

let importing = false;

let importDraft;

function showImportState(message, failed = false) {
  const result = byId('import-result');
  result.hidden = !message;
  result.classList.toggle('failed', failed);
  result.textContent = message;
}

function setImportBusy(value) {
  importing = value;
  byId('choose-file').disabled = value;
  byId('confirm-import').disabled = value || !importDraft?.preview?.added;
  byId('cancel-import').disabled = value;
  for (const button of get('[data-import-opt]')) button.disabled = value;
}

async function previewImport() {
  byId('import-preview').hidden = true;
  showImportState(translateTemplate`正在预检 ${importDraft.filename}…`);
  importDraft.provider = state.importProvider;
  importDraft.preview = await request('import', importDraft, { query: { dryRun: true } });
  const { total, added, duplicate, models } = importDraft.preview;
  showImportState(translateTemplate`识别 ${full(total)} 条 · 新增 ${full(added)} 条 · 重复 ${full(duplicate)} 条`);
  const limit = 12;
  byId('import-models').innerHTML = models.slice(0, limit).map(({ provider, model, count }) =>
    `<li><span>${escapeHtml(providerById.get(provider)?.name ?? provider)} · ${escapeHtml(model ?? translateText('模型未记录'))}</span><strong>${full(count)}</strong></li>`
  ).join('') + (models.length > limit ? translateTemplate`<li>另有 ${full(models.length - limit)} 个模型分组</li>` : '');
  byId('import-preview').hidden = false;
}

async function importFiles(files) {
  if (!files.length || importing) return;
  importDraft = undefined;
  byId('import-preview').hidden = true;
  if (files.length !== 1 || files[0].size > 8 * 1024 * 1024) {
    showImportState(translateText('请选择一个不超过 8 MB 的文件。'), true);
    byId('file-picker').value = '';
    return;
  }
  setImportBusy(true);
  try {
    const file = files[0];
    importDraft = { filename: file.name, content: await file.text() };
    await previewImport();
  } catch (error) {
    showImportState(error.message || translateText('预检失败。'), true);
  } finally {
    setImportBusy(false);
    byId('file-picker').value = '';
  }
}

async function confirmImport() {
  if (importing || !importDraft?.preview?.added) return;
  setImportBusy(true);
  try {
    const { filename, content, provider } = importDraft;
    const data = await request('import', { filename, content, provider });
    importDraft = undefined;
    byId('import-preview').hidden = true;
    showImportState(data.added ? translateTemplate`已导入 ${full(data.added)} 条，跳过 ${full(data.total - data.added)} 条重复记录。` : translateText('记录均已存在。'));
    await refreshLive();
  } catch (error) {
    showImportState(error.message || translateText('导入失败。'), true);
  } finally {
    setImportBusy(false);
  }
}

const dropzone = byId('dropzone');

function bindImport() {
  get('.export-button').forEach((button) => button.addEventListener('click', () => exportUsage(button.dataset.export)));
  byId('import-provider-pills').addEventListener('click', async (event) => {
    const pill = event.target.closest('[data-import-opt]');
    if (!pill || importing || state.importProvider === pill.dataset.importOpt) return;
    state.importProvider = pill.dataset.importOpt;
    renderImportPills();
    if (!importDraft) return;
    setImportBusy(true);
    importDraft.preview = undefined;
    try { await previewImport(); }
    catch (error) { showImportState(error.message || translateText('预检失败。'), true); }
    finally { setImportBusy(false); }
  });
  byId('confirm-import').addEventListener('click', confirmImport);
  byId('cancel-import').addEventListener('click', () => {
    importDraft = undefined;
    byId('import-preview').hidden = true;
    showImportState('');
  });
  byId('import-table').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-import-id]');
    if (!button) return;
    const entry = state.snapshot?.imports.find(({ id }) => id === button.dataset.importId);
    if (!entry || !window.confirm(translateTemplate`撤回「${entry.filename}」新增的 ${full(entry.added)} 条记录？`)) return;
    button.disabled = true;
    try {
      const result = await request(`imports/${encodeURIComponent(entry.id)}`, undefined, { method: 'DELETE' });
      toast(translateTemplate`已撤回 ${full(result.removed)} 条导入记录`);
      await refreshLive();
    } catch (error) {
      showImportState(error.message || translateText('撤回失败。'), true);
      button.disabled = false;
    }
  });
  byId('choose-file').addEventListener('click', () => byId('file-picker').click());
  byId('file-picker').addEventListener('change', (event) => importFiles(event.target.files));
  byId('template-button').addEventListener('click', () => {
    download('tokenstat-template.csv', [
      csvHeader, [today(), 'gemini', 'gemini-2.5-pro', 1500, 320, 500, 0, 1820],
    ]);
    toast(translateText('已下载 CSV 模板'));
  });
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', (event) => { if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('dragging'); });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    importFiles(event.dataTransfer.files);
  });
}

export { bindImport, exportUsage, renderImportPills, renderImports };
