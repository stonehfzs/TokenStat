import { t as translateText, tr as translateTemplate } from './i18n.js';
import { load } from './api.js';
import { exportUsage } from './import.js';
import { renderOverview } from './overview.js';
import { rows, state } from './state.js';
import { byId, escapeHtml, icon } from './ui.js';

let actions;

function buildCommandItems(query) {
  const q = query.trim().toLowerCase();
  const base = [
    { id: 'nav-overview', title: translateText('前往 · 用量总览'), cat: translateText('页面'), icon: 'grid', run: () => { location.hash = 'overview'; } },
    { id: 'nav-daily', title: translateText('前往 · 每日记录'), cat: translateText('页面'), icon: 'calendar', run: () => { location.hash = 'daily'; } },
    { id: 'nav-sources', title: translateText('前往 · 数据来源'), cat: translateText('页面'), icon: 'database', run: () => { location.hash = 'sources'; } },
    { id: 'nav-import', title: translateText('前往 · 导入记录'), cat: translateText('页面'), icon: 'upload', run: () => { location.hash = 'import'; } },
    { id: 'act-sync', title: translateText('同步本地用量日志'), cat: translateText('操作'), icon: 'refresh', run: () => load('refresh', {}) },
    { id: 'act-demo', title: state.demo ? translateText('关闭示例数据，返回真实记录') : translateText('开启示例数据预览'), cat: translateText('操作'), icon: 'flask', run: () => actions.setDemo(!state.demo) },
    { id: 'act-theme', title: state.theme === 'dark' ? translateText('切换为浅色主题') : translateText('切换为深色主题'), cat: translateText('外观'), icon: state.theme === 'dark' ? 'sun' : 'moon', run: () => actions.applyTheme(state.theme === 'dark' ? 'light' : 'dark') },
    { id: 'act-area', title: translateText('趋势图切换为「面积图」'), cat: translateText('图表'), icon: 'chart', run: () => { state.chartStyle = 'area'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-bar', title: translateText('趋势图切换为「柱状图」'), cat: translateText('图表'), icon: 'chart', run: () => { state.chartStyle = 'bar'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-line', title: translateText('趋势图切换为「折线图」'), cat: translateText('图表'), icon: 'chart', run: () => { state.chartStyle = 'line'; location.hash = 'overview'; renderOverview(); } },
    { id: 'act-export', title: translateText('导出当前周期 CSV'), cat: translateText('数据'), icon: 'download', run: () => exportUsage(state.page === 'daily' ? 'daily' : 'overview') },
  ];

  // Dynamic model search items
  const modelNames = [...new Set(rows().map((e) => e.model).filter(Boolean))];
  const modelItems = modelNames.map((m) => ({
    id: `model-${m}`,
    title: translateTemplate`筛选模型 · ${m}`,
    cat: translateText('模型'),
    icon: 'spark',
    run: () => {
      state.tableQuery = m;
      const input = byId('table-search');
      if (input) input.value = m;
      location.hash = 'overview';
      renderOverview();
      byId('provider-table')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  }));

  const all = [...base, ...modelItems];
  return q ? all.filter((item) => item.title.toLowerCase().includes(q) || item.cat.toLowerCase().includes(q)) : all.slice(0, 10);
}

function renderCommandList() {
  const query = byId('cmd-input').value;
  state.cmdItems = buildCommandItems(query);
  state.cmdIndex = Math.min(state.cmdIndex, Math.max(0, state.cmdItems.length - 1));
  const list = byId('cmd-list');
  if (!state.cmdItems.length) {
    list.innerHTML = translateText('<div class="cmd-empty">没有匹配的命令或模型</div>');
    return;
  }
  list.innerHTML = state.cmdItems.map((item, idx) => `
    <button type="button" class="cmd-item${idx === state.cmdIndex ? ' active' : ''}" role="option" data-cmd-idx="${idx}">
      <span class="cmd-item-left">${icon(item.icon)}<span class="cmd-item-title">${escapeHtml(item.title)}</span></span>
      <span class="cmd-item-cat">${item.cat}</span>
    </button>
  `).join('');
}

function openCommandPalette() {
  state.cmdOpen = true;
  state.cmdIndex = 0;
  const modal = byId('cmd-modal');
  const input = byId('cmd-input');
  modal.hidden = false;
  input.value = '';
  renderCommandList();
  input.focus();
}

function closeCommandPalette() {
  state.cmdOpen = false;
  byId('cmd-modal').hidden = true;
}

function runCommand(idx) {
  const item = state.cmdItems[idx];
  closeCommandPalette();
  item?.run();
}

function bindCmd(callbacks) {
  actions = callbacks;
  byId('cmd-trigger').addEventListener('click', openCommandPalette);
  byId('cmd-modal').addEventListener('click', (event) => {
    if (event.target === byId('cmd-modal')) closeCommandPalette();
    const btn = event.target.closest('[data-cmd-idx]');
    if (btn) runCommand(Number(btn.dataset.cmdIdx));
  });
  byId('cmd-input').addEventListener('input', () => { state.cmdIndex = 0; renderCommandList(); });
  byId('cmd-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (state.cmdItems.length) {
        state.cmdIndex = (state.cmdIndex + 1) % state.cmdItems.length;
        renderCommandList();
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (state.cmdItems.length) {
        state.cmdIndex = (state.cmdIndex - 1 + state.cmdItems.length) % state.cmdItems.length;
        renderCommandList();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(state.cmdIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandPalette();
    }
  });
}

export { bindCmd, closeCommandPalette, openCommandPalette };
