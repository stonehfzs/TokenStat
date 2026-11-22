const pairingKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const linuxSecureTags = new Set(['v11', 'v12']);
const unavailableMessage = '系统密钥库不可用。请解锁系统密钥库后重试。';

function isPairingKey(value) {
  return typeof value === 'string' && pairingKeyPattern.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function createSyncVault(safeStorage, platform = process.platform) {
  let availabilityCheck;

  function supported() {
    if (typeof safeStorage?.isAsyncEncryptionAvailable !== 'function') return false;
    if (platform !== 'linux') return platform === 'win32' || platform === 'darwin';
    const backend = safeStorage.getSelectedStorageBackend();
    return Boolean(backend && backend !== 'basic_text' && backend !== 'unknown');
  }

  function protectedCiphertext(ciphertext) {
    // Electron 45's Chromium builds can fall back to the public Linux v10 key.
    // Its Freedesktop secret store and Secret portal use v11 and v12 respectively.
    return Buffer.isBuffer(ciphertext) && ciphertext.length > 3 &&
      (platform !== 'linux' || linuxSecureTags.has(ciphertext.toString('ascii', 0, 3)));
  }

  async function checkAvailability() {
    try {
      if (!supported() || !(await safeStorage.isAsyncEncryptionAvailable())) return false;
      return platform !== 'linux' || protectedCiphertext(await safeStorage.encryptStringAsync('TokenStat vault check'));
    } catch {
      return false;
    }
  }

  return {
    available() {
      availabilityCheck ??= checkAvailability().finally(() => { availabilityCheck = undefined; });
      return availabilityCheck;
    },
    async encrypt(key) {
      if (!isPairingKey(key)) throw new Error('配对密钥格式无效。');
      try {
        if (supported()) {
          const result = await safeStorage.encryptStringAsync(key);
          if (protectedCiphertext(result) && !result.equals(Buffer.from(key))) return result.toString('base64');
        }
      } catch {
        // Native errors can contain keychain details. Only return a generic error.
      }
      throw new Error(unavailableMessage);
    },
    async decrypt(value) {
      if (typeof value !== 'string' || !value || value.length > 16_384) throw new Error('加密密钥格式无效。');
      const ciphertext = Buffer.from(value, 'base64');
      if (ciphertext.toString('base64') !== value || !protectedCiphertext(ciphertext)) throw new Error('加密密钥格式无效。');
      try {
        if (supported()) {
          const { result } = await safeStorage.decryptStringAsync(ciphertext);
          if (isPairingKey(result)) return result;
        }
      } catch {
        // Keep keychain details and ciphertext out of logs and UI errors.
      }
      throw new Error(unavailableMessage);
    },
  };
}
