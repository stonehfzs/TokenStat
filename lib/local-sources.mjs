import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { extraProviders } from './collectors/index.mjs';
import { boundarySignature, forUsageLines, readUsageLines } from './usage-lines.mjs';

const jsonMarkers = (...values) => values.map((value) => Buffer.from(JSON.stringify(value)));
const codexKinds = new Set(['session_meta', 'turn_context', 'token_usage_record', 'token_count', 'model_reroute']);
const codexCanonicalHeader = /^\{\s*"timestamp"\s*:\s*"[0-9T:.+Z-]+"\s*,\s*(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"([a-z_]+)"(?:\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)")?/;
const codexLine = {
  markers: jsonMarkers(...codexKinds),
  fastCheck(line) {
    // Canonical Codex headers identify the top-level record without reading the payload.
    // Other layouts still use the full-line marker search.
    const header = codexCanonicalHeader.exec(line.toString('ascii', 0, 384));
    if (!header) return undefined;
    const [, type, nestedType] = header;
    if (type === 'event_msg') return nestedType === undefined ? undefined : codexKinds.has(nestedType);
    return codexKinds.has(type);
  },
};
const grokLine = jsonMarkers('turn_completed');
const antigravityLine = jsonMarkers('input_tokens', 'output_tokens', 'cache_read_tokens');
const MiB = 1024 * 1024;
const fileCache = new Map();

const providers = {
  codex: {
    label: 'Codex',
    roots: () => sessionRoots(process.env.CODEX_HOME || join(homedir(), '.codex')),
    matches: (name) => /^rollout-.*\.jsonl(?:\.zst)?$/.test(name),
    parse: parseCodex,
    tail: true,
  },
  gemini: {
    label: 'Antigravity',
    roots: () => ['antigravity', 'antigravity-cli', 'antigravity-ide']
      .map((directory) => join(homedir(), '.gemini', directory, 'brain')),
    matches: (name) => name === 'transcript.jsonl',
    parse: parseAntigravity,
    tail: true,
    stamp: antigravityDatabaseStamp,
  },
  grok: {
    label: 'Grok Build',
    roots: () => sessionRoots(process.env.GROK_HOME || join(homedir(), '.grok')),
    matches: (name) => name === 'updates.jsonl',
    parse: parseGrok,
    tail: true,
  },
  ...extraProviders,
};

function sessionRoots(home) {
  return [join(home, 'sessions'), join(home, 'archived_sessions')];
}

function expandHome(path) {
  return path === '~' || /^~[/\\]/.test(path) ? join(homedir(), path.slice(2)) : resolve(path);
}

function absent(error) {
  return ['ENOENT', 'ENOTDIR'].includes(error.code);
}

const token = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

const opaqueId = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 24);

const modelLabel = /^[\p{L}\p{N}._:/() +\-]+$/u;

function record(provider, key, model, time, usage, session) {
  if (!usage?.total || (typeof time !== 'string' && typeof time !== 'number')) return;
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return;
  return {
    id: `${provider}-${opaqueId(key)}`,
    provider,
    ...(session ? { session: provider + '-' + opaqueId(session) } : {}),
    model: typeof model === 'string' && model.length <= 100 && modelLabel.test(model) ? model : '未知模型',
    date: date.toISOString(),
    ...usage,
    source: providers[provider].label,
  };
}

function codexUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = token(usage.input_tokens);
  const output = token(usage.output_tokens);
  return {
    input,
    output,
    cached: token(usage.cached_input_tokens),
    cacheWrite: token(usage.cache_write_input_tokens),
    reasoning: token(usage.reasoning_output_tokens),
    total: token(usage.total_tokens) || input + output,
  };
}

const usageKey = ({ input, output, cached, reasoning, total }) => `${input}:${output}:${cached}:${reasoning}:${total}`;

