import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const version = 1;
const monthlyVersion = 2;
const folderName = 'TokenStat-sync';
const snapshotSuffix = '.snapshot';
const manifestSuffix = '.manifest';
const magic = Buffer.from('TSTAT-SYNC-1\n');
const monthlyMagic = Buffer.from('TSTAT-SYNC-2\n');
const nonceBytes = 12;
const tagBytes = 16;
const maxPacket = 16 * 1024 * 1024;
const maxCleartext = 96 * 1024 * 1024;
const maxRecords = 250_000;
const maxPeers = 32;
const maxMonths = 1200;
const maxManifest = 256 * 1024;
const monthPattern = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/u;
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const devicePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const keyPattern = /^[A-Za-z0-9_-]{43}$/u;
const idPattern = /^[A-Za-z0-9:_-]{1,180}$/u;
const sessionPattern = /^(?:[a-z-]+-)?[a-f0-9]{24}$/u;
const providers = new Set(['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo', 'kilo', 'opencode', 'other']);
const metrics = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'];
const unpack = promisify(gunzip);
const pack = promisify(gzip);

class SyncAuthenticationError extends Error {}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function keyBytes(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) return null;
  const bytes = Buffer.from(key, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === key ? bytes : null;
}

function keys(key) {
  const secret = keyBytes(key);
  if (!secret) throw new Error('配对密钥无效。');
  const material = Buffer.from(hkdfSync('sha256', secret, 'TokenStat folder sync', 'v1', 64));
  const id = createHmac('sha256', material.subarray(32)).update('TokenStat sync namespace v1').digest().subarray(0, 16);
  const monthly = Buffer.from(hkdfSync('sha256', secret, 'TokenStat folder sync', 'v2', 64));
  return {
    id: id.toString('base64url'), encryption: material.subarray(0, 32),
    monthlyEncryption: monthly.subarray(0, 32), monthlyDigest: monthly.subarray(32),
  };
}

function deviceLabel(value) {
  if (typeof value !== 'string') throw new Error('请输入有效的设备名称。');
  const label = value.trim();
  if (!label || label.length > 64 || /[\p{Cc}\p{Cf}]/u.test(label)) throw new Error('设备名称请使用 1–64 个可显示字符。');
  return label;
}

function normalizedFolder(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new Error('请输入有效的同步文件夹。');
  }
  const path = value.trim();
  if (!path) return '';
  const expanded = path === '~' || /^~[/\\]/u.test(path) ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error('同步文件夹请使用绝对路径。');
  return resolve(expanded);
}

function wireRecord(source) {
  if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !idPattern.test(source.id) || !providers.has(source.provider)
      || typeof source.date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(source.date)
      || !Number.isFinite(Date.parse(source.date)) || new Date(source.date).toISOString() !== source.date) {
    throw new Error('用量记录的标识或日期无效。');
  }
  const model = source.model === '未知模型' ? null : source.model ?? null;
  if (model !== null && (typeof model !== 'string' || !model.trim() || model.length > 512
    || /[\p{Cc}\p{Zl}\p{Zp}\\]/u.test(model) || /^(?:\/|[a-z]:\/)/iu.test(model.trim())
    || /:\/\/|(?:^|\/)\.\.(?:\/|$)/u.test(model))) throw new Error('同步记录的模型无效。');
  const record = { id: source.id, provider: source.provider, model, date: source.date };
  for (const field of metrics) {
    const value = field === 'cacheWrite' ? source[field] ?? 0 : source[field];
    if (!safeInteger(value)) throw new Error('同步记录的 Token 数量无效。');
    record[field] = value;
  }
  if (source.dateOnly === true) record.dateOnly = true;
  if (source.session != null) {
    if (typeof source.session !== 'string' || source.session.length > 80 || !sessionPattern.test(source.session)) {
      throw new Error('同步记录的会话标识无效。');
    }
    record.session = source.session;
  }
  if (source.reasoningKnown === false) record.reasoningKnown = false;
  if (source.requestLevel === true) record.requestLevel = true;
  if (source.costUsdTicks != null) {
    if (!safeInteger(source.costUsdTicks)) throw new Error('同步记录的原始价格无效。');
    record.costUsdTicks = source.costUsdTicks;
  }
  return record;
}

function snapshotShape(document, expectedDevice) {
  if (document?.version !== version || !devicePattern.test(document.deviceId ?? '') || document.deviceId !== expectedDevice
      || !safeInteger(document.revision) || !Array.isArray(document.records) || document.records.length > maxRecords) {
    throw new Error('同步文件结构或版本无效。');
  }
  return {
    deviceId: document.deviceId,
    deviceName: deviceLabel(document.deviceName),
    revision: document.revision,
    records: document.records.map(wireRecord),
  };
}

function aad(group, deviceId) {
  return Buffer.from('TokenStat/' + version + '/' + group.id + '/' + deviceId);
}

