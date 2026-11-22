import { createDayFormatter } from '../public/calendar.js';

export const budgetKeys = ['dailyTokens', 'dailyUsd', 'monthlyTokens', 'monthlyUsd'];

export const defaultPreferences = {
  locale: 'zh-CN',
  currency: 'USD',
  cnyPerUsd: null,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  budgets: { dailyTokens: null, dailyUsd: null, monthlyTokens: null, monthlyUsd: null },
};

export function normalizePreferences(input, previous = defaultPreferences) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('偏好格式无效。');
  const choices = {
    locale: input.locale ?? previous.locale,
    currency: input.currency ?? previous.currency,
    cnyPerUsd: input.cnyPerUsd === undefined ? previous.cnyPerUsd : input.cnyPerUsd,
    timeZone: input.timeZone ?? previous.timeZone,
  };
  if (!['zh-CN', 'en'].includes(choices.locale)) throw new Error('不支持该界面语言。');
  if (!['USD', 'CNY'].includes(choices.currency)) throw new Error('币种必须为 USD 或 CNY。');
  if ((choices.cnyPerUsd != null && (!Number.isFinite(choices.cnyPerUsd) || choices.cnyPerUsd <= 0 || choices.cnyPerUsd > 1000))
    || (choices.currency === 'CNY' && choices.cnyPerUsd == null)) {
    throw new Error('请填写有效的自定义美元兑人民币汇率。');
  }
  try {
    if (typeof choices.timeZone !== 'string') throw new Error();
    choices.timeZone = new Intl.DateTimeFormat('en', { timeZone: choices.timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error('时区无效。');
  }
  if (input.budgets != null && (typeof input.budgets !== 'object' || Array.isArray(input.budgets))) {
    throw new Error('预算格式无效。');
  }
  choices.budgets = {};
  for (const key of budgetKeys) {
    const value = Object.hasOwn(input.budgets ?? {}, key) ? input.budgets[key] : previous.budgets?.[key];
    if (value == null || value === 0) {
      choices.budgets[key] = null;
    } else {
      if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER
        || (key.endsWith('Tokens') && !Number.isSafeInteger(value))) throw new Error('预算须为正数，Token 预算须为整数。');
      choices.budgets[key] = value;
    }
  }
  return choices;
}

export function displayMoney(value, { currency, cnyPerUsd, locale }) {
  if (value == null) return null;
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 4,
  }).format(value * (currency === 'CNY' ? cnyPerUsd : 1));
}

export function usagePeriods(preferences, now = new Date()) {
  const day = createDayFormatter(preferences.timeZone)(now);
  return { day, month: day.slice(0, 7), monthStart: day.slice(0, 7) + '-01' };
}

export function budgetAlerts(preferences, previous, periods, { day, month }) {
  const english = preferences.locale === 'en';
  const state = Object.fromEntries(budgetKeys.flatMap((key) => {
    const period = key.startsWith('daily') ? periods.day : periods.month;
    const notification = previous[key];
    return notification?.period === period && notification.limit === preferences.budgets[key] ? [[key, notification]] : [];
  }));
  const alerts = [];
  for (const key of budgetKeys) {
    const daily = key.startsWith('daily');
    const tokens = key.endsWith('Tokens');
    const stats = daily ? day : month;
    const used = tokens ? stats?.coverage.totalTokens : stats?.estimatedCost;
    const limit = preferences.budgets[key];
    if (!limit || used == null || used < limit * 0.8) continue;
    const level = used >= limit ? 100 : 80;
    if (state[key]?.level >= level) continue;
    const period = daily ? periods.day : periods.month;
    const label = english ? (daily ? 'Daily' : 'Monthly') : (daily ? '每日' : '每月');
    const unit = tokens ? 'Token' : (english ? 'API cost' : 'API 等值费用');
    const amount = (value) => tokens ? new Intl.NumberFormat(preferences.locale).format(value) : displayMoney(value, preferences);
    const title = english ? `${label} ${unit} budget reached ${level}%` : `${label}${unit}预算已达 ${level}%`;
    const body = english ? `${amount(used)} used · limit ${amount(limit)}` : `已用 ${amount(used)} · 上限 ${amount(limit)}`;
    alerts.push({ key, mark: { period, limit, level }, title, body });
  }
  return { state, alerts };
}
