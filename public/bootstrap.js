import { localizePage, setLocale } from './js/i18n.js';

let preferredLocale = document.documentElement.lang;
try {
  preferredLocale = localStorage.getItem('tokenstat.locale') ?? preferredLocale;
} catch {
  // A restricted browser can still use the preferences saved in the local service.
}
try {
  const response = await fetch('/api/preferences', { cache: 'no-store' });
  if (response.ok) {
    const { preferences } = await response.json();
    if (preferences?.locale) preferredLocale = preferences.locale;
    if (preferences?.timeZone) document.documentElement.dataset.timeZone = preferences.timeZone;
  }
} catch {
  // The main app reports connection errors using the last available language.
}
const selectedLocale = setLocale(preferredLocale);
try {
  localStorage.setItem('tokenstat.locale', selectedLocale);
} catch {
  // The service still keeps the selected language.
}
localizePage(document);
await import('./app.js');