async function sealMonthly(raw, group, address, signal, limit = maxCleartext) {
  if (raw.length > limit) throw new Error('本机同步记录超出大小上限。');
  const zipped = await pack(raw, { level: 3 });
  signal.throwIfAborted();
  if (zipped.length + monthlyMagic.length + nonceBytes + tagBytes > maxPacket) throw new Error('本机同步记录超出大小上限。');
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', group.monthlyEncryption, nonce);
  cipher.setAAD(Buffer.from('TokenStat/2/' + group.id + '/' + address));
  return Buffer.concat([monthlyMagic, nonce, cipher.update(zipped), cipher.final(), cipher.getAuthTag()]);
}

function decryptPayload(cipher, encrypted) {
  const decrypted = cipher.update(encrypted);
  let tail;
  try {
    tail = cipher.final();
  } catch (cause) {
    throw new SyncAuthenticationError('同步文件认证失败。', { cause });
  }
  return Buffer.concat([decrypted, tail]);
}

async function openMonthly(packet, group, address, signal, limit = maxCleartext) {
  const start = monthlyMagic.length;
  const end = packet.length - tagBytes;
  if (end <= start + nonceBytes || !packet.subarray(0, start).equals(monthlyMagic)) throw new Error('同步文件格式无效。');
  const cipher = createDecipheriv('aes-256-gcm', group.monthlyEncryption, packet.subarray(start, start + nonceBytes));
  cipher.setAAD(Buffer.from('TokenStat/2/' + group.id + '/' + address));
  cipher.setAuthTag(packet.subarray(end));
  const zipped = decryptPayload(cipher, packet.subarray(start + nonceBytes, end));
  const raw = await unpack(zipped, { maxOutputLength: limit });
  signal.throwIfAborted();
  return raw;
}

function digestFor(group, raw) {
  return createHmac('sha256', group.monthlyDigest).update(raw).digest('base64url');
}

function manifestAddress(deviceId) {
  return 'manifest/' + deviceId;
}

function shardAddress(deviceId, descriptor) {
  return 'month/' + [deviceId, descriptor.month, descriptor.slot, descriptor.digest].join('/');
}

function shardPath(directory, deviceId, descriptor) {
  return join(directory, [deviceId, descriptor.month, descriptor.slot, 'shard'].join('.'));
}

function readManifest(raw, deviceId) {
  const payload = JSON.parse(raw.toString('utf8'));
  if (payload?.version !== monthlyVersion || payload.type !== 'manifest' || payload.deviceId !== deviceId
      || !safeInteger(payload.revision) || !Array.isArray(payload.months) || payload.months.length > maxMonths) {
    throw new Error('同步清单格式无效。');
  }
  const months = new Map();
  let total = 0;
  for (const item of payload.months) {
    if (!item || !monthPattern.test(item.month) || months.has(item.month) || !safeInteger(item.generation)
        || item.generation > payload.revision || !safeInteger(item.count)
        || (item.count ? ((item.slot !== 0 && item.slot !== 1) || !digestPattern.test(item.digest))
          : item.slot !== null || item.digest !== null)) throw new Error('同步清单包含无效分片。');
    total += item.count;
    if (total > maxRecords) throw new Error('同步清单超过用量记录上限。');
    months.set(item.month, { month: item.month, generation: item.generation, count: item.count, slot: item.slot, digest: item.digest });
  }
  return { deviceId, deviceName: deviceLabel(payload.deviceName), revision: payload.revision, months };
}

function readShard(raw, group, deviceId, descriptor) {
  if (digestFor(group, raw) !== descriptor.digest) throw new Error('同步分片校验失败。');
  const payload = JSON.parse(raw.toString('utf8'));
  if (payload?.version !== monthlyVersion || payload.type !== 'month' || payload.deviceId !== deviceId
      || payload.month !== descriptor.month || !Array.isArray(payload.records) || payload.records.length !== descriptor.count) {
    throw new Error('同步分片与清单不匹配。');
  }
  return payload.records.map((record) => {
    const result = wireRecord(record);
    if (result.date.slice(0, 7) !== descriptor.month) throw new Error('用量记录不属于声明的月份。');
    return result;
  });
}

function encodeShard(deviceId, month, records) {
  return Buffer.from(JSON.stringify({
    version: monthlyVersion, type: 'month', deviceId, month, records: records.map(wireRecord),
  }));
}

async function verifiedShard(directory, group, deviceId, descriptor, signal) {
  const path = shardPath(directory, deviceId, descriptor);
  if (!(await lstat(path)).isFile()) throw new Error('同步目录结构无效。');
  const part = await readSnapshot(path, signal);
  const raw = await openMonthly(part.packet, group, shardAddress(deviceId, descriptor), signal);
  return readShard(raw, group, deviceId, descriptor);
}

function fileIssue(error, kind) {
  if (missing(error)) return { state: 'missing', reason: kind + '-missing' };
  if (error instanceof SyncAuthenticationError) return { state: 'corrupt', reason: kind + '-authentication-failed' };
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ELOOP'
      || error?.code === 'EBUSY' || error?.code === 'EMFILE' || error?.code === 'EIO'
      || error?.message === '同步文件正在更新。' || error?.message === '同步目录结构无效。') {
    return { state: 'unreadable', reason: kind + '-unreadable' };
  }
  return { state: 'corrupt', reason: kind + '-invalid' };
}

