import { t as translateText } from './i18n.js';
import { createDayFormatter } from '../calendar.js';
import { demoUsage } from '../demo.js';

const timeZone = document.documentElement.dataset.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

const formatDay = createDayFormatter(timeZone);

const fullDate = new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { timeZone: 'UTC', dateStyle: 'long' });

const dateTime = new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const clockTime = new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { timeZone, hour: '2-digit', minute: '2-digit' });

const abbreviated = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

const precise = new Intl.NumberFormat(document.documentElement.lang || 'zh-CN');

const percent = new Intl.NumberFormat(document.documentElement.lang || 'zh-CN', { style: 'percent', maximumFractionDigits: 1 });

let moneyCode, moneyFormatter;
const money = {
  format(value) {
    const settings = state.preferences;
    const code = settings?.currency === 'CNY' && settings.cnyPerUsd > 0 ? 'CNY' : 'USD';
    if (code !== moneyCode) {
      moneyCode = code;
      moneyFormatter = new Intl.NumberFormat(document.documentElement.lang || 'zh-CN', {
        style: 'currency', currency: code, maximumFractionDigits: 6,
      });
    }
    return moneyFormatter.format(value * (code === 'CNY' ? settings.cnyPerUsd : 1));
  },
};

const full = (value) => precise.format(value);

const compact = (value) => value >= 1000 ? abbreviated.format(value) : full(value);

const oneDay = 86400000;

const weekdays = [translateText('周日'), translateText('周一'), translateText('周二'), translateText('周三'), translateText('周四'), translateText('周五'), translateText('周六')];

const fields = ['input', 'output', 'cached', 'reasoning', 'total'];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const providers = [
  { id: 'codex', name: 'Codex', cssVar: '--c-codex', fallback: '#2dd4bf', icon: 'code', client: translateText('Codex 会话日志'), path: '~/.codex' },
  { id: 'gemini', name: 'Antigravity', cssVar: '--c-gemini', fallback: '#60a5fa', icon: 'spark', client: translateText('Gemini / Antigravity 本地用量'), path: '~/.gemini/antigravity' },
  { id: 'grok', name: 'Grok', cssVar: '--c-grok', fallback: '#c084fc', icon: 'grok', client: translateText('Grok Build 会话日志'), path: '~/.grok' },
  { id: 'claude', name: 'Claude Code', cssVar: '--c-claude', fallback: '#fbbf24', icon: 'sun', client: translateText('Claude Code 项目日志'), path: '~/.claude/projects' },
  { id: 'gemini-cli', name: 'Gemini CLI', cssVar: '--c-gemini-cli', fallback: '#818cf8', icon: 'code', client: translateText('Gemini CLI 历史会话'), path: '~/.gemini/tmp' },
  { id: 'cline', name: 'Cline', cssVar: '--c-cline', fallback: '#f472b6', icon: 'database', client: translateText('Cline 会话与编辑器任务用量'), path: '~/.cline/data/sessions' },
  { id: 'roo', name: 'Roo Code', cssVar: '--c-roo', fallback: '#fb923c', icon: 'database', client: translateText('编辑器扩展的 Roo Code 任务用量'), path: 'User/globalStorage/rooveterinaryinc.roo-cline/tasks' },
  { id: 'other', name: translateText('其他'), cssVar: '--c-other', fallback: '#94a3b8', icon: 'database' },
];

const ioSeriesMeta = [
  { id: 'input', name: translateText('输入 Token'), cssVar: '--c-input', fallback: '#38bdf8' },
  { id: 'output', name: translateText('输出 Token'), cssVar: '--c-output', fallback: '#34d399' },
];

const importOptions = [
  { id: 'auto', name: translateText('自动识别'), icon: 'spark' },
  ...providers,
];

const providerById = new Map(providers.map((provider) => [provider.id, provider]));

const priceFields = ['input', 'cached', 'cacheWrite', 'output', 'reasoning'];

const pageNames = { overview: translateText('总览'), daily: translateText('每日'), sources: translateText('来源'), import: translateText('导入') };

const pageOrder = ['overview', 'daily', 'sources', 'import'];

const statusLabels = { connected: translateText('已连接'), missing: translateText('未检测到'), error: translateText('读取失败'), unsupported: translateText('可手动导入'), loading: translateText('扫描中') };

const state = {
  snapshot: null,
  device: '',
  preferences: null,
  live: false,
  demo: false,
  theme: 'dark',
  page: 'overview',
  range: '30',
  chartStyle: 'area',
  trendMode: 'provider',
  trendPage: 0,
  day: today(),
  historyPage: 0,
  expanded: new Set(),
  hiddenTools: new Set(),
  hiddenIo: new Set(),
  drafts: new Map(),
  importProvider: 'auto',
  tableQuery: '',
  busy: false,
  error: '',
  overviewTotal: 0,
  lastHeroValue: 0,
  overviewShares: [],
  cmdOpen: false,
  cmdIndex: 0,
  cmdItems: [],
};

function today() {
  return formatDay(new Date());
}

function dateMillis(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function offsetDay(date, offset) {
  return new Date(dateMillis(date) + offset * oneDay).toISOString().slice(0, 10);
}

function weekdayLabel(date) {
  return weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function relativeDayTag(date) {
  const now = today();
  if (date === now) return { label: translateText('今天'), isToday: true };
  if (date === offsetDay(now, -1)) return { label: translateText('昨天'), isToday: false };
  return { label: weekdayLabel(date), isToday: false };
}

function displayDate(date) {
  return fullDate.format(dateMillis(date));
}

function rows() {
  return state.demo ? demoUsage(today(), offsetDay) : state.snapshot?.entries ?? [];
}

export { clockTime, compact, dateMillis, dateTime, displayDate, fields, full, importOptions, ioSeriesMeta, offsetDay, oneDay, pageNames, pageOrder, percent, priceFields, providerById, providers, reducedMotion, relativeDayTag, rows, state, statusLabels, timeZone, today, money, weekdayLabel, weekdays };