async function parseCodex(path, io) {
  const prior = io.previous;
  const state = prior?.checkpoint?.state;
  const records = new Map();
  const deletedIds = new Set();
  const legacy = new Map(state?.legacy ?? []);
  const turnModels = new Map(state?.turnModels ?? []);
  let session = state?.session ?? opaqueId(basename(path).replace(/\.zst$/, ''));
  let forked = Boolean(state?.forked);
  let hasDetailed = Boolean(state?.hasDetailed);
  let activeModel = state?.activeModel;
  let previous = state?.previous;
  const incomplete = await io.lines(codexLine, 4 * MiB, (event, index) => {
    const payload = event.payload;
    if (!payload) return;
    const type = event.type === 'event_msg' ? payload.type : event.type;
    if (type === 'session_meta') {
      const id = payload.session_id || payload.id;
      const nextSession = id ? opaqueId(id) : session;
      if (nextSession !== session) previous = undefined;
      session = nextSession;
      forked ||= Boolean(payload.forked_from_id || payload.forked_from_thread_id);
      activeModel = undefined;
      return;
    }
    if (type === 'turn_context' || type === 'model_reroute') {
      activeModel = payload.to_model || payload.model;
      if (typeof activeModel !== 'string' || activeModel.length > 100 || !modelLabel.test(activeModel)) activeModel = undefined;
      if (payload.turn_id && activeModel) turnModels.set(opaqueId(payload.turn_id), activeModel);
      return;
    }
    if (type === 'token_usage_record') {
      const usage = codexUsage(payload.usage);
      const model = payload.model || turnModels.get(opaqueId(payload.turn_id));
      const key = payload.response_id || [session, event.timestamp, event.ordinal ?? index].join(':');
      const item = record('codex', key, model, event.timestamp, usage, session);
      if (!item) return;
      if (item.model !== '未知模型') item.requestLevel = true;
      hasDetailed = true;
      records.set(item.id, item);
      const cumulative = codexUsage(payload.thread_token_usage);
      if (cumulative && legacy.size) {
        const cumulativeKey = session + ':' + usageKey(cumulative);
        for (const [id, checkpoint] of legacy) {
          if (checkpoint !== cumulativeKey) continue;
          legacy.delete(id);
          records.delete(id);
          deletedIds.add(id);
        }
      }
      return;
    }
    if (type !== 'token_count' || hasDetailed) return;
    const cumulative = codexUsage(payload.info?.total_token_usage);
    const last = codexUsage(payload.info?.last_token_usage);
    if (!cumulative) return;

    // Rate-limit updates repeat the last usage. A fork can replay a parent's cumulative checkpoint.
    const delta = previous ? Object.fromEntries(
      Object.keys(cumulative).map((key) => [key, Math.max(0, cumulative[key] - previous[key])]),
    ) : last;
    const decreased = previous && cumulative.total < previous.total;
    previous = cumulative;
    if (decreased || !delta?.total || !(last?.input || last?.output)) return;
    const cumulativeKey = session + ':' + usageKey(cumulative);
    const key = ['legacy', event.timestamp, usageKey(cumulative), usageKey(delta)].join(':');
    const turnModel = payload.turn_id ? turnModels.get(opaqueId(payload.turn_id)) : activeModel;
    const item = record('codex', key, payload.model || turnModel, event.timestamp, delta, session);
    if (item) {
      records.set(item.id, item);
      legacy.set(item.id, cumulativeKey);
    }
  });
  if (forked && hasDetailed) {
    for (const id of legacy.keys()) {
      records.delete(id);
      deletedIds.add(id);
    }
    legacy.clear();
  }
  return {
    records: [...records.values()],
    deletedIds: [...deletedIds],
    incomplete,
    tailState: { session, forked, hasDetailed, activeModel, previous, legacy: [...legacy], turnModels: [...turnModels] },
  };
}

function antigravityConversation(path) {
  const systemDirectory = dirname(dirname(path));
  const sessionDirectory = dirname(systemDirectory);
  const brainDirectory = dirname(sessionDirectory);
  if (basename(systemDirectory) !== '.system_generated' || basename(brainDirectory) !== 'brain') return null;
  const id = basename(sessionDirectory);
  return { id, database: join(dirname(brainDirectory), 'conversations', id + '.db') };
}

async function antigravityDatabaseStamp(path) {
  const conversation = antigravityConversation(path);
  if (!conversation) return '';
  const stamps = await Promise.all([conversation.database, conversation.database + '-wal'].map(async (file) => {
    try {
      const info = await stat(file);
      return [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs, info.ctimeMs].join(':');
    } catch {
      return '';
    }
  }));
  return stamps.join(':');
}

