import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { MessageChannel } from 'node:worker_threads';
import { answerDesktopRequest, createDesktopBridge } from '../desktop/bridge.mjs';
import { createBudgetNotifier } from '../desktop/notifications.mjs';
import { describeTray, watchTrayUsage } from '../desktop/tray-usage.mjs';
import { createSyncVault } from '../desktop/vault.mjs';
import { loadWindowState, restoreWindowBounds } from '../desktop/window-state.mjs';

const pairingKey = Buffer.alloc(32, 42).toString('base64url');

function nativeVault({ tag = 'v11', backend = 'kwallet6' } = {}) {
  let requests = 0;
  const ciphertext = Buffer.from(tag + '-test-secret-ciphertext');
  return {
    get requests() { return requests; },
    getSelectedStorageBackend: () => backend,
    isAsyncEncryptionAvailable: async () => { requests++; return true; },
    encryptStringAsync: async () => { requests++; return ciphertext; },
    decryptStringAsync: async () => { requests++; return { result: pairingKey }; },
  };
}

test('desktop vault rejects Linux basic text and fixed-key ciphertext', async () => {
  const basic = nativeVault({ backend: 'basic_text' });
  const basicVault = createSyncVault(basic, 'linux');
  assert.equal(await basicVault.available(), false);
  await assert.rejects(basicVault.encrypt(pairingKey), /密钥库不可用/);
  assert.equal(basic.requests, 0);

  const fallback = createSyncVault(nativeVault({ tag: 'v10' }), 'linux');
  assert.equal(await fallback.available(), false);
  await assert.rejects(fallback.encrypt(pairingKey), /密钥库不可用/);
  await assert.rejects(fallback.decrypt(Buffer.from('v10-native fallback').toString('base64')), /格式无效/);
});

test('desktop vault round-trips protected keys and accepts platform-specific ciphertext', async () => {
  for (const [platform, tag] of [['linux', 'v11'], ['linux', 'v12'], ['win32', 'v10'], ['darwin', 'v10']]) {
    const vault = createSyncVault(nativeVault({ tag }), platform);
    assert.equal(await vault.available(), true);
    const encrypted = await vault.encrypt(pairingKey);
    assert.notEqual(encrypted, Buffer.from(pairingKey).toString('base64'));
    assert.equal(await vault.decrypt(encrypted), pairingKey);
  }
  const passthrough = nativeVault();
  passthrough.encryptStringAsync = async (key) => Buffer.from(key);
  await assert.rejects(createSyncVault(passthrough, 'win32').encrypt(pairingKey), /密钥库不可用/);
});

test('private worker bridge routes concurrent vault and budget operations', async (t) => {
  const { port1, port2 } = new MessageChannel();
  const worker = createDesktopBridge(port1);
  const service = {
    syncVault: createSyncVault(nativeVault(), 'linux'),
    notifyBudget: ({ title }) => title === 'TokenStat',
  };
  port2.on('message', async (message) => port2.postMessage(await answerDesktopRequest(message, service)));
  t.after(() => { worker.close(); port1.close(); port2.close(); });

  const [encrypted, displayed, available] = await Promise.all([
    worker.syncVault.encrypt(pairingKey), worker.notifyBudget({ title: 'TokenStat' }), worker.syncVault.available(),
  ]);
  assert.equal(available, true);
  assert.equal(displayed, true);
  assert.equal(await worker.syncVault.decrypt(encrypted), pairingKey);

  const failed = await answerDesktopRequest({ id: 41, method: 'vault-decrypt', value: 'invalid' }, service);
  assert.deepEqual(failed, { type: 'desktop-result', id: 41, ok: false, error: '无法使用系统密钥库。请解锁密钥库并重试。' });
  const waiting = worker.syncVault.available();
  worker.close();
  await assert.rejects(waiting, /已关闭/);
});

