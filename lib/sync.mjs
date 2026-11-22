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
const providers = new Set(['codex', 'gemini', 'grok', 'claude', 'gemini-cli', 'cline', 'roo', 'other']);
const metrics = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'];
const unpack = promisify(gunzip);
const pack = promisify(gzip);

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

async function openMonthly(packet, group, address, signal, limit = maxCleartext) {
  const start = monthlyMagic.length;
  const end = packet.length - tagBytes;
  if (end <= start + nonceBytes || !packet.subarray(0, start).equals(monthlyMagic)) throw new Error('同步文件格式无效。');
  const cipher = createDecipheriv('aes-256-gcm', group.monthlyEncryption, packet.subarray(start, start + nonceBytes));
  cipher.setAAD(Buffer.from('TokenStat/2/' + group.id + '/' + address));
  cipher.setAuthTag(packet.subarray(end));
  const zipped = Buffer.concat([cipher.update(packet.subarray(start + nonceBytes, end)), cipher.final()]);
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

async function decryptSnapshot(packet, deviceId, group, signal) {
  const start = magic.length;
  const end = packet.length - tagBytes;
  if (end <= start + nonceBytes || !packet.subarray(0, start).equals(magic)) throw new Error('同步文件格式无效。');
  const cipher = createDecipheriv('aes-256-gcm', group.encryption, packet.subarray(start, start + nonceBytes));
  cipher.setAAD(aad(group, deviceId));
  cipher.setAuthTag(packet.subarray(end));
  const encrypted = packet.subarray(start + nonceBytes, end);
  const zipped = Buffer.concat([cipher.update(encrypted), cipher.final()]);
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

async function atomicWrite(path, directory, bytes, signal) {
  const temporary = join(directory, '.' + randomBytes(16).toString('hex') + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true, signal });
    for (let attempt = 0; ; attempt++) {
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
  let memoizedGroup;
  let outbound;
  let presence = null;
  let lastSyncAt = null;
  let lastError = null;
  let lastState = 'ready';
  const fingerprints = new Map();

  function groupFor(key) {
    if (memoizedGroup?.key !== key) memoizedGroup = { key, group: keys(key) };
    return memoizedGroup.group;
  }

  function status() {
    const saved = store.getSyncConfig();
    const keyId = saved?.keyId || (keyBytes(saved?.key) ? groupFor(saved.key).id : null);
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

  async function publish(directory, group, deviceName) {
    const local = store.readOwnSyncPlan();
    if (!devicePattern.test(local.deviceId) || !safeInteger(local.revision) || local.months.length > maxMonths) {
      throw new Error('本机同步记录超出大小上限。');
    }
    const path = join(directory, local.deviceId + manifestSuffix);
    const existingSignature = await fileStamp(path);
    let prior;
    if (existingSignature && outbound?.signature === existingSignature) {
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

    const months = [];
    let count = 0;
    for (const { month, revision } of local.months) {
      signal.throwIfAborted();
      const unchanged = prior?.months.get(month);
      const previousPath = unchanged?.count ? shardPath(directory, local.deviceId, unchanged) : undefined;
      const previousExists = previousPath ? Boolean(await fileStamp(previousPath)) : false;
      let next;
      if (unchanged?.generation === revision && (!unchanged.count || previousExists)) {
        next = unchanged;
      } else {
        const entries = store.readOwnSyncMonth(month, revision);
        if (!entries) return; // A newer local revision will be published at the next check.
        if (!entries.length) {
          next = { month, generation: revision, count: 0, slot: null, digest: null };
        } else {
          const raw = Buffer.from(JSON.stringify({
            version: monthlyVersion, type: 'month', deviceId: local.deviceId, month, records: entries.map(wireRecord),
          }));
          const digest = digestFor(group, raw);
          const sameRecords = unchanged?.digest === digest && unchanged.count === entries.length;
          const slot = sameRecords ? unchanged.slot : unchanged?.slot === 0 ? 1 : 0;
          next = { month, generation: revision, count: entries.length, slot, digest };
          if (!sameRecords || !previousExists) {
            const encrypted = await sealMonthly(raw, group, shardAddress(local.deviceId, next), signal);
            await atomicWrite(shardPath(directory, local.deviceId, next), directory, encrypted, signal);
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
      return;
    }
    if (store.getSyncIdentity().revision !== local.revision) return;
    const raw = Buffer.from(JSON.stringify({
      version: monthlyVersion, type: 'manifest', deviceId: local.deviceId, deviceName, revision: local.revision, months,
    }));
    // The currently committed manifest always continues to reference the other slot until this commit.
    const encrypted = await sealMonthly(raw, group, manifestAddress(local.deviceId), signal, maxManifest);
    if (await fileStamp(path) !== existingSignature) return;
    await atomicWrite(path, directory, encrypted, signal);
    outbound = {
      signature: await fileStamp(path),
      manifest: { deviceId: local.deviceId, deviceName, revision: local.revision, months: new Map(months.map((item) => [item.month, item])) },
    };
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

  async function changedShards(directory, group, manifest, currentPeer) {
    const previous = currentPeer?.protocol === monthlyVersion
      ? new Map(store.readSyncPeerMonths(manifest.deviceId).map((descriptor) => [descriptor.month, descriptor]))
      : new Map();
    const required = [...manifest.months.values()].filter((item) => item.count &&
      (previous.get(item.month)?.digest !== item.digest || previous.get(item.month)?.count !== item.count));
    const paths = required.map((descriptor) => ({ descriptor, path: shardPath(directory, manifest.deviceId, descriptor) }));
    // Folder providers may deliver the manifest first. Probe all dependencies before decoding any month's data.
    for (const { path } of paths) if (!await fileStamp(path)) return null;
    const complete = [];
    for (const { descriptor, path } of paths) {
      const part = await readSnapshot(path, signal);
      const raw = await openMonthly(part.packet, group, shardAddress(manifest.deviceId, descriptor), signal);
      complete.push({ month: descriptor.month, records: readShard(raw, group, manifest.deviceId, descriptor) });
    }
    return complete;
  }

  async function receive(directory, legacyDirectory, group, own) {
    const peers = new Map(store.readSyncPeers().map((peer) => [peer.deviceId, peer]));
    const retired = new Set(store.readRetiredSyncPeers().map((peer) => peer.deviceId));
    const peersPresent = new Set();
    const candidates = new Map();
    for (const [format, folder, suffix] of [[version, legacyDirectory, snapshotSuffix], [monthlyVersion, directory, manifestSuffix]]) {
      for (const { id, path } of await listSnapshots(folder, suffix)) {
        if (id !== own && !retired.has(id)) candidates.set(id, { format, path });
      }
    }
    const ordered = [...candidates].sort(([a], [b]) => Number(peers.has(b)) - Number(peers.has(a)) || a.localeCompare(b));
    let changed = false;
    let staleCount = 0;
    let pendingCount = 0;
    let errorCount = Math.max(0, candidates.size - maxPeers);

    for (const [id, { format, path }] of ordered.slice(0, maxPeers)) {
      signal.throwIfAborted();
      const currentPeer = peers.get(id);
      if (format < currentPeer?.protocol) {
        staleCount++;
        continue;
      }
      try {
        const actualStamp = await fileStamp(path);
        if (!actualStamp) continue;
        const stamp = format === monthlyVersion ? 'v2:' + actualStamp : actualStamp;
        if (currentPeer?.signature === stamp) {
          peersPresent.add(id);
          continue;
        }
        const cached = fingerprints.get(id);
        if (cached?.signature === stamp && (currentPeer || cached.invalid)) {
          if (cached.stale) staleCount++;
          else if (cached.invalid) errorCount++;
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
            fingerprints.set(id, { signature: readStamp, invalid: true });
            throw error;
          }
          // Cache only the small authenticated manifest, never pending peer record payloads.
          if (format === monthlyVersion) fingerprints.set(id, { signature: readStamp, manifest: remote });
        }
        signal.throwIfAborted();
        if (remote.revision < (currentPeer?.revision ?? 0)) {
          staleCount++;
          fingerprints.set(id, { signature: readStamp, stale: true });
          continue;
        }
        if (remote.revision === currentPeer?.revision && format === currentPeer.protocol) {
          peersPresent.add(id);
          fingerprints.set(id, { signature: readStamp, valid: true });
          continue;
        }

        let result;
        if (format === monthlyVersion) {
          const shards = await changedShards(directory, group, remote, currentPeer);
          if (shards === null) {
            pendingCount++;
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
        if (missing(error)) {
          pendingCount++;
          continue;
        }
        errorCount++;
      }
    }
    for (const id of fingerprints.keys()) if (!candidates.has(id)) fingerprints.delete(id);
    return { changed, peersPresent, errorCount, staleCount, pendingCount };
  }

  function retirePeer(deviceId) {
    return enqueue(() => {
      const result = store.retireSyncPeer(deviceId);
      fingerprints.delete(deviceId);
      presence?.delete(deviceId);
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

  return { status, configure, getPairingKey, retirePeer, restorePeer, run, close };
}
