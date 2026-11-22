import { watch } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectLocal, localLogTargets, localWatchRoots } from './lib/local-sources.mjs';
import { parseUsageFile } from './lib/imports.mjs';
import { defaultRates, estimateRows, estimateTotals, normalizeRate, priceIdentity, pricingBasis } from './lib/pricing.mjs';
import { openStore } from './lib/store.mjs';
import { createSync } from './lib/sync.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/charts.js', ['charts.js', 'text/javascript; charset=utf-8']],
  ['/calendar.js', ['calendar.js', 'text/javascript; charset=utf-8']],
  ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
]);

const localProviders = ['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo'];
const providers = [...localProviders, 'other'];
const maxBody = 16 * 1024 * 1024;
const watchDebounce = 750;
const pollInterval = 60_000;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function userDataDir() {
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'TokenStat');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'TokenStat');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tokenstat');
}

async function readJson(request) {
  if (Number(request.headers['content-length']) > maxBody) {
    request.resume();
    throw new RequestError('文件太大，请拆分后导入。', 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= maxBody) chunks.push(chunk);
  }
  if (bytes > maxBody) throw new RequestError('文件太大，请拆分后导入。', 413);
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new RequestError('请求内容必须是 JSON 对象。');
  }
}

function send(response, status, value, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

function calendarDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    throw new RequestError('日期请使用 YYYY-MM-DD。');
  }
  const instant = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new RequestError('日期无效。');
  }
  return value;
}

function bucketOptions(query) {
  const from = query.has('from') ? calendarDate(query.get('from')) : undefined;
  const to = query.has('to') ? calendarDate(query.get('to')) : undefined;
  const granularity = query.get('granularity') || 'day';
  if (from && to && from > to) throw new RequestError('开始日期不能晚于结束日期。');
  if (granularity !== 'day' && granularity !== 'week') throw new RequestError('聚合单位应为 day 或 week。');
  return { from, to, granularity };
}

function checkedInput(parse) {
  try {
    return parse();
  } catch (error) {
    throw new RequestError(error.message);
  }
}

