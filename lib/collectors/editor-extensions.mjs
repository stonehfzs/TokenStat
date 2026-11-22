import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MiB, opaqueId, readJsonLog, timestamp, tokenCount } from './common.mjs';

const editors = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Antigravity'];

function editorTaskRoots(extension) {
  const home = homedir();
  const config = {
    win32: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    darwin: join(home, 'Library', 'Application Support'),
  }[process.platform] || process.env.XDG_CONFIG_HOME || join(home, '.config');
  const userDirs = editors.map((editor) => join(config, editor, 'User'));
  userDirs.push(join(home, '.vscode-server', 'data', 'User'), join(home, '.vscode-server-insiders', 'data', 'User'));
  return userDirs.map((userDir) => join(userDir, 'globalStorage', extension, 'tasks'));
}

function requestData(message) {
  if (typeof message.text !== 'string') return {};
  try {
    const data = JSON.parse(message.text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function extensionUsage(provider, data) {
  const rawInput = tokenCount(data.tokensIn);
  const rawOutput = tokenCount(data.tokensOut);
  const cached = tokenCount(data.cacheReads) ?? 0;
  const cacheWrite = tokenCount(data.cacheWrites) ?? 0;
  if (rawInput === undefined && rawOutput === undefined) return;
  // Cline stores fresh input. Roo's current writer stores gross input for both protocols.
  // The older Roo writer retained the request field and used the provider's protocol directly.
  const legacyRoo = provider === 'roo' && typeof data.request === 'string';
  const protocol = data.apiProtocol;
  if (provider === 'roo' && (cached || cacheWrite) && protocol !== 'anthropic' && protocol !== 'openai') return null;
  const input = (rawInput ?? 0) + (provider === 'cline' || (legacyRoo && protocol === 'anthropic') ? cached + cacheWrite : 0);
  const output = rawOutput ?? 0;
  const reasoning = tokenCount(data.reasoningTokens);
  if (cached + cacheWrite > input) return null;
  return { input, output, cached, cacheWrite, total: input + output, reasoning: reasoning ?? 0, reasoningKnown: reasoning !== undefined };
}

async function parseExtension(path, record, provider) {
  const { data, incomplete: unreadable } = await readJsonLog(path);
  if (!Array.isArray(data)) return { records: [], incomplete: unreadable || 1 };

  const task = basename(dirname(path));
  const requests = new Map();
  let incomplete = unreadable;
  let pending;

  function retain(request) {
    const usage = extensionUsage(provider, request.data);
    if (usage === null) incomplete++;
    if (!usage?.total) return;
    const key = `${task}:${request.date}`;
    const item = record(provider, key, request.model, request.date, usage, task);
    if (item) requests.set(item.id, item);
  }

  for (const message of data) {
    if (message?.type !== 'say') continue;
    const started = message.say === 'api_req_started';
    if (!started && message.say !== 'api_req_finished') {
      if (provider === 'cline' && (message.say === 'deleted_api_reqs' || message.say === 'subagent_usage')) {
        const bundle = requestData(message);
        // Summary rows omit the underlying request identities and dates.
        if (bundle && (tokenCount(bundle.tokensIn) || tokenCount(bundle.tokensOut))) incomplete++;
      }
      continue;
    }

    const date = timestamp(message.ts);
    const payload = requestData(message);
    if (date === undefined || payload === null) {
      incomplete++;
      continue;
    }
    const model = opaqueId(message.modelInfo?.modelId) ?? opaqueId(payload.modelId) ?? opaqueId(payload.model);
    if (started) {
      if (pending) retain(pending);
      pending = { date, model, data: payload };
      continue;
    }

    // Historical versions emitted a start/finish pair. Newer ones write usage onto the start.
    if (pending) {
      retain({ date: pending.date, model: model ?? pending.model, data: { ...pending.data, ...payload } });
      pending = undefined;
    } else {
      retain({ date, model, data: payload });
    }
  }
  if (pending) retain(pending);
  return { records: Array.from(requests.values()), incomplete };
}

function clineManifestPath(path) {
  return path.slice(0, -'.messages.json'.length) + '.json';
}

async function clineImportDate(path, session) {
  try {
    const { data } = await readJsonLog(clineManifestPath(path), MiB);
    if (data?.session_id !== session || !data.metadata?.importedFrom) return;
    return timestamp(data.metadata.importedFrom.importedAt) ?? null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function parseClineSdk(path, record) {
  const { data, incomplete: unreadable } = await readJsonLog(path);
  const session = opaqueId(data?.sessionId);
  if (data?.version !== 1 || !session || !Array.isArray(data.messages)) {
    return { records: [], incomplete: unreadable || 1 };
  }

  const importedAt = await clineImportDate(path, session);
  if (importedAt === null) return { records: [], incomplete: 1 };
  const records = new Map();
  let incomplete = 0;
  for (const message of data.messages) {
    const metrics = message?.metrics;
    if (message?.role !== 'assistant' || message.metadata?.displayOnly === true || !metrics) continue;
    if (message.sessionId && message.sessionId !== session) continue;
    const id = opaqueId(message.id);
    const date = timestamp(message.ts);
    const input = tokenCount(metrics.inputTokens) ?? 0;
    const output = tokenCount(metrics.outputTokens) ?? 0;
    const cached = tokenCount(metrics.cacheReadTokens) ?? 0;
    const cacheWrite = tokenCount(metrics.cacheWriteTokens) ?? 0;
    if (!id || date === undefined || cached + cacheWrite > input) {
      incomplete++;
      continue;
    }
    if (importedAt !== undefined && date <= importedAt) continue;
    const item = record('cline', `sdk:${id}`, opaqueId(message.modelInfo?.id), date, {
      input, output, cached, cacheWrite, total: input + output, reasoning: 0, reasoningKnown: false,
    }, session);
    if (item) records.set(item.id, item);
  }
  return { records: Array.from(records.values()), incomplete };
}

export const cline = {
  label: 'Cline',
  roots() {
    const config = process.env.CLINE_DIR || join(homedir(), '.cline');
    const data = process.env.CLINE_DATA_DIR || join(config, 'data');
    return [
      ...editorTaskRoots('saoudrizwan.claude-dev'),
      join(data, 'tasks'), join(config, 'tasks'),
      process.env.CLINE_SESSION_DATA_DIR || join(data, 'sessions'),
    ];
  },
  matches: (name) => name === 'ui_messages.json' || name.endsWith('.messages.json'),
  watchedFile: (name, path) => name === basename(dirname(path)) + '.json',
  async stamp(path) {
    if (!path.endsWith('.messages.json')) return '';
    try {
      const info = await stat(clineManifestPath(path));
      return [info.size, info.mtimeMs, info.ctimeMs].join(':');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }
  },
  parse: (path, { record }) => path.endsWith('.messages.json')
    ? parseClineSdk(path, record)
    : parseExtension(path, record, 'cline'),
};

export const roo = {
  label: 'Roo Code',
  roots: () => editorTaskRoots('rooveterinaryinc.roo-cline'),
  matches: (name) => name === 'ui_messages.json',
  parse: (path, { record }) => parseExtension(path, record, 'roo'),
};
