import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const version = 1;
const folderName = 'TokenStat-sync';
const snapshotSuffix = '.snapshot';
const magic = Buffer.from('TSTAT-SYNC-1\n');
const nonceBytes = 12;
const tagBytes = 16;
const maxPacket = 16 * 1024 * 1024;
const maxCleartext = 96 * 1024 * 1024;
const maxRecords = 250_000;
const maxPeers = 32;
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
  return { id: id.toString('base64url'), encryption: material.subarray(0, 32) };
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

async function encryptedSnapshot(local, deviceName, group, signal) {
  const clean = snapshotShape({ ...local, deviceName, version }, local.deviceId);
  const raw = Buffer.from(JSON.stringify({ version, ...clean }));
  if (raw.length > maxCleartext) throw new Error('本机同步记录超出大小上限。');
  const zipped = await pack(raw, { level: 3 });
  signal.throwIfAborted();
  if (zipped.length + magic.length + nonceBytes + tagBytes > maxPacket) throw new Error('本机同步记录超出大小上限。');
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', group.encryption, nonce);
  cipher.setAAD(aad(group, local.deviceId));
  return Buffer.concat([magic, nonce, cipher.update(zipped), cipher.final(), cipher.getAuthTag()]);
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

async function readSnapshot(path, signal) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxPacket || before.size < magic.length + nonceBytes + tagBytes) throw new Error('同步文件大小无效。');
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
  const storage = await safeDirectory(join(base, 'v' + version));
  const otherGroups = (await readdir(storage, { withFileTypes: true }))
    .some((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{22}$/u.test(entry.name) && entry.name !== group.id);
  const directory = await safeDirectory(join(storage, group.id));
  return { directory, otherGroups };
}

function publicPeer(peer, presence) {
  return {
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    revision: peer.revision,
    count: peer.count,
    syncedAt: peer.syncedAt,
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
    '本机同步版本低于共享文件中的版本。', '每台设备最多同步 250,000 条用量记录。'].includes(error?.message)) {
    return { state: 'error', lastError: error.message };
  }
  return { state: 'error', lastError: '暂时无法完成同步，下次会自动重试。' };
}