function readProtoVarint(buffer, cursor) {
  let value = 0;
  for (let shift = 0; shift < 70 && cursor.offset < buffer.length; shift += 7) {
    const byte = buffer[cursor.offset++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
  throw new Error('Malformed protobuf varint');
}

function protoFields(buffer, wanted) {
  const fields = new Map();
  if (!(buffer instanceof Uint8Array)) return fields;
  const cursor = { offset: 0 };
  while (cursor.offset < buffer.length) {
    const tag = readProtoVarint(buffer, cursor);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    let value;
    if (wireType === 0) value = readProtoVarint(buffer, cursor);
    else if (wireType === 2) {
      const size = readProtoVarint(buffer, cursor);
      const end = cursor.offset + size;
      if (wanted.includes(field)) value = buffer.subarray(cursor.offset, end);
      cursor.offset = end;
    } else if (wireType === 1 || wireType === 5) cursor.offset += wireType === 1 ? 8 : 4;
    else throw new Error('Unsupported protobuf field');
    if (!field || cursor.offset > buffer.length) throw new Error('Malformed protobuf field');
    if (value === undefined || !wanted.includes(field)) continue;
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}

const firstField = (fields, field) => fields.get(field)?.[0];

function protoStepIndices(fields) {
  const indices = [];
  for (const value of fields.get(2) ?? []) {
    if (typeof value === 'number') {
      indices.push(value);
      continue;
    }
    const cursor = { offset: 0 };
    while (cursor.offset < value.length) indices.push(readProtoVarint(value, cursor));
  }
  return indices;
}

function antigravityUsageMatches(usage, row) {
  return (firstField(usage, 2) ?? 0) === row.freshInput
    && (firstField(usage, 3) ?? 0) === row.output
    && (firstField(usage, 5) ?? 0) === row.cached;
}

function rememberModel(models, key, model) {
  models.set(key, !models.has(key) || models.get(key) === model ? model : null);
}

function exactAntigravityModel(model) {
  return typeof model === 'string'
    && /^[a-z0-9][a-z0-9._() +\-]{0,99}$/i.test(model)
    && !/(?:^|[-_. ])(?:auto|default|orchestrator|unknown)(?:$|[-_. ])/i.test(model);
}

function readAntigravityModels(database, conversation, rows) {
  const identity = database.prepare('SELECT cascade_id FROM trajectory_meta').all();
  if (identity.length !== 1 || identity[0].cascade_id !== conversation.id) return new Map();
  const verifiedSteps = new Map();
  const stepRows = database.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL');
  for (const step of stepRows.iterate()) {
    const candidates = rows.get(step.idx);
    if (!candidates) continue;
    const fields = protoFields(step.metadata, [1, 9]);
    const timestamp = firstField(protoFields(firstField(fields, 1), [1]), 1);
    const usage = protoFields(firstField(fields, 9), [1, 2, 3, 5, 9, 10]);
    const modelEnum = firstField(usage, 1);
    if (!Number.isSafeInteger(modelEnum) || !modelEnum) continue;
    const row = Array.from(candidates.values()).find((candidate) => candidate.conversation === conversation.id
      && timestamp === Math.floor(Date.parse(candidate.date) / 1000)
      && antigravityUsageMatches(usage, candidate));
    if (!row) continue;
    const reasoning = firstField(usage, 9) ?? 0;
    const response = firstField(usage, 10) ?? 0;
    verifiedSteps.set(step.idx, { row, modelEnum, reasoning: reasoning + response === row.output ? reasoning : undefined });
  }

  const byStep = new Map();
  const byEnum = new Map();
  const generations = database.prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL');
  for (const { data } of generations.iterate()) {
    // Generations record the producing model and the exact step indices created by that request.
    const fields = protoFields(data, [1, 2]);
    const chat = protoFields(firstField(fields, 1), [3, 4, 19]);
    const usage = protoFields(firstField(chat, 4), [1, 2, 3, 5]);
    const encodedModel = firstField(chat, 19);
    if (!(encodedModel instanceof Uint8Array)) continue;
    const model = Buffer.from(encodedModel).toString('utf8');
    if (!exactAntigravityModel(model)) continue;
    const modelEnum = firstField(chat, 3);
    if (modelEnum !== firstField(usage, 1)) continue;
    for (const step of protoStepIndices(fields)) {
      const verified = verifiedSteps.get(step);
      if (!verified || verified.modelEnum !== modelEnum || !antigravityUsageMatches(usage, verified.row)) continue;
      rememberModel(byStep, step, model);
      rememberModel(byEnum, modelEnum, model);
    }
  }
  const result = new Map();
  for (const [step, usage] of verifiedSteps) {
    // Checkpoints keep the model enum on their own step, without a generation row.
    // Name it only when that enum has one verified identifier in the same conversation.
    const model = usage.row.type === 'CHECKPOINT' && !byStep.has(step)
      ? byEnum.get(usage.modelEnum)
      : byStep.get(step);
    result.set(usage.row, { model, reasoning: usage.reasoning });
  }
  return result;
}

function antigravityModels(conversation, rows) {
  if (!conversation || !rows.size) return new Map();
  const immutable = pathToFileURL(conversation.database);
  immutable.searchParams.set('mode', 'ro');
  immutable.searchParams.set('immutable', '1');
  for (const location of [conversation.database, immutable]) {
    let database;
    try {
      database = new DatabaseSync(location, { readOnly: true });
      database.exec('PRAGMA busy_timeout = 1000');
      return readAntigravityModels(database, conversation, rows);
    } catch {
      // The immutable fallback can verify committed rows when SQLite cannot open its WAL sidecar.
    } finally {
      database?.close();
    }
  }
  return new Map();
}

async function parseAntigravity(path, io) {
  const conversation = antigravityConversation(path);
  const rows = new Map();
  const incomplete = await io.lines(antigravityLine, 16 * MiB, (event, index) => {
    if (!event || ['ACTIVE', 'PENDING'].includes(event.status)) return;
    const step = Number.isSafeInteger(event.step_index) ? event.step_index : index;
    const current = {
      conversation: event.conversation_id || conversation?.id || basename(dirname(path)),
      date: event.created_at,
      type: event.type,
      model: event.model_id || event.model_name || event.model,
      freshInput: token(event.input_tokens),
      output: token(event.output_tokens),
      cached: token(event.cache_read_tokens),
      reasoning: event.thinking_tokens ?? event.reasoning_tokens,
    };
    if (!current.freshInput && !current.output && !current.cached) return;
    if (!rows.has(step)) rows.set(step, new Map());
    rows.get(step).set([current.conversation, Date.parse(current.date)].join(':'), current);
  });

  const metadata = antigravityModels(conversation, rows);
  const items = [];
  for (const [step, entries] of rows) {
    for (const row of entries.values()) {
      const verified = metadata.get(row);
      const key = [row.conversation, step, row.date].join(':');
      const loggedModel = exactAntigravityModel(row.model) ? row.model : undefined;
      const model = verified?.model || loggedModel;
      const thinking = row.reasoning ?? verified?.reasoning;
      // Antigravity records fresh and cached prompt tokens in separate counters.
      const input = row.freshInput + row.cached;
      const item = record('gemini', key, model, row.date, {
        input,
        output: row.output,
        cached: row.cached,
        reasoning: token(thinking),
        reasoningKnown: Number.isSafeInteger(thinking) && thinking >= 0,
        total: input + row.output,
      }, row.conversation);
      if (item) items.push(item);
    }
  }
  return { records: items, incomplete };
}

function grokCostIsComplete(usage) {
  return !usage.costIsPartial && !usage.cost_is_partial
    && !usage.usageIsIncomplete && !usage.usage_is_incomplete;
}

function grokUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = token(usage.inputTokens);
  const output = token(usage.outputTokens);
  // xAI uses zero when the server did not report a cost.
  const costUsdTicks = token(usage.costUsdTicks);
  return {
    input,
    output,
    cached: token(usage.cachedReadTokens),
    reasoning: token(usage.reasoningTokens),
    total: token(usage.totalTokens) || input + output,
    ...(costUsdTicks > 0 && grokCostIsComplete(usage) ? { costUsdTicks } : {}),
  };
}

const grokTokenFields = {
  input: 'inputTokens',
  output: 'outputTokens',
  cached: 'cachedReadTokens',
  reasoning: 'reasoningTokens',
  total: 'totalTokens',
};

function grokBreakdown(usage) {
  const turn = grokUsage(usage);
  if (!turn) return [];
  const models = Object.entries(usage.modelUsage ?? {})
    .map(([model, value]) => [model, grokUsage(value)])
    .filter(([, value]) => value?.total);
  if (!grokCostIsComplete(usage)) for (const [, value] of models) delete value.costUsdTicks;
  if (!turn.total) return models;

  const remaining = {};
  for (const [key, field] of Object.entries(grokTokenFields)) {
    const known = key === 'total' || (Number.isSafeInteger(usage[field]) && usage[field] >= 0);
    const assigned = models.reduce((sum, [, value]) => sum + value[key], 0);
    remaining[key] = known ? turn[key] - assigned : 0;
  }
  // An incompatible breakdown cannot assign the exact turn total to individual models.
  if (Object.values(remaining).some((value) => value < 0)) return [[undefined, turn]];

  const assignedTicks = models.reduce((sum, [, value]) => sum + (value.costUsdTicks ?? 0), 0);
  const turnTicks = turn.costUsdTicks;
  const conflictingCost = !Number.isSafeInteger(assignedTicks)
    || (turnTicks !== undefined && assignedTicks > turnTicks);
  if (conflictingCost) for (const [, value] of models) delete value.costUsdTicks;
  if (remaining.total) {
    if (!conflictingCost && turnTicks !== undefined && models.every(([, value]) => value.costUsdTicks !== undefined)) {
      remaining.costUsdTicks = turnTicks - assignedTicks;
    }
    models.push([undefined, remaining]);
  }
  return models;
}

async function parseGrok(path, io) {
  const items = [];
  const incomplete = await io.lines(grokLine, 4 * MiB, (event, index) => {
    const { update, sessionId, _meta: metadata } = event.params ?? {};
    if (update?.sessionUpdate !== 'turn_completed' || !update.usage) return;

    const timestamp = event.timestamp ?? metadata?.agentTimestampMs;
    const time = typeof timestamp === 'number' && timestamp > 0 && timestamp < 10 ** 11 ? timestamp * 1000 : timestamp;
    const turn = update.prompt_id || metadata?.eventId || `${time}:${index}`;
    const session = sessionId || basename(dirname(path));
    const key = `${session}:${turn}`;
    for (const [model, value] of grokBreakdown(update.usage)) {
      const item = record('grok', `${key}:${model ?? ''}`, model, time, value, session);
      if (item) items.push(item);
    }
  });
  return { records: items, incomplete };
}

function completeResult(prior, result) {
  if (!result.append) return result;
  const records = new Map(prior.records.map((item) => [item.id, item]));
  for (const id of result.deletedIds ?? []) records.delete(id);
  for (const item of result.records) records.set(item.id, item);
  return { records: [...records.values()], incomplete: result.incomplete, checkpoint: result.checkpoint };
}

async function findFiles(root, match, files, allowMissing) {
  try {
    const rootInfo = await stat(root);
    if (rootInfo.isFile()) {
      if (match(basename(root), root)) files.push(root);
      return 0;
    }
    if (!rootInfo.isDirectory()) return 1;
  } catch (error) {
    return allowMissing && absent(error) ? 0 : 1;
  }
  const directories = [root];
  let failed = 0;
  while (directories.length) {
    const directory = directories.pop();
    try {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) directories.push(path);
        if (item.isFile() && match(item.name, path)) files.push(path);
      }
    } catch (error) {
      if (!absent(error)) failed++;
    }
  }
  return failed;
}

