import { setTimeout as wait } from 'node:timers/promises';

const messages = {
  'zh-CN': {
    today: '今日', estimate: 'API 估算', sync: '立即同步', syncing: '正在同步…', syncError: '同步失败，重试',
    launch: '打开 TokenStat', autostart: '开机自启动', quit: '退出 TokenStat',
  },
  en: {
    today: 'Today', estimate: 'API estimate', sync: 'Sync now', syncing: 'Syncing…', syncError: 'Sync failed, retry',
    launch: 'Open TokenStat', autostart: 'Start at login', quit: 'Quit TokenStat',
  },
};

function normalizeSummary(data) {
  if (!Number.isSafeInteger(data?.totalTokens) || data.totalTokens < 0) return null;
  return {
    totalTokens: data.totalTokens,
    estimatedCost: Number.isFinite(data.estimatedCost) && data.estimatedCost >= 0 ? data.estimatedCost : null,
    displayCost: typeof data.displayCost === 'string' && data.displayCost.length <= 64 ? data.displayCost : null,
    locale: data.locale === 'en' ? 'en' : 'zh-CN',
    syncEnabled: data.syncEnabled === true,
  };
}

export function describeTray(summary) {
  const locale = summary?.locale ?? 'zh-CN';
  const strings = messages[locale] ?? messages['zh-CN'];
  const tokens = summary ? new Intl.NumberFormat(locale).format(summary.totalTokens) : '—';
  const cost = summary?.estimatedCost == null ? '—' : summary.displayCost || new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'USD', maximumFractionDigits: 6,
  }).format(summary.estimatedCost);
  return { ...strings, usageLine: `${strings.today} ${tokens} Token`, costLine: `${strings.estimate} ${cost}` };
}

export function watchTrayUsage(origin, onChange, fetchResponse = fetch) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let pending;
  let updating = false;
  let repeat = false;

  function queueRefresh() {
    if (signal.aborted) return;
    if (updating) repeat = true;
    else pending ??= setTimeout(() => { void refresh(); }, 200).unref();
  }

  async function refresh() {
    pending = undefined;
    updating = true;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetchResponse(`${origin}/api/tray?timeZone=${encodeURIComponent(timezone)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) return;
      const summary = normalizeSummary(await response.json());
      if (summary && !signal.aborted) onChange(summary);
    } catch {
      // An early refresh can fail while the backend starts. The stream reconnects.
    } finally {
      updating = false;
      if (repeat) {
        repeat = false;
        queueRefresh();
      }
    }
  }

  async function listen() {
    while (!signal.aborted) {
      let reader;
      try {
        const response = await fetchResponse(origin + '/api/events', { signal });
        if (response.ok && response.body) {
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = (buffer + decoder.decode(value, { stream: true })).split('\n');
            buffer = lines.pop().slice(-4096);
            if (lines.some((line) => /^event:\s*(?:ready|usage)\s*$/.test(line))) queueRefresh();
          }
        } else {
          await response.body?.cancel();
        }
      } catch {
        // The server can close the stream during desktop shutdown or restart.
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (!signal.aborted) await wait(2500, undefined, { signal, ref: false }).catch(() => {});
    }
  }

  // The selected reporting time zone can differ from the computer's local time.
  const calendar = setInterval(queueRefresh, 60_000).unref();
  queueRefresh();
  void listen();

  return {
    async syncNow() {
      try {
        const response = await fetchResponse(origin + '/api/sync/run', {
          method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
          signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        });
        return response.ok && (await response.json()).state !== 'error';
      } catch {
        return false;
      } finally {
        queueRefresh();
      }
    },
    close() {
      lifetime.abort();
      clearTimeout(pending);
      clearInterval(calendar);
    },
  };
}
