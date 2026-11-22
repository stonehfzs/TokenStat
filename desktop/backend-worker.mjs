import { parentPort, workerData } from 'node:worker_threads';
import { startServer } from '../server.mjs';
import { createDesktopBridge } from './bridge.mjs';

const bridge = createDesktopBridge(parentPort);
const closing = Promise.withResolvers();
function onClose(message) {
  if (message?.type === 'close') closing.resolve();
}
parentPort.on('message', onClose);
let backend;
try {
  backend = await startServer({
    port: 0,
    dataDir: workerData.dataDir,
    syncVault: bridge.syncVault,
    notifyBudget: bridge.notifyBudget,
  });
  parentPort.postMessage({ type: 'ready', url: backend.url });
  await closing.promise;
} finally {
  try {
    await backend?.close();
  } finally {
    bridge.close();
    parentPort.off('message', onClose);
    parentPort.close();
  }
}