const cacheRevision = 4;

function configuredPaths(settings, provider, config) {
  const value = settings.paths?.[provider];
  const custom = typeof value === 'string' ? value.trim() : '';
  return { custom, roots: custom ? [expandHome(custom)] : config.roots() };
}

function antigravityWatchRoots(root) {
  const conversation = antigravityConversation(root);
  if (conversation) return [conversation.database, conversation.database + '-wal'];
  let candidate = root;
  while (dirname(candidate) !== candidate) {
    if (basename(candidate) === 'brain') return [join(dirname(candidate), 'conversations')];
    candidate = dirname(candidate);
  }
  return [];
}

export function localWatchRoots(settings = {}) {
  const watched = new Set();
  for (const [provider, config] of Object.entries(providers)) {
    const { custom, roots } = configuredPaths(settings, provider, config);
    for (const root of roots) {
      watched.add(root);
      if (provider === 'gemini') for (const sibling of antigravityWatchRoots(root)) watched.add(sibling);
    }
    if (!custom && config.watchRoots) for (const root of config.watchRoots()) watched.add(root);
  }
  return [...watched];
}

export function isWatchedLog(path, settings) {
  if (!path) return true;
  const name = basename(path);
  if (basename(dirname(path)) === 'conversations' && /\.db(?:-wal)?$/i.test(name)) return true;
  return Object.entries(providers).some(([provider, config]) => {
    if (!config.matches(name, path) && !config.watchedFile?.(name, path)) return false;
    return !settings || configuredPaths(settings, provider, config).roots.some((root) => insideRoot(path, root));
  });
}