test('window geometry is clamped to a changed or smaller display', () => {
  const workArea = { x: 0, y: 20, width: 800, height: 600 };
  const screen = { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) };
  assert.deepEqual(restoreWindowBounds({ bounds: { x: 5000, y: 7000, width: 1000, height: 900 } }, screen), {
    ...workArea, minWidth: 365, minHeight: 580,
  });
  assert.deepEqual(restoreWindowBounds({ bounds: { x: 700, y: 33, width: 500, height: 590 } }, screen), {
    x: 300, y: 30, width: 500, height: 590, minWidth: 365, minHeight: 580,
  });
  const small = { getPrimaryDisplay: () => ({ workArea: { x: 20, y: 20, width: 280, height: 380 } }) };
  assert.deepEqual(restoreWindowBounds(null, small), { x: 20, y: 20, width: 280, height: 380, minWidth: 280, minHeight: 380 });
  const placeholder = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1, height: 1 } }) };
  assert.deepEqual(restoreWindowBounds(null, placeholder), { width: 1440, height: 1000, minWidth: 365, minHeight: 580 });
});

test('window state retains the newest normal geometry and maximized flag', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenstat-window-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'window-state.json'), 'invalid JSON');
  const preferences = await loadWindowState(directory);
  assert.equal(preferences.state, null);
  preferences.remember({ x: 30, y: 40, width: 700, height: 600 }, false);
  preferences.remember({ x: 90, y: 64, width: 720, height: 680 }, true);
  preferences.remember({ x: 1, y: 2, width: 0, height: 400 }, false);
  await preferences.flush();
  const saved = { bounds: { x: 90, y: 64, width: 720, height: 680 }, maximized: true };
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'window-state.json'), 'utf8')), saved);
  assert.deepEqual((await loadWindowState(directory)).state, saved);
});

test('native tray responds to usage SSE and issues a same-origin sync request', async (t) => {
  const origin = 'http://127.0.0.1:4317';
  const received = [];
  let controller;
  let summaryCount = 0;
  const sample = { totalTokens: 12_345, estimatedCost: 1.25, displayCost: '€1.06', locale: 'en', syncEnabled: true };
  const encode = (frame) => new TextEncoder().encode(frame);
  const monitor = watchTrayUsage(origin, (usage) => received.push(usage), async (url, request) => {
    const page = new URL(url);
    assert.equal(page.origin, origin);
    if (page.pathname === '/api/events') {
      return new Response(new ReadableStream({
        start(events) {
          controller = events;
          request.signal.addEventListener('abort', () => { try { events.close(); } catch {} }, { once: true });
        },
      }));
    }
    if (page.pathname === '/api/sync/run') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.origin, origin);
      assert.equal(request.headers['content-type'], 'application/json');
      return Response.json({ state: 'ready' });
    }
    assert.equal(page.pathname, '/api/tray');
    assert(page.searchParams.has('timeZone'));
    summaryCount++;
    return Response.json(sample);
  });
  t.after(() => monitor.close());

  await wait(300);
  assert.deepEqual(received, [sample]);
  assert.equal(describeTray(received[0]).usageLine, 'Today 12,345 Token');
  assert.equal(describeTray(received[0]).costLine, 'API estimate €1.06');
  assert.equal(describeTray(null).costLine, 'API 估算 —');
  controller.enqueue(encode(': heartbeat\n\n'));
  await wait(300);
  assert.equal(summaryCount, 1);
  controller.enqueue(encode('ev'));
  controller.enqueue(encode('ent: usage\ndata: {}\n\n'));
  await wait(300);
  assert.equal(summaryCount, 2);
  assert.equal(await monitor.syncNow(), true);
});

test('budget notifications acknowledge native delivery and restore the window on click', async () => {
  let last;
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; last = this; }
    show() { this.emit('show'); }
  }
  let clicks = 0;
  const send = createBudgetNotifier(FakeNotification, { icon: 'icon.png', onClick: () => { clicks++; } });
  assert.equal(await send({ title: 'TokenStat', body: '80% of the monthly budget' }), true);
  assert.equal(last.options.silent, true);
  last.emit('click');
  assert.equal(clicks, 1);
  assert.equal(await send({ title: '', body: 'invalid' }), false);
});