async function decryptSnapshot(packet, deviceId, group, signal) {
  const start = magic.length;
  const end = packet.length - tagBytes;
  if (end <= start + nonceBytes || !packet.subarray(0, start).equals(magic)) throw new Error('同步文件格式无效。');
  const cipher = createDecipheriv('aes-256-gcm', group.encryption, packet.subarray(start, start + nonceBytes));
  cipher.setAAD(aad(group, deviceId));
  cipher.setAuthTag(packet.subarray(end));
  const zipped = decryptPayload(cipher, packet.subarray(start + nonceBytes, end));
  const raw = await unpack(zipped, { maxOutputLength: maxCleartext });
  signal.throwIfAborted();
  return snapshotShape(JSON.parse(raw.toString('utf8')), deviceId);
}

function signature(info) {
  return [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

async function readSnapshot(path, signal, limit = maxPacket) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || before.size < magic.length + nonceBytes + tagBytes) throw new Error('同步文件大小无效。');
    const packet = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < packet.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(packet, offset, packet.length - offset, offset);
      if (!bytesRead) throw new Error('同步文件正在更新。');
      offset += bytesRead;
    }
    const stamp = signature(before);
    if (signature(await handle.stat()) !== stamp) throw new Error('同步文件正在更新。');
    return { packet, signature: stamp };
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path, directory, bytes, signal, beforeRename) {
  const temporary = join(directory, '.' + randomBytes(16).toString('hex') + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true, signal });
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const blocked = await beforeRename?.();
      if (blocked) return blocked;
      signal.throwIfAborted();
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        // Windows file providers can briefly hold the destination open.
        await delay(45 * (attempt + 1), undefined, { signal });
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function safeDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('同步目录结构无效。');
  return path;
}