export function localLogTargets(path, settings = {}) {
  const targets = [];
  const name = basename(path);
  for (const [provider, config] of Object.entries(providers)) {
    const antigravityDatabase = provider === 'gemini' && basename(dirname(path)) === 'conversations'
      && /\.db(?:-wal)?$/i.test(name);
    const clineManifest = provider === 'cline' && config.watchedFile?.(name, path);
    const direct = config.matches(name, path);
    if (!antigravityDatabase && !clineManifest && !direct) continue;
    const { roots } = configuredPaths(settings, provider, config);
    const inScope = (candidate) => roots.some((root) => insideRoot(candidate, root));
    if (antigravityDatabase) {
      const session = name.replace(/\.db(?:-wal)?$/i, '');
      const log = join(dirname(dirname(path)), 'brain', session, '.system_generated', 'logs', 'transcript.jsonl');
      if (inScope(log)) targets.push([provider, log]);
      continue;
    }
    if (clineManifest) {
      const log = path.slice(0, -5) + '.messages.json';
      if (inScope(log)) targets.push([provider, log]);
    }
    if (!inScope(path) || !direct) continue;
    targets.push([provider, path]);
    if (provider === 'codex') {
      const sibling = path.endsWith('.zst') ? path.slice(0, -4) : path + '.zst';
      if (inScope(sibling)) targets.push([provider, sibling]);
    }
  }
  return targets;
}