export function createSync(store, { onChange = () => {} } = {}) {
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
    const hasKey = Boolean(keyBytes(saved?.key));
    return {
      enabled: saved?.enabled === true,
      configured: Boolean(saved?.folder && hasKey),
      folder: saved?.folder ?? '',
      deviceName: saved?.deviceName ?? '',
      keyId: hasKey ? groupFor(saved.key).id : null,
      state: saved?.enabled ? lastState : 'disabled',
      lastSyncAt,
      lastError,
      peers: store.readSyncPeers().map((peer) => publicPeer(peer, saved?.enabled ? presence : null)),
    };
  }

  function enqueue(work) {
    const task = serial.then(() => { signal.throwIfAborted(); return work(); });
    serial = task.catch(() => {});
    return task;
  }

  function configure(input = {}) {
    return enqueue(() => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('同步设置无效。');
      const prior = store.getSyncConfig();
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('同步开关无效。');
      const enabled = input.enabled ?? prior?.enabled ?? false;
      const folder = input.folder === undefined ? prior?.folder ?? '' : normalizedFolder(input.folder);
      const defaultName = '设备 ' + store.getSyncIdentity().deviceId.slice(0, 6);
      const deviceName = input.deviceName === undefined || input.deviceName === ''
        ? prior?.deviceName || defaultName
        : deviceLabel(input.deviceName);
      let key = prior?.key ?? '';
      let pairingKey;
      if (input.key !== undefined) {
        if (typeof input.key !== 'string') throw new Error('配对密钥无效。');
        const replacement = input.key.trim();
        if (replacement) {
          if (!keyBytes(replacement)) throw new Error('配对密钥必须是 43 位 TokenStat 配对字符串。');
          key = replacement;
        }
      }
      if (enabled && !folder) throw new Error('请先设置同步文件夹。');
      if (enabled && !key) key = pairingKey = randomBytes(32).toString('base64url');
      const keyChanged = Boolean(prior?.key && prior.key !== key);
      const locationChanged = prior?.folder !== folder || keyChanged;
      const { clearedPeers } = store.setSyncConfig({ enabled, folder, key, deviceName }, { clearPeers: keyChanged });
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

  async function publish(directory, group, deviceName) {
    const identity = store.getSyncIdentity();
    if (!devicePattern.test(identity.deviceId) || !safeInteger(identity.revision)) throw new Error('本机同步标识无效。');
    const path = join(directory, identity.deviceId + snapshotSuffix);
    let current;
    try {
      current = await lstat(path);
      if (!current.isFile()) throw new Error('同步目录结构无效。');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const currentSignature = current && signature(current);
    if (currentSignature && outbound?.signature === currentSignature) {
      if (outbound.revision > identity.revision) throw new Error('本机同步版本低于共享文件中的版本。');
      if (outbound.revision === identity.revision) return;
    } else if (currentSignature) {
      try {
        const saved = await readSnapshot(path, signal);
        const existing = await decryptSnapshot(saved.packet, identity.deviceId, group, signal);
        if (existing.revision > identity.revision) throw new Error('本机同步版本低于共享文件中的版本。');
        if (existing.revision === identity.revision) {
          outbound = { revision: identity.revision, signature: saved.signature };
          return;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error.message === '本机同步版本低于共享文件中的版本。') throw error;
        // A damaged or partially hydrated copy can be rebuilt using this device's local data.
      }
    }
    const local = store.readOwnSyncRecords();
    const packet = await encryptedSnapshot(local, deviceName, group, signal);
    await atomicWrite(path, directory, packet, signal);
    const saved = await lstat(path);
    outbound = { revision: local.revision, signature: signature(saved) };
  }

  async function receive(directory, group, own) {
    const peers = new Map(store.readSyncPeers().map((peer) => [peer.deviceId, peer]));
    const peersPresent = new Set();
    const filenames = await readdir(directory, { withFileTypes: true });
    const candidates = filenames
      .filter((entry) => entry.isFile() && entry.name.endsWith(snapshotSuffix))
      .map((entry) => ({ id: entry.name.slice(0, -snapshotSuffix.length), filename: entry.name }))
      .filter(({ id }) => id !== own && devicePattern.test(id))
      .sort((a, b) => Number(peers.has(b.id)) - Number(peers.has(a.id)) || a.id.localeCompare(b.id));
    let changed = false;
    let staleCount = 0;
    let errorCount = Math.max(0, candidates.length - maxPeers);

    for (const { id, filename } of candidates.slice(0, maxPeers)) {
      signal.throwIfAborted();
      const path = join(directory, filename);
      try {
        const info = await lstat(path);
        if (!info.isFile()) continue;
        const currentSignature = signature(info);
        if (peers.get(id)?.signature === currentSignature) {
          peersPresent.add(id);
          continue;
        }
        const cached = fingerprints.get(id);
        if (cached?.signature === currentSignature) {
          if (cached.stale) staleCount++;
          else if (cached.valid) peersPresent.add(id);
          else errorCount++;
          continue;
        }
        const current = await readSnapshot(path, signal);
        let remote;
        try {
          remote = await decryptSnapshot(current.packet, id, group, signal);
        } catch (error) {
          signal.throwIfAborted();
          fingerprints.set(id, { signature: current.signature, valid: false });
          throw error;
        }
        signal.throwIfAborted();
        if (remote.revision < (peers.get(id)?.revision ?? 0)) {
          staleCount++;
          fingerprints.set(id, { signature: current.signature, stale: true });
          continue;
        }
        const result = store.applySyncSnapshot({ ...remote, signature: current.signature });
        changed ||= result.changed;
        peersPresent.add(id);
        fingerprints.set(id, { signature: current.signature, valid: true });
      } catch (error) {
        signal.throwIfAborted();
        if (missing(error)) continue;
        errorCount++;
      }
    }
    const presentIds = new Set(candidates.map(({ id }) => id));
    for (const id of fingerprints.keys()) if (!presentIds.has(id)) fingerprints.delete(id);
    return { changed, peersPresent, errorCount, staleCount };
  }

  function run() {
    if (currentRun) return currentRun;
    currentRun = enqueue(async () => {
      const config = store.getSyncConfig();
      if (!config?.enabled) return status();
      lastState = 'syncing';
      let changed = false;
      try {
        const group = groupFor(config.key);
        const { directory, otherGroups } = await directoryFor(config.folder, group);
        signal.throwIfAborted();
        let outboundIssue;
        try {
          await publish(directory, group, config.deviceName);
        } catch (error) {
          signal.throwIfAborted();
          outboundIssue = problem(error);
        }
        const result = await receive(directory, group, store.getSyncIdentity().deviceId);
        changed = result.changed;
        presence = result.peersPresent;
        lastSyncAt = new Date().toISOString();
        lastState = outboundIssue?.state ?? (result.errorCount ? 'error' : 'ok');
        lastError = outboundIssue?.lastError
          ?? (result.errorCount ? '部分设备的同步文件暂时无法读取或校验。' : null)
          ?? (result.staleCount ? '发现较旧的同步文件，已经保留该设备最近收到的用量。' : null)
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

  return { status, configure, run, close };
}