async function directoryFor(folder, group) {
  const root = await realpath(folder);
  const base = await safeDirectory(join(root, folderName));
  const storage = await safeDirectory(join(base, 'v' + monthlyVersion));
  let legacyDirectory = null;
  const legacyStorage = join(base, 'v' + version);
  let otherGroups = false;
  for (const candidate of [storage, legacyStorage]) {
    try {
      if (!(await lstat(candidate)).isDirectory()) continue;
      const entries = await readdir(candidate, { withFileTypes: true });
      if (candidate === legacyStorage && entries.some((entry) => entry.isDirectory() && entry.name === group.id)) {
        legacyDirectory = join(candidate, group.id);
      }
      otherGroups ||= entries.some((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{22}$/u.test(entry.name) && entry.name !== group.id);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const directory = await safeDirectory(join(storage, group.id));
  return { directory, legacyDirectory, otherGroups };
}

function publicPeer(peer, presence) {
  return {
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    revision: peer.revision,
    count: peer.count,
    syncedAt: peer.syncedAt,
    protocol: peer.protocol,
    available: presence === null ? null : presence.has(peer.deviceId),
  };
}

function deviceInfo(deviceId, deviceName, { local = false, protocol = null, revision = null } = {}) {
  return {
    deviceId,
    deviceName: deviceName || '设备 ' + deviceId.slice(0, 6),
    local,
    protocol,
    revision,
  };
}

function problem(error) {
  if (missing(error) || ['ENETDOWN', 'ENETUNREACH', 'ESTALE', 'EIO'].includes(error?.code)) {
    return { state: 'offline', lastError: '同步文件夹暂时不可用，恢复连接后会重试。' };
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
    return { state: 'error', lastError: '无法读写同步文件夹，请检查权限。' };
  }
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
    return { state: 'error', lastError: '同步文件夹存储空间不足。' };
  }
  if (['本机同步记录超出大小上限。', '同步目录结构无效。', '配对密钥无效。',
    '本机同步版本低于共享文件中的版本。', '每台设备最多同步 250,000 条用量记录。',
    '系统密钥库当前不可用。', '系统密钥库无法读取已保存的同步密钥。'].includes(error?.message)) {
    return { state: 'error', lastError: error.message };
  }
  return { state: 'error', lastError: '暂时无法完成同步，下次会自动重试。' };
}

export function createSync(store, { onChange = () => {}, keyVault } = {}) {
  const aborter = new AbortController();
  const { signal } = aborter;
  let serial = Promise.resolve();
  let currentRun;
  let currentVerification;
  let memoizedGroup;
  let outbound;
  let presence = null;
  let lastSyncAt = null;
  let lastError = null;
  let lastState = 'ready';
  let lastVerification = null;
  let latestAuditIssues = [];
  let latestSyncIssues = [];
  const fingerprints = new Map();

  function groupFor(key) {
    if (memoizedGroup?.key !== key) memoizedGroup = { key, group: keys(key) };
    return memoizedGroup.group;
  }

  function status() {
    const saved = store.getSyncConfig();
    const keyId = saved?.keyId || (keyBytes(saved?.key) ? groupFor(saved.key).id : null);
    const peerIssues = new Map(latestAuditIssues.map((item) => [item.deviceId, item]));
    for (const item of latestSyncIssues) peerIssues.set(item.deviceId, item);
    return {
      enabled: saved?.enabled === true,
      configured: Boolean(saved?.folder && keyId),
      folder: saved?.folder ?? '',
      deviceId: store.getSyncIdentity().deviceId,
      deviceName: saved?.deviceName ?? '',
      keyId,
      state: saved?.enabled ? lastState : 'disabled',
      lastSyncAt,
      lastError,
      lastVerification,
      peerIssues: [...peerIssues.values()],
      peers: store.readSyncPeers().map((peer) => publicPeer(peer, saved?.enabled ? presence : null)),
      retired: store.readRetiredSyncPeers(),
    };
  }

  function enqueue(work) {
    const task = serial.then(() => { signal.throwIfAborted(); return work(); });
    serial = task.catch(() => {});
    return task;
  }

  async function availableVault() {
    if (!keyVault || !await keyVault.available()) throw new Error('系统密钥库当前不可用。');
  }

  async function seal(key) {
    await availableVault();
    const sealedKey = await keyVault.encrypt(key);
    if (typeof sealedKey !== 'string' || !sealedKey) throw new Error('系统密钥库当前不可用。');
    return sealedKey;
  }

  async function loadKey(saved, { migrate = true } = {}) {
    if (saved?.sealedKey) {
      await availableVault();
      let key;
      try {
        key = await keyVault.decrypt(saved.sealedKey);
      } catch {
        throw new Error('系统密钥库无法读取已保存的同步密钥。');
      }
      if (!keyBytes(key) || (saved.keyId && groupFor(key).id !== saved.keyId)) {
        throw new Error('系统密钥库无法读取已保存的同步密钥。');
      }
      return key;
    }
    if (!keyBytes(saved?.key)) return '';
    if (keyVault && migrate) {
      const sealedKey = await seal(saved.key);
      signal.throwIfAborted();
      const { key, ...config } = saved;
      store.setSyncConfig({ ...config, keyId: groupFor(key).id, sealedKey });
    }
    return saved.key;
  }

  function getPairingKey() {
    return enqueue(() => loadKey(store.getSyncConfig()));
  }

  function configure(input = {}) {
    return enqueue(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('同步设置无效。');
      const prior = store.getSyncConfig();
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('同步开关无效。');
      const enabled = input.enabled ?? prior?.enabled ?? false;
      const folder = input.folder === undefined ? prior?.folder ?? '' : normalizedFolder(input.folder);
      const defaultName = '设备 ' + store.getSyncIdentity().deviceId.slice(0, 6);
      const deviceName = input.deviceName === undefined || input.deviceName === ''
        ? prior?.deviceName || defaultName
        : deviceLabel(input.deviceName);
      const previousId = prior?.keyId || (keyBytes(prior?.key) ? groupFor(prior.key).id : null);
      const base = { enabled, folder, deviceName };
      let replacement = '';
      let pairingKey;
      if (input.key !== undefined) {
        if (typeof input.key !== 'string') throw new Error('配对密钥无效。');
        replacement = input.key.trim();
        if (replacement && !keyBytes(replacement)) throw new Error('配对密钥必须是 43 位 TokenStat 配对字符串。');
      }
      if (enabled && !folder) throw new Error('请先设置同步文件夹。');
      const key = replacement || (enabled ? await loadKey(prior) || (pairingKey = randomBytes(32).toString('base64url')) : '');
      let persisted = keyVault ? { keyId: previousId, sealedKey: prior?.sealedKey } : { keyId: previousId, key: prior?.key ?? '' };
      if (key) {
        const keyId = groupFor(key).id;
        if (keyVault) {
          const current = store.getSyncConfig();
          persisted = { keyId, sealedKey: current?.keyId === keyId && current.sealedKey ? current.sealedKey : await seal(key) };
        } else {
          persisted = { keyId, key };
        }
      } else if (keyVault && !prior?.sealedKey && keyBytes(prior?.key)) {
        // Keep the existing credential recoverable until the system vault becomes available.
        persisted = { keyId: previousId, key: prior.key };
      }
      signal.throwIfAborted();
      const keyChanged = Boolean(previousId && persisted.keyId !== previousId);
      const locationChanged = prior?.folder !== folder || keyChanged;
      const { clearedPeers } = store.setSyncConfig({ ...base, ...persisted }, { clearPeers: keyChanged });
      if (locationChanged) {
        outbound = undefined;
        presence = null;
        fingerprints.clear();
        lastSyncAt = null;
        lastVerification = null;
        latestAuditIssues = [];
        latestSyncIssues = [];
      }
      lastError = null;
      lastState = 'ready';
      if (clearedPeers) onChange();
      return { ...status(), ...(pairingKey ? { pairingKey } : {}) };
    });
  }

  async function fileStamp(path) {
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error('同步目录结构无效。');
      return signature(info);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function publish(directory, group, deviceName, repair) {
    const local = store.readOwnSyncPlan();
    if (!devicePattern.test(local.deviceId) || !safeInteger(local.revision) || local.months.length > maxMonths) {
      throw new Error('本机同步记录超出大小上限。');
    }
    const path = join(directory, local.deviceId + manifestSuffix);
    const existingSignature = await fileStamp(path);
    let prior;
    if (repair) {
      prior = repair.inspected.manifest;
      if (local.deviceId !== prior.deviceId || local.revision < prior.revision) {
        return { reason: 'local-version-older' };
      }
      if (existingSignature !== repair.inspected.signature) return { reason: 'manifest-changed' };
      if (local.revision === prior.revision && local.months.length !== prior.months.size) {
        return { reason: 'local-month-changed' };
      }
    } else if (existingSignature && outbound?.signature === existingSignature) {
      prior = outbound.manifest;
    } else if (existingSignature) {
      try {
        const saved = await readSnapshot(path, signal, maxManifest);
        prior = readManifest(await openMonthly(saved.packet, group, manifestAddress(local.deviceId), signal, maxManifest),
          local.deviceId);
      } catch (error) {
        signal.throwIfAborted();
      }
    }
    if (prior?.revision > local.revision) throw new Error('本机同步版本低于共享文件中的版本。');

    async function fenceIssue() {
      if (await fileStamp(path) !== existingSignature) return 'manifest-changed';
      if (store.getSyncIdentity().revision !== local.revision) return 'local-revision-changed';
      return null;
    }

    const months = [];
    let count = 0;
    for (const { month, revision } of local.months) {
      signal.throwIfAborted();
      const unchanged = prior?.months.get(month);
      const rebuild = repair?.months.has(month);
      const previousPath = unchanged?.count ? shardPath(directory, local.deviceId, unchanged) : undefined;
      const previousExists = previousPath ? Boolean(repair || await fileStamp(previousPath)) : false;
      let next;
      if (!rebuild && unchanged?.generation === revision && (!unchanged.count || previousExists)) {
        next = unchanged;
      } else {
        const entries = store.readOwnSyncMonth(month, revision);
        if (!entries) return { reason: 'local-revision-changed' };
        if (!entries.length) {
          if (rebuild && unchanged.generation === revision) return { reason: 'local-month-changed' };
          next = { month, generation: revision, count: 0, slot: null, digest: null };
        } else {
          const raw = encodeShard(local.deviceId, month, entries);
          const digest = digestFor(group, raw);
          const sameRecords = unchanged?.digest === digest && unchanged.count === entries.length;
          if (rebuild && unchanged.generation === revision && !sameRecords) return { reason: 'local-month-changed' };
          // Only the manifest commit makes the replacement visible, so keep its current slot intact.
          const slot = !rebuild && sameRecords ? unchanged.slot : unchanged?.slot === 0 ? 1 : 0;
          next = { month, generation: revision, count: entries.length, slot, digest };
          if (rebuild || !sameRecords || !previousExists) {
            const encrypted = await sealMonthly(raw, group, shardAddress(local.deviceId, next), signal);
            const blocked = await atomicWrite(shardPath(directory, local.deviceId, next), directory, encrypted, signal, fenceIssue);
            if (blocked) return { reason: blocked };
            if (repair) await verifiedShard(directory, group, local.deviceId, next, signal);
          }
        }
      }
      count += next.count;
      if (count > maxRecords) throw new Error('每台设备最多同步 250,000 条用量记录。');
      months.push(next);
    }

    if (prior?.revision === local.revision && prior.deviceName === deviceName
        && JSON.stringify([...prior.months.values()]) === JSON.stringify(months)) {
      outbound = { signature: existingSignature, manifest: prior };
      return { manifest: prior };
    }
    if (store.getSyncIdentity().revision !== local.revision) return { reason: 'local-revision-changed' };
    const raw = Buffer.from(JSON.stringify({
      version: monthlyVersion, type: 'manifest', deviceId: local.deviceId, deviceName, revision: local.revision, months,
    }));
    // The currently committed manifest always continues to reference the other slot until this commit.
    const encrypted = await sealMonthly(raw, group, manifestAddress(local.deviceId), signal, maxManifest);
    const blocked = await atomicWrite(path, directory, encrypted, signal, fenceIssue);
    if (blocked) return { reason: blocked };
    outbound = {
      signature: await fileStamp(path),
      manifest: { deviceId: local.deviceId, deviceName, revision: local.revision, months: new Map(months.map((item) => [item.month, item])) },
    };
    return { manifest: outbound.manifest };
  }

  async function listSnapshots(directory, suffix) {
    if (!directory) return [];
    try {
      if (!(await lstat(directory)).isDirectory()) return [];
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => ({ id: entry.name.slice(0, -suffix.length), path: join(directory, entry.name) }))
        .filter(({ id }) => devicePattern.test(id));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  async function deviceFiles(directory, legacyDirectory) {
    const files = new Map();
    for (const [format, folder, suffix] of [[version, legacyDirectory, snapshotSuffix], [monthlyVersion, directory, manifestSuffix]]) {
      for (const { id, path } of await listSnapshots(folder, suffix)) files.set(id, { format, path });
    }
    return files;
  }

  async function changedShards(directory, group, manifest, currentPeer) {
    const previous = currentPeer?.protocol === monthlyVersion
      ? new Map(store.readSyncPeerMonths(manifest.deviceId).map((descriptor) => [descriptor.month, descriptor]))
      : new Map();
    const required = [...manifest.months.values()].filter((item) => item.count &&
      (previous.get(item.month)?.digest !== item.digest || previous.get(item.month)?.count !== item.count));
    // Folder providers may deliver the manifest first. Probe all dependencies before decoding any month's data.
    const issues = [];
    for (const descriptor of required) {
      try {
        if (!await fileStamp(shardPath(directory, manifest.deviceId, descriptor))) {
          issues.push({ month: descriptor.month, state: 'missing', reason: 'shard-missing' });
        }
      } catch (error) {
        signal.throwIfAborted();
        issues.push({ month: descriptor.month, ...fileIssue(error, 'shard') });
      }
    }
    const shards = [];
    if (issues.length) return { shards, issues };
    for (const descriptor of required) {
      try {
        const records = await verifiedShard(directory, group, manifest.deviceId, descriptor, signal);
        shards.push({ month: descriptor.month, records });
      } catch (error) {
        signal.throwIfAborted();
        issues.push({ month: descriptor.month, ...fileIssue(error, 'shard') });
      }
    }
    return { shards, issues };
  }

  async function receive(directory, legacyDirectory, group, own) {
    const peers = new Map(store.readSyncPeers().map((peer) => [peer.deviceId, peer]));
    const retired = new Set(store.readRetiredSyncPeers().map((peer) => peer.deviceId));
    const peersPresent = new Set();
    const candidates = await deviceFiles(directory, legacyDirectory);
    candidates.delete(own);
    for (const id of retired) candidates.delete(id);
    const ordered = [...candidates].sort(([a], [b]) => Number(peers.has(b)) - Number(peers.has(a)) || a.localeCompare(b));
    let changed = false;
    let staleCount = 0;
    let pendingCount = 0;
    let errorCount = Math.max(0, candidates.size - maxPeers);
    const checkedAt = new Date().toISOString();
    const issues = [];

    for (const [id, { format, path }] of ordered.slice(0, maxPeers)) {
      signal.throwIfAborted();
      const currentPeer = peers.get(id);
      let deviceName = currentPeer?.deviceName;
      const issue = (status, reason, months = []) => issues.push({
        ...deviceInfo(id, deviceName, { protocol: format, revision: currentPeer?.revision }),
        status, reason, months, checkedAt,
      });
      if (format < currentPeer?.protocol) {
        staleCount++;
        issue('stale', 'legacy-after-upgrade');
        continue;
      }
      try {
        const actualStamp = await fileStamp(path);
        if (!actualStamp) {
          issue('offline', format === monthlyVersion ? 'manifest-missing' : 'snapshot-missing');
          continue;
        }
        const stamp = format === monthlyVersion ? 'v2:' + actualStamp : actualStamp;
        if (currentPeer?.signature === stamp) {
          peersPresent.add(id);
          continue;
        }
        const cached = fingerprints.get(id);
        if (cached?.signature === stamp && (currentPeer || cached.invalid)) {
          if (cached.stale) {
            staleCount++;
            issue('stale', 'older-revision');
          } else if (cached.invalid) {
            errorCount++;
            issue('attention', cached.invalid);
          }
          else if (cached.valid) {
            peersPresent.add(id);
            continue;
          }
          if (cached.stale || cached.invalid) continue;
        }

        let remote = cached?.signature === stamp ? cached.manifest : undefined;
        let readStamp = stamp;
        if (!remote) {
          const current = await readSnapshot(path, signal, format === monthlyVersion ? maxManifest : maxPacket);
          readStamp = format === monthlyVersion ? 'v2:' + current.signature : current.signature;
          try {
            remote = format === monthlyVersion
              ? readManifest(await openMonthly(current.packet, group, manifestAddress(id), signal, maxManifest), id)
              : await decryptSnapshot(current.packet, id, group, signal);
          } catch (error) {
            signal.throwIfAborted();
            fingerprints.set(id, { signature: readStamp, invalid: fileIssue(error, format === monthlyVersion ? 'manifest' : 'snapshot').reason });
            throw error;
          }
          // Cache only the small authenticated manifest, never pending peer record payloads.
          if (format === monthlyVersion) fingerprints.set(id, { signature: readStamp, manifest: remote });
        }
        signal.throwIfAborted();
        deviceName = remote.deviceName;
        if (remote.revision < (currentPeer?.revision ?? 0)) {
          staleCount++;
          fingerprints.set(id, { signature: readStamp, stale: true });
          issue('stale', 'older-revision');
          continue;
        }
        if (remote.revision === currentPeer?.revision && format === currentPeer.protocol) {
          peersPresent.add(id);
          fingerprints.set(id, { signature: readStamp, valid: true });
          continue;
        }

        let result;
        if (format === monthlyVersion) {
          const { shards, issues: monthIssues } = await changedShards(directory, group, remote, currentPeer);
          if (monthIssues.length) {
            const pending = monthIssues.every((item) => item.state === 'missing');
            if (pending) pendingCount++;
            else errorCount++;
            issue('attention', pending ? 'pending-months' : 'invalid-months', monthIssues);
            continue;
          }
          signal.throwIfAborted();
          result = store.applySyncManifest({ ...remote, months: [...remote.months.values()], shards, signature: readStamp });
        } else {
          result = store.applySyncSnapshot({ ...remote, signature: readStamp });
        }
        changed ||= result.changed;
        peersPresent.add(id);
        fingerprints.set(id, { signature: readStamp, valid: true });
      } catch (error) {
        signal.throwIfAborted();
        const { reason } = fileIssue(error, format === monthlyVersion ? 'manifest' : 'snapshot');
        if (missing(error)) {
          pendingCount++;
          issue('offline', reason);
          continue;
        }
        errorCount++;
        issue('attention', reason);
      }
    }
    for (const [id, peer] of peers) if (!candidates.has(id)) {
      issues.push({
        ...deviceInfo(id, peer.deviceName, { protocol: peer.protocol, revision: peer.revision }),
        status: 'offline', reason: 'device-file-missing', months: [], checkedAt,
      });
    }
    for (const id of fingerprints.keys()) if (!candidates.has(id)) fingerprints.delete(id);
    return { changed, peersPresent, errorCount, staleCount, pendingCount, issues };
  }

  async function inspectManifest(path, group, deviceId) {
    const current = await readSnapshot(path, signal, maxManifest);
    const raw = await openMonthly(current.packet, group, manifestAddress(deviceId), signal, maxManifest);
    return { manifest: readManifest(raw, deviceId), signature: current.signature };
  }

  async function repairOwnMonths(directory, group, deviceName, inspected, months) {
    const affected = months.filter(({ state }) => state === 'missing' || state === 'corrupt');
    if (!affected.length) return null;
    let result;
    try {
      result = await publish(directory, group, deviceName, { inspected, months: new Set(affected.map(({ month }) => month)) });
    } catch (error) {
      signal.throwIfAborted();
      result = { reason: 'repair-write-failed' };
    }
    for (const issue of affected) {
      issue.previousReason = issue.reason;
      if (result.reason) issue.reason = result.reason;
      else Object.assign(issue, { state: 'repaired', reason: 'rebuilt-from-local-data' });
    }
    return result.manifest ?? null;
  }

  function knownDevices(config) {
    const own = store.getSyncIdentity();
    const result = new Map([
      [own.deviceId, deviceInfo(own.deviceId, config?.deviceName, { local: true, revision: own.revision })],
    ]);
    for (const peer of store.readSyncPeers()) {
      result.set(peer.deviceId, deviceInfo(peer.deviceId, peer.deviceName,
        { protocol: peer.protocol, revision: peer.revision }));
    }
    for (const peer of store.readRetiredSyncPeers()) {
      result.set(peer.deviceId, { ...deviceInfo(peer.deviceId, peer.deviceName), retired: true });
    }
    return result;
  }

  async function auditDevice(directory, group, device, candidate) {
    if (device.retired) return { ...device, status: 'retired', reason: 'device-retired', months: [] };
    if (!candidate) return {
      ...device, status: 'offline',
      reason: device.local || device.protocol === monthlyVersion ? 'manifest-missing' : 'snapshot-missing', months: [],
    };

    const format = candidate.format;
    let inspected;
    try {
      if (format === version) {
        const current = await readSnapshot(candidate.path, signal);
        const legacy = await decryptSnapshot(current.packet, device.deviceId, group, signal);
        const stale = device.protocol === monthlyVersion || (device.revision !== null && legacy.revision < device.revision);
        return {
          ...device, deviceName: legacy.deviceName, protocol: version, revision: legacy.revision,
          status: stale ? 'stale' : 'legacy',
          reason: device.protocol === monthlyVersion ? 'legacy-after-upgrade' : stale ? 'older-revision' : 'legacy-snapshot',
          months: [...new Set(legacy.records.map((record) => record.date.slice(0, 7)))].sort()
            .map((month) => ({ month, state: 'verified', reason: 'legacy-snapshot' })),
        };
      }
      inspected = await inspectManifest(candidate.path, group, device.deviceId);
    } catch (error) {
      signal.throwIfAborted();
      const issue = fileIssue(error, format === monthlyVersion ? 'manifest' : 'snapshot');
      return { ...device, protocol: format, status: issue.state === 'missing' ? 'offline' : 'error', reason: issue.reason, months: [] };
    }

    const { manifest } = inspected;
    const archivedRevision = device.revision !== null
      && (device.local ? manifest.revision > device.revision : manifest.revision < device.revision);
    const months = [];
    for (const descriptor of manifest.months.values()) {
      signal.throwIfAborted();
      const { month } = descriptor;
      if (!descriptor.count) {
        months.push({ month, state: 'empty', reason: null });
        continue;
      }
      try {
        await verifiedShard(directory, group, manifest.deviceId, descriptor, signal);
        months.push({ month, state: 'verified', reason: null });
      } catch (error) {
        signal.throwIfAborted();
        months.push({ month, ...fileIssue(error, 'shard') });
      }
    }
    const repaired = device.local ? await repairOwnMonths(directory, group, device.deviceName, inspected, months) : null;
    const hasIssues = months.some((item) => ['missing', 'corrupt', 'unreadable'].includes(item.state));
    return {
      ...device, deviceName: repaired?.deviceName ?? manifest.deviceName, protocol: monthlyVersion, revision: repaired?.revision ?? manifest.revision,
      status: archivedRevision ? 'stale' : hasIssues ? 'attention' : repaired ? 'repaired' : 'ok',
      reason: archivedRevision ? device.local ? 'local-version-older' : 'older-revision' : hasIssues ? 'invalid-months' : null,
      months,
    };
  }

  function concludeVerification(devices, status, reason = null) {
    const checkedAt = new Date().toISOString();
    const repairedMonths = devices.reduce((sum, device) => sum + device.months.filter((month) => month.state === 'repaired').length, 0);
    const problematic = devices.filter((device) => ['offline', 'attention', 'stale', 'error'].includes(device.status));
    const resultStatus = status ?? (problematic.length ? 'attention' : repairedMonths ? 'repaired' : 'ok');
    const devicesChecked = devices.filter((device) => !['retired', 'disabled', 'offline'].includes(device.status)).length;
    lastVerification = { status: resultStatus, reason, checkedAt, repairedMonths, devicesChecked };
    latestAuditIssues = problematic.map(({ months, ...device }) => {
      const problems = months.filter((month) => ['missing', 'corrupt', 'unreadable'].includes(month.state));
      return { ...device, months: problems.slice(0, 32), issueMonths: problems.length, checkedAt };
    });
    latestSyncIssues = [];
    return { ...lastVerification, devices };
  }

  function verifyAndRepair() {
    if (currentVerification) return currentVerification;
    currentVerification = enqueue(async () => {
      const saved = store.getSyncConfig();
      const known = knownDevices(saved);
      if (!saved?.enabled) {
        return concludeVerification([...known.values()].map((device) => ({
          ...device, status: device.retired ? 'retired' : 'disabled', reason: device.retired ? 'device-retired' : 'sync-disabled', months: [],
        })), 'disabled', 'sync-disabled');
      }
      try {
        const group = groupFor(await loadKey(saved));
        const { directory, legacyDirectory } = await directoryFor(saved.folder, group);
        signal.throwIfAborted();
        const files = await deviceFiles(directory, legacyDirectory);
        const newIds = [...files.keys()].filter((id) => !known.has(id)).sort();
        const spots = Math.max(0, maxPeers - [...known.values()].filter((device) => !device.local && !device.retired).length);
        for (const id of newIds.slice(0, spots)) known.set(id, deviceInfo(id));
        const devices = [];
        for (const device of known.values()) {
          signal.throwIfAborted();
          devices.push(await auditDevice(directory, group, device, files.get(device.deviceId)));
        }
        const limited = newIds.length > spots;
        return concludeVerification(devices, limited ? 'attention' : undefined, limited ? 'device-limit' : null);
      } catch (error) {
        signal.throwIfAborted();
        const state = problem(error).state;
        const reason = state === 'offline' ? 'folder-offline' : 'verification-unavailable';
        return concludeVerification([...known.values()].map((device) => ({
          ...device, status: device.retired ? 'retired' : state, reason: device.retired ? 'device-retired' : reason, months: [],
        })), state, reason);
      }
    }).finally(() => { currentVerification = undefined; });
    return currentVerification;
  }

  function retirePeer(deviceId) {
    return enqueue(() => {
      const result = store.retireSyncPeer(deviceId);
      fingerprints.delete(deviceId);
      presence?.delete(deviceId);
      latestAuditIssues = latestAuditIssues.filter((device) => device.deviceId !== deviceId);
      latestSyncIssues = latestSyncIssues.filter((device) => device.deviceId !== deviceId);
      if (result.changed) onChange();
      return result;
    });
  }

  function restorePeer(deviceId) {
    return enqueue(() => {
      const result = store.restoreSyncPeer(deviceId);
      fingerprints.delete(deviceId);
      return result;
    });
  }

  function run() {
    if (currentRun) return currentRun;
    currentRun = enqueue(async () => {
      const config = store.getSyncConfig();
      if (!config?.enabled) return status();
      lastState = 'syncing';
      let changed = false;
      try {
        const group = groupFor(await loadKey(config));
        const { directory, legacyDirectory, otherGroups } = await directoryFor(config.folder, group);
        signal.throwIfAborted();
        let outboundIssue;
        try {
          await publish(directory, group, config.deviceName);
        } catch (error) {
          signal.throwIfAborted();
          outboundIssue = problem(error);
        }
        const result = await receive(directory, legacyDirectory, group, store.getSyncIdentity().deviceId);
        changed = result.changed;
        presence = result.peersPresent;
        latestSyncIssues = result.issues;
        lastSyncAt = new Date().toISOString();
        lastState = outboundIssue?.state ?? (result.errorCount ? 'error' : 'ok');
        lastError = outboundIssue?.lastError
          ?? (result.errorCount ? '部分设备的同步文件暂时无法读取或校验。' : null)
          ?? (result.staleCount ? '发现较旧的同步文件，已经保留该设备最近收到的用量。' : null)
          ?? (result.pendingCount ? '部分月份正在等待共享文件同步，保留上一版用量。' : null)
          ?? (otherGroups && !presence.size ? '该文件夹已有其他同步组。配对时请确认两台设备使用同一密钥。' : null);
      } catch (error) {
        if (signal.aborted) return status();
        presence = null;
        latestSyncIssues = [];
        ({ state: lastState, lastError } = problem(error));
      }
      if (changed) onChange();
      return status();
    }).finally(() => { currentRun = undefined; });
    return currentRun;
  }

  function close() {
    aborter.abort();
    return serial;
  }

  return { status, configure, getPairingKey, retirePeer, restorePeer, run, verifyAndRepair, close };
}