async function fileVersion(config, path) {
  const file = await stat(path);
  if (!file.isFile()) throw new Error('Usage log is not a regular file');
  const extra = config.stamp ? await config.stamp(path) : '';
  const identity = [file.dev, file.ino, file.birthtimeMs];
  const version = { revision: cacheRevision, identity, size: file.size, mtime: file.mtimeMs, ctime: file.ctimeMs, extra };
  return { file, version, stamp: JSON.stringify(version) };
}

function previousVersion(entry) {
  try {
    return entry ? JSON.parse(entry.stamp) : null;
  } catch {
    return null;
  }
}

function grewInPlace(before, current) {
  return before?.revision === cacheRevision && before.size < current.size
    && Number.isSafeInteger(current.identity[1]) && current.identity[1] > 0
    && Array.isArray(before.identity) && before.identity.length === current.identity.length
    && before.identity.every((value, index) => value === current.identity[index])
    && before.extra === current.extra;
}

async function parseVersion(config, path, snapshot, prior) {
  const { file, version } = snapshot;
  const resumable = config.tail && path.endsWith('.jsonl');
  const checkpoint = prior?.checkpoint;
  const previous = checkpoint && Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= 0
    && checkpoint.offset <= version.size && checkpoint.signature
    && checkpoint.signature === await boundarySignature(path, checkpoint.offset) ? prior : undefined;

  let nextCheckpoint;
  const io = {
    file, record, forUsageLines, previous,
    async lines(matcher, limit, onEvent) {
      const lineResult = await readUsageLines(path, matcher, limit, onEvent, {
        size: file.size,
        checkpoint: resumable,
        offset: previous?.checkpoint.offset,
        lineNumber: previous?.checkpoint.lineNumber,
      });
      nextCheckpoint = lineResult.checkpoint;
      return (previous?.incomplete ?? 0) + lineResult.incomplete;
    },
  };
  const { tailState, ...result } = await config.parse(path, io);
  if (previous) result.append = true;
  if (nextCheckpoint) {
    const signature = await boundarySignature(path, nextCheckpoint.offset);
    if (signature) result.checkpoint = { ...nextCheckpoint, signature, state: tailState };
  }
  return result;
}

function insideRoot(path, root) {
  const remainder = relative(root, path);
  return !remainder || (!isAbsolute(remainder) && remainder.split(sep)[0] !== '..');
}