export async function startServer({
  port = Number(process.env.TOKENSTAT_PORT ?? 4317),
  dataDir = process.env.TOKENSTAT_DATA_DIR || userDataDir(),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TOKENSTAT_PORT 必须是有效的端口。');
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const store = await openStore(dataDir);
  const subscribers = new Set();
  const watchers = new Map();
  const views = new Map();
  let status = store.getScanStatus();
  let revision = 0;
  let watchVersion = 0;
  let watchSettings;
  let scheduledScan;
  let scheduledSync;
  let pendingScan;
  let fullQueued = false;
  let queuedFiles = new Map();
  let queuedFileCount = 0;
  let auditQueued = false;
  let stopping = false;
  let cleanup;
  let shutdown;
  let heartbeat;
  let poll;
  let url;
  const folderSync = createSync(store, { onChange: changed });

  function streamWrite(response, frame) {
    if (!response.destroyed && !response.write(frame)) response.destroy();
  }

  function changed() {
    views.clear();
    const message = `id: ${++revision}\nevent: usage\ndata: ${JSON.stringify({ revision, syncedAt: status?.syncedAt })}\n\n`;
    for (const response of subscribers) streamWrite(response, message);
  }

  async function runFolderSync() {
    await folderSync.run();
    for (const response of subscribers) streamWrite(response, 'event: sync\ndata: {}\n\n');
    return folderSync.status();
  }

  function scheduleFolderSync(delay = 30_000) {
    if (stopping || scheduledSync || !store.getSyncConfig()?.enabled) return;
    scheduledSync = setTimeout(() => {
      scheduledSync = undefined;
      void runFolderSync().catch((error) => console.error('[TokenStat] 文件夹同步失败', error.message));
    }, delay).unref();
  }

  function scheduleScan(delay = watchDebounce) {
    if (stopping) return;
    if (scheduledScan) return;
    scheduledScan = setTimeout(() => {
      scheduledScan = undefined;
      void runScanQueue().catch((error) => console.error('[TokenStat] 自动扫描失败', error.message));
    }, delay);
    scheduledScan.unref();
  }

  function enqueueFile(path) {
    const targets = localLogTargets(path, watchSettings);
    if (!targets.length || fullQueued) return;
    for (const [provider, file] of targets) {
      if (!queuedFiles.has(provider)) queuedFiles.set(provider, new Set());
      const paths = queuedFiles.get(provider);
      if (!paths.has(file)) {
        paths.add(file);
        queuedFileCount++;
      }
    }
    if (queuedFileCount > 256) {
      fullQueued = true;
      queuedFiles.clear();
      queuedFileCount = 0;
    }
    scheduleScan();
  }

  async function updateWatchers() {
    const version = ++watchVersion;
    watchSettings = { paths: store.getPaths() };
    const roots = new Set(localWatchRoots(watchSettings));
    for (const [path, watcher] of watchers) {
      if (!roots.has(path)) {
        watchers.delete(path);
        watcher.close();
      }
    }
    await Promise.all([...roots].filter((path) => !watchers.has(path)).map(async (path) => {
      try {
        const metadata = await stat(path);
        if (stopping || version !== watchVersion || watchers.has(path)) return;
        const watcher = watch(path, { recursive: metadata.isDirectory(), persistent: false }, (_event, filename) => {
          if (stopping) return;
          if (!metadata.isDirectory() || filename) enqueueFile(metadata.isDirectory() ? resolve(path, filename) : path);
        });
        watcher.on('error', () => {
          if (watchers.get(path) === watcher) watchers.delete(path);
          watcher.close();
        });
        if (metadata.isFile()) watcher.on('change', (event) => {
          if (event === 'rename' && watchers.get(path) === watcher) {
            watchers.delete(path);
            watcher.close();
          }
        });
        watchers.set(path, watcher);
      } catch {
        // Missing roots and filesystems without watching support are picked up by the polling path.
      }
    }));
  }

  function runScanQueue() {
    if (stopping) return pendingScan ?? Promise.resolve();
    if (pendingScan) return pendingScan;
    if (!fullQueued && !queuedFiles.size) return Promise.resolve();
    pendingScan = (async () => {
      do {
        const files = fullQueued || !status ? undefined : queuedFiles;
        fullQueued = false;
        queuedFiles = new Map();
        queuedFileCount = 0;
        const revalidate = auditQueued;
        auditQueued = false;
        const { sources, changed: updated } = await collectLocal({ paths: store.getPaths() }, {
          cache: store.cache, revalidate, changedFiles: files, previousSources: status?.sources,
        });
        const sourcesChanged = JSON.stringify(sources) !== JSON.stringify(status?.sources);
        if (updated || sourcesChanged) {
          status = { sources, syncedAt: new Date().toISOString() };
          store.setScanStatus(status);
          changed();
        }
        if (updated) scheduleFolderSync();
      } while ((fullQueued || queuedFiles.size) && !stopping);
    })().catch((error) => {
      views.clear();
      throw error;
    }).finally(() => { pendingScan = undefined; });
    return pendingScan;
  }

  function refresh(audit = false) {
    fullQueued = true;
    auditQueued ||= audit;
    return runScanQueue();
  }

  function usageView(timeZone, options) {
    const key = JSON.stringify([timeZone, options.from, options.to, options.granularity]);
    let view = views.get(key);
    if (!view) {
      const entries = estimateRows(store.readUsage(timeZone, options), store.getPriceOverrides());
      view = { entries, ...estimateTotals(entries) };
      if (views.size >= 12) views.delete(views.keys().next().value);
      views.set(key, view);
    }
    return view;
  }

  async function snapshot(timeZone, options) {
    if (!status) await (pendingScan ?? refresh());
    return {
      ...usageView(timeZone, options),
      sources: status?.sources ?? [],
      paths: store.getPaths(),
      imports: store.getImports(),
      syncedAt: status?.syncedAt ?? null,
      revision,
    };
  }

  function listenEvents(request, response) {
    if (request.headers.origin && request.headers.origin !== url) {
      throw new RequestError('事件流只允许本机页面连接。', 403);
    }
    if (subscribers.size >= 32) throw new RequestError('本地事件连接数已满。', 503);
    response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    subscribers.add(response);
    response.once('close', () => subscribers.delete(response));
    streamWrite(response, `retry: 2500\nevent: ready\ndata: ${JSON.stringify({ revision })}\n\n`);
  }

  const server = createServer(async (request, response) => {
    try {
      if (stopping) throw new RequestError('本地服务正在关闭。', 503);
      if (request.headers.host !== new URL(url).host || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new RequestError('请从本机地址打开 TokenStat。', 403);
      }
      const target = new URL(request.url, url);
      if (target.origin !== url) throw new RequestError('请求地址无效。', 403);

      const get = request.method === 'GET';
      const route = target.pathname;
      const query = target.searchParams;
      if (get && files.has(route)) {
        const [name, type] = files.get(route);
        return send(response, 200, await readFile(join(publicDir, name)), type);
      }
      if (get && route === '/api/events') return listenEvents(request, response);

      let timeZone;
      try {
        timeZone = new Intl.DateTimeFormat('en', { timeZone: query.get('timeZone') || undefined }).resolvedOptions().timeZone;
      } catch {
        throw new RequestError('时区无效。');
      }

      if (get && route === '/api/usage') return send(response, 200, await snapshot(timeZone, bucketOptions(query)));
      if (get && route === '/api/day') {
        const date = calendarDate(query.get('date'));
        if (!status) await (pendingScan ?? refresh());
        const complete = views.get(JSON.stringify([timeZone, undefined, undefined, 'day']));
        const entries = complete
          ? complete.entries.filter((entry) => entry.date === date)
          : usageView(timeZone, { from: date, to: date, granularity: 'day' }).entries;
        return send(response, 200, { date, timeZone, ...store.readDay(timeZone, date), ...estimateTotals(entries), revision });
      }
      if (get && route === '/api/pricing') return send(response, 200, { defaultRates, overrides: store.getPriceOverrides(), currency: 'USD', pricingBasis });
      if (get && route === '/api/sync') return send(response, 200, folderSync.status());
      if (request.method !== 'POST' && request.method !== 'DELETE') throw new RequestError('找不到该页面。', 404);
      if (request.headers.origin !== url ||
          (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json'))) {
        throw new RequestError('请通过 TokenStat 页面执行此操作。', 403);
      }

      if (request.method === 'DELETE') {
        if (route === '/api/pricing') {
          const { provider, model } = checkedInput(() => priceIdentity(query.get('provider'), query.get('model'), providers));
          const overrides = store.getPriceOverrides().filter((rate) => rate.provider !== provider || rate.model !== model);
          store.setPriceOverrides(overrides);
          changed();
          return send(response, 200, { defaultRates, overrides, currency: 'USD', pricingBasis });
        }
        const match = /^\/api\/imports\/([\w-]+)$/.exec(route);
        if (match) {
          const result = store.deleteImport(match[1]);
          if (!result) throw new RequestError('找不到可移除的导入批次。', 404);
          changed();
          scheduleFolderSync();
          return send(response, 200, result);
        }
        throw new RequestError('找不到该操作。', 404);
      }

      const body = await readJson(request);
      if (route === '/api/sync/settings') {
        let settings;
        try {
          settings = await folderSync.configure({
            enabled: body.enabled, folder: body.folder, deviceName: body.deviceName, key: body.key,
          });
        } catch (error) {
          throw new RequestError(error.message);
        }
        if (settings.enabled && !status) await (pendingScan ?? refresh());
        const info = settings.enabled ? await runFolderSync() : folderSync.status();
        return send(response, 200, { ...info, ...(settings.pairingKey ? { pairingKey: settings.pairingKey } : {}) });
      }
      if (route === '/api/sync/run') {
        if (!store.getSyncConfig()?.enabled) throw new RequestError('请先启用跨设备同步。');
        if (!status) await (pendingScan ?? refresh());
        return send(response, 200, await runFolderSync());
      }
      if (route === '/api/sync/pairing-key') {
        const pairingKey = store.getSyncConfig()?.key;
        if (!pairingKey) throw new RequestError('请先配置跨设备同步。');
        return send(response, 200, { pairingKey });
      }
      if (route === '/api/refresh') {
        await refresh(query.get('full') === 'true');
        return send(response, 200, await snapshot(timeZone, bucketOptions(query)));
      }
      if (route === '/api/settings') {
        const { provider, path } = body;
        if (!localProviders.includes(provider) || typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/u.test(path)) {
          throw new RequestError('请输入有效的本地日志路径。');
        }
        store.setPath(provider, path.trim());
        void updateWatchers();
        await refresh();
        return send(response, 200, await snapshot(timeZone, bucketOptions(query)));
      }
      if (route === '/api/pricing') {
        const rate = checkedInput(() => normalizeRate(body, providers));
        const overrides = store.getPriceOverrides().filter((entry) => entry.provider !== rate.provider || entry.model !== rate.model);
        if (overrides.length >= 500) throw new RequestError('最多支持 500 项自定义单价。');
        overrides.push(rate);
        store.setPriceOverrides(overrides);
        changed();
        return send(response, 200, { defaultRates, overrides, currency: 'USD', pricingBasis });
      }
      if (route === '/api/import') {
        const { filename, content, provider } = body;
        if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || typeof content !== 'string') {
          throw new RequestError('请上传 JSON、JSONL 或 CSV 用量文件。');
        }
        const records = checkedInput(() => parseUsageFile({ filename, content, provider }));
        if (query.get('dryRun') === 'true') return send(response, 200, store.previewImport(records));
        const result = store.importBatch(filename, records);
        if (result.added) {
          changed();
          scheduleFolderSync();
        }
        return send(response, 200, result);
      }
      throw new RequestError('找不到该操作。', 404);
    } catch (error) {
      if (!error.status) console.error('[TokenStat]', error);
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : '操作失败，请查看本地终端日志并重试。' });
    }
  });

  function stopMonitoring() {
    stopping = true;
    clearTimeout(scheduledScan);
    clearTimeout(scheduledSync);
    clearInterval(poll);
    clearInterval(heartbeat);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const response of subscribers) response.end();
  }

  function dispose() {
    if (!cleanup) {
      stopMonitoring();
      cleanup = (async () => {
        await pendingScan?.catch(() => {});
        try {
          await folderSync.close();
        } finally {
          store.close();
        }
      })();
    }
    return cleanup;
  }

  function close() {
    if (!shutdown) {
      stopMonitoring();
      shutdown = new Promise((resolveClosed, reject) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClosed());
      }).finally(dispose);
    }
    return shutdown;
  }

  server.once('close', () => { void dispose().catch((error) => console.error('[TokenStat]', error)); });

  try {
    await new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        url = `http://127.0.0.1:${server.address().port}`;
        resolveListening();
      });
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  void updateWatchers();
  fullQueued = true;
  scheduleScan(status ? 400 : 25);
  scheduleFolderSync(1000);
  poll = setInterval(() => {
    void updateWatchers();
    fullQueued = true;
    scheduleScan(0);
    scheduleFolderSync(0);
  }, pollInterval).unref();
  heartbeat = setInterval(() => {
    for (const response of subscribers) streamWrite(response, ': keep-alive\n\n');
  }, 15_000).unref();
  return { server, url, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { url, close } = await startServer();
    console.log(`TokenStat 已启动 · ${url}`);
    const shutdown = () => {
      void close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
