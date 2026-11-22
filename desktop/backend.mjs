import { Worker } from 'node:worker_threads';
import { answerDesktopRequest } from './bridge.mjs';

const shutdownTimeout = 45_000;

export async function startDesktopBackend(dataDir, services = {}) {
  const worker = new Worker(new URL('./backend-worker.mjs', import.meta.url), {
    name: 'TokenStat backend',
    workerData: { dataDir },
    execArgv: [],
  });
  const ready = Promise.withResolvers();
  const finished = Promise.withResolvers();
  // Main can subscribe after startup, including if the worker has already stopped.
  void finished.promise.catch(() => {});
  let fault;
  let closing = false;
  let exited = false;
  let timer;

  function failed(error) {
    fault ??= error;
    ready.reject(fault);
  }

  function terminate() {
    void worker.terminate().catch((error) => {
      failed(error);
      finished.reject(fault);
    });
  }

  worker.on('message', (message) => {
    if (message?.type === 'desktop-request' && Number.isSafeInteger(message.id)) {
      void answerDesktopRequest(message, services).then((response) => {
        if (!exited) worker.postMessage(response);
      }).catch((error) => {
        if (exited) return;
        failed(error);
        terminate();
      });
      return;
    }
    if (message?.type === 'ready' && typeof message.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.url)) {
      ready.resolve(message.url);
    } else {
      failed(new Error('TokenStat 后台服务返回了无效的本机地址。'));
      terminate();
    }
  });
  worker.once('messageerror', (error) => {
    failed(error);
    terminate();
  });
  worker.once('error', failed);
  worker.once('exit', (code) => {
    exited = true;
    clearTimeout(timer);
    if (!closing || code !== 0) failed(new Error(`TokenStat 后台服务已停止（退出代码 ${code}）。`));
    if (fault) finished.reject(fault);
    else finished.resolve();
  });

  function close() {
    if (!closing && !exited) {
      closing = true;
      timer = setTimeout(() => {
        failed(new Error('TokenStat 后台服务关闭超时。'));
        terminate();
      }, shutdownTimeout);
      timer.unref();
      try {
        worker.postMessage({ type: 'close' });
      } catch (error) {
        failed(error);
        terminate();
      }
    }
    return finished.promise;
  }

  return { url: await ready.promise, close, finished: finished.promise };
}