async function scanProvider(provider, config, settings, options) {
  const { cache, revalidate, changedFiles } = options;
  const files = [];
  const { custom, roots } = configuredPaths(settings, provider, config);
  const targets = changedFiles?.get(provider);
  let discoveryFailures = 0;
  if (targets) {
    // Targets are already provider-scoped and resolved by the watcher.
    for (const path of targets) {
      try {
        if ((await stat(path)).isFile()) files.push(path);
      } catch (error) {
        if (!absent(error)) discoveryFailures++;
      }
    }
  } else {
    for (const root of roots) discoveryFailures += await findFiles(root, config.matches, files, !custom);
  }

  const fileSet = new Set(files);
  const candidates = [...fileSet].filter((path) => !path.endsWith('.zst') || !fileSet.has(path.slice(0, -4)));
  const previousCache = cache ? cache.list(provider) : (fileCache.get(provider) ?? new Map());
  const nextCache = new Map(previousCache);
  const updates = [];
  const removed = [];
  const seen = new Set(candidates);
  let failed = discoveryFailures;
  let cursor = 0;

  for (const path of previousCache.keys()) {
    if (seen.has(path)) continue;
    if (targets && !targets.has(path)) continue;
    if (discoveryFailures && !fileSet.has(path) && roots.some((root) => insideRoot(path, root))) continue;
    removed.push(path);
    nextCache.delete(path);
  }

  async function scanFile(path) {
    const previous = previousCache.get(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await fileVersion(config, path);
      if (!revalidate && previous?.stamp === snapshot.stamp) return;
      const oldVersion = previousVersion(previous);
      const partialWrites = typeof cache?.applyChanges === 'function';
      const oneFilePrior = !revalidate && config.tail && path.endsWith('.jsonl') && grewInPlace(oldVersion, snapshot.version)
        ? (cache ? (partialWrites ? cache.getCheckpoint(provider, path) : cache.get(provider, path)) : previous?.result)
        : undefined;
      const parsed = await parseVersion(config, path, snapshot, oneFilePrior);
      const result = partialWrites ? parsed : completeResult(oneFilePrior, parsed);
      const after = await fileVersion(config, path);
      if (after.stamp !== snapshot.stamp) continue;
      const { stamp } = snapshot;
      const summary = { stamp, count: result.records.length, incomplete: result.incomplete };
      if (cache) {
        nextCache.set(path, summary);
        updates.push({ path, stamp, result });
      } else {
        nextCache.set(path, { ...summary, result });
      }
      return;
    }
    if (!targets || !previous) failed++;
  }

  async function worker() {
    while (cursor < candidates.length) {
      const path = candidates[cursor++];
      try {
        await scanFile(path);
      } catch (error) {
        if (!absent(error)) failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));

  const records = new Map();
  let count;
  let changed = updates.length > 0 || removed.length > 0;
  if (cache) {
    if (cache.applyChanges) {
      ({ count, changed } = cache.applyChanges(provider, { updates, removed }));
    } else {
      count = cache.apply(provider, { updates, removed });
    }
  } else {
    fileCache.set(provider, nextCache);
    for (const path of nextCache.keys()) {
      for (const item of nextCache.get(path).result.records) records.set(item.id, item);
    }
    count = records.size;
  }
  const skipped = [...nextCache.values()].reduce((sum, summary) => sum + summary.incomplete, 0);
  const warnings = [
    failed > 0 ? failed + ' 个路径或文件无法读取或正在变动' : '',
    skipped > 0 ? skipped + ' 条日志不完整或超出读取限制' : '',
  ].filter(Boolean).join('，');
  let status = 'connected';
  let message = '已读取 ' + count + ' 条本地 Token 用量记录';
  if (!count && failed) {
    status = 'error';
    message = custom ? '无法读取指定路径，请检查路径和权限' : '无法读取本地日志，请检查文件权限';
  } else if (nextCache.size === 0 && !count) {
    status = 'missing';
    message = custom ? '指定位置未找到支持的日志文件' : '未检测到本地会话日志';
  } else if (!count) {
    status = 'unsupported';
    message = '检测到会话日志，暂无可统计的 Token 记录';
  }
  if (warnings) message += '。' + warnings;
  return {
    records: [...records.values()],
    source: { provider, status, count, message },
    changed,
  };
}

export async function collectLocal(settings = {}, options = {}) {
  const previous = new Map((options.previousSources ?? []).map((source) => [source.provider, source]));
  const results = await Promise.all(Object.entries(providers).map(([provider, config]) => {
    if (options.cache && options.changedFiles && !options.changedFiles.has(provider) && previous.has(provider)) {
      return { source: previous.get(provider), changed: false };
    }
    return scanProvider(provider, config, settings, options);
  }));
  const sources = results.map(({ source }) => source);
  return options.cache
    ? { sources, changed: results.some(({ changed }) => changed) }
    : { records: results.flatMap(({ records }) => records), sources };
}
