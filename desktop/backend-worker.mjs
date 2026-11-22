import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import { startServer } from '../server.mjs';

const backend = await startServer({ port: 0, dataDir: workerData.dataDir });
const closing = once(parentPort, 'message');
parentPort.postMessage({ url: backend.url });
try {
  const [command] = await closing;
  if (command !== 'close') throw new Error('后台服务收到无效指令。');
} finally {
  try {
    await backend.close();
  } finally {
    parentPort.close();
  }
}
