import { t as translateText } from './js/i18n.js';
import { bindApi, connectEvents, load } from './js/api.js';
import { bindCmd, closeCommandPalette, openCommandPalette } from './js/cmd.js';
import { bindDaily, dateBounds, renderDaily, resetDayDetails, selectDay, updateDay } from './js/daily.js';
import { bindImport, renderImportPills, renderImports } from './js/import.js';
import { bindOverview, renderOverview } from './js/overview.js';
import { bindDevices, renderDevices } from './js/devices.js';
import { bindPreferences } from './js/preferences.js';
import { bindPricing } from './js/pricing.js';
import { bindSources, installDesktopPreferences, renderSources } from './js/sources.js';
import { dateMillis, offsetDay, pageNames, pageOrder, reducedMotion, rows, state, timeZone } from './js/state.js';
import { bindSync, readSyncInfo, showPairingKey } from './js/sync.js';
import { byId, get, hydrateStaticIcons, svgMarkup, syncAllGliders } from './js/ui.js';

function initTheme() {
  let saved = 'dark';
  try {
    const stored = localStorage.getItem('tokenstat-theme');
    if (stored === 'light' || stored === 'dark') saved = stored;
  } catch { /* ignore */ }
  applyTheme(saved, false);
}

function applyTheme(theme, persist = true) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f3f5fa' : '#040508';
  const themeIcon = byId('theme-icon');
  if (themeIcon) {
    themeIcon.dataset.icon = theme === 'dark' ? 'sun' : 'moon';
    themeIcon.innerHTML = svgMarkup(theme === 'dark' ? 'sun' : 'moon');
  }
  if (persist) {
    try { localStorage.setItem('tokenstat-theme', theme); } catch { /* ignore */ }
  }
  if (state.page === 'overview') renderOverview();
}

function updateLiveStatus() {
  const status = byId('local-status');
  status.classList.toggle('busy', state.busy);
  status.classList.toggle('failed', Boolean(state.error));
  status.querySelector('span').textContent = state.busy ? translateText('同步中') : state.error ? translateText('异常') : state.live ? translateText('实时') : translateText('本地');
}

function render() {
  updateLiveStatus();
  renderDevices();

  byId('load-error').hidden = !state.error;
  byId('load-error-text').textContent = state.error;
  byId('demo-toggle').setAttribute('aria-pressed', state.demo);
  byId('demo-notice').hidden = !state.demo;

  for (const button of get('.sync-button')) {
    button.disabled = state.busy;
    button.classList.toggle('is-syncing', state.busy);
  }

  if (state.page === 'overview') renderOverview();
  if (state.page === 'daily') renderDaily();
  if (state.page === 'sources' && !document.activeElement?.matches('#source-grid input')) renderSources();
  if (state.page === 'import') renderImports();
  hydrateStaticIcons();
}

function navigate(scroll = true, instantGlider = false) {
  const [page, date] = location.hash.slice(1).split('/');
  state.page = Object.hasOwn(pageNames, page) ? page : 'overview';
  if (state.page === 'daily' && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateMillis(date))) {
    selectDay(date);
  }
  for (const key of Object.keys(pageNames)) byId(`page-${key}`).hidden = key !== state.page;
  for (const link of get('[data-page]')) {
    if (link.dataset.page === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${pageNames[state.page]} · TokenStat`;
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.page !== 'sources') showPairingKey();
  render();
  if (page === 'sources' && date === 'pricing') {
    byId('pricing-card').open = true;
    requestAnimationFrame(() => byId('pricing-card').scrollIntoView({ block: 'start' }));
  }
  if (page === 'sources' && date === 'sync') {
    byId('sync-card').open = true;
    requestAnimationFrame(() => byId('sync-card').scrollIntoView({ block: 'start' }));
  } else if (state.page === 'sources' && byId('sync-card').open) {
    void readSyncInfo();
  }
  requestAnimationFrame(() => syncAllGliders(instantGlider));
}

function setDemo(enabled) {
  state.demo = enabled;
  render();
}

window.addEventListener('hashchange', () => navigate(true, false));

byId('time-zone').textContent = timeZone;

byId('theme-toggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));

byId('demo-toggle').addEventListener('click', () => setDemo(!state.demo));

byId('exit-demo').addEventListener('click', () => setDemo(false));

get('.sync-button').forEach((button) => button.addEventListener('click', () => load('refresh', {})));

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.cmdOpen) closeCommandPalette();
    else openCommandPalette();
    return;
  }
  if (state.cmdOpen) {
    if (event.key === 'Escape') closeCommandPalette();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;

  if (event.key >= '1' && event.key <= '4') {
    const target = pageOrder[Number(event.key) - 1];
    if (target && target !== state.page) location.hash = target;
  } else if (event.key === 'r' || event.key === 'R') {
    load('refresh', {});
  } else if (state.page === 'daily' && event.key === '[') {
    updateDay(offsetDay(state.day, -1));
  } else if (state.page === 'daily' && event.key === ']') {
    const { max } = dateBounds(rows());
    if (state.day < max) updateDay(offsetDay(state.day, 1));
  }
});

document.addEventListener('pointerdown', (event) => {
  if (reducedMotion()) return;
  const target = event.target.closest('.primary-pill, .ghost-pill, .icon-pill, .outline-btn, .cmd-trigger, .topnav a');
  if (!target || target.disabled) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const wave = document.createElement('span');
  wave.className = 'ripple';
  wave.style.width = `${size}px`;
  wave.style.height = `${size}px`;
  wave.style.left = `${event.clientX - rect.left - size / 2}px`;
  wave.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.append(wave);
  wave.addEventListener('animationend', () => wave.remove(), { once: true });
}, { passive: true });

bindApi({ render, resetDayDetails, updateLiveStatus, readSyncInfo });
bindCmd({ setDemo, applyTheme });
bindOverview();
bindDaily();
bindSources();
bindSync();
bindImport();
bindPricing();
bindPreferences();
bindDevices();
initTheme();
hydrateStaticIcons();

installDesktopPreferences();

renderImportPills();

navigate(false, true);

load();

connectEvents();
