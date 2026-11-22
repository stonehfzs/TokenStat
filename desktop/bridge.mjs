const rpcTimeout = 30_000;

export function createDesktopBridge(port) {
  const pending = new Map();
  let id = 0;
  let closed = false;

  function onResponse(response) {
    if (response?.type !== 'desktop-result') return;
    const call = pending.get(response.id);
    if (!call) return;
    pending.delete(response.id);
    clearTimeout(call.timer);
    if (response.ok) call.resolve(response.value);
    else call.reject(new Error(response.error || '桌面系统服务不可用。'));
  }
  port.on('message', onResponse);

  function request(method, value) {
    if (closed) return Promise.reject(new Error('桌面系统服务已关闭。'));
    const callId = ++id;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error('等待桌面系统服务超时。'));
    }, rpcTimeout).unref();
    pending.set(callId, { resolve, reject, timer });
    try {
      port.postMessage({ type: 'desktop-request', id: callId, method, value });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(callId);
      reject(error);
    }
    return promise;
  }

  return {
    syncVault: {
      available: () => request('vault-available'),
      encrypt: (key) => request('vault-encrypt', key),
      decrypt: (sealedKey) => request('vault-decrypt', sealedKey),
    },
    notifyBudget: (notification) => request('budget-notification', notification),
    close() {
      closed = true;
      port.off('message', onResponse);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('桌面系统服务已关闭。'));
      }
      pending.clear();
    },
  };
}

export async function answerDesktopRequest(message, { syncVault, notifyBudget }) {
  const response = { type: 'desktop-result', id: message.id };
  try {
    let value;
    switch (message.method) {
      case 'vault-available': value = await syncVault?.available() ?? false; break;
      case 'vault-encrypt': value = await syncVault.encrypt(message.value); break;
      case 'vault-decrypt': value = await syncVault.decrypt(message.value); break;
      case 'budget-notification': value = await notifyBudget?.(message.value) ?? false; break;
      default: return { ...response, ok: false, error: '不支持该桌面操作。' };
    }
    return { ...response, ok: true, value };
  } catch {
    const error = message.method.startsWith('vault-')
      ? '无法使用系统密钥库。请解锁密钥库并重试。'
      : '桌面系统服务不可用。';
    return { ...response, ok: false, error };
  }
}
