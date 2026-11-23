import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { opaqueId, readJsonLog, timestamp, tokenCount } from './common.mjs';

const sqliteFile = /\.(?:db|sqlite|sqlite3)$/i;
const messageFile = /^msg_[\w-]+\.json$/u;

export function sessionDatabase(name) {
  const databaseName = new RegExp(`^${name}(?:-[\\w.-]+)?\\.db$`, 'i');
  const settings = name.toUpperCase();

  function roots() {
    const xdgRoot = isAbsolute(process.env.XDG_DATA_HOME ?? '') ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
    const dataRoot = resolve(process.env[settings + '_DATA_DIR'] || join(xdgRoot, name));
    const filename = process.env[settings + '_DB'];
    if (!filename) return [dataRoot];
    return filename === ':memory:' ? [] : [resolve(dataRoot, filename)];
  }

  function matches(filename, path, roots = []) {
    return databaseName.test(filename) || (sqliteFile.test(filename) && roots.includes(path));
  }

  return {
    roots,
    matches,
    searchDirectory(path, root) {
      const firstDirectory = relative(root, path).split(sep)[0];
      return ['storage', 'message', 'project', 'global', 'tasks'].includes(firstDirectory) || firstDirectory.startsWith('ses_');
    },
    watchSiblingRoots(path) {
      return sqliteFile.test(path) ? [dirname(path)] : [];
    },
    watchedTarget(filename, path, roots) {
      if (!filename.endsWith('-wal')) return undefined;
      const target = path.slice(0, -4);
      return matches(basename(target), target, roots) ? target : undefined;
    },
    async stamp(path) {
      if (!sqliteFile.test(path)) return '';
      try {
        const info = await stat(path + '-wal');
        return [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return '';
      }
    },
  };
}

function normalizedMessage(provider, row, record, modern) {
  const id = opaqueId(row.id);
  const session = opaqueId(row.session);
  const freshInput = tokenCount(row.input) ?? 0;
  const rawOutput = tokenCount(row.output) ?? 0;
  const reasoning = tokenCount(row.reasoning);
  const cached = tokenCount(row.cached) ?? 0;
  const cacheWrite = tokenCount(row.cacheWrite) ?? 0;
  const input = freshInput + cached + cacheWrite;
  const reasoningInOutput = !modern && row.total === input + rawOutput && (reasoning ?? 0) <= rawOutput;
  const output = rawOutput + (reasoningInOutput ? 0 : (reasoning ?? 0));
  const total = input + output;
  if (!total) return undefined;
  if (!id || !session || !Number.isSafeInteger(total)) return null;
  return record(provider, id, opaqueId(row.model), row.time, {
    input, output, total, cached, cacheWrite, reasoning: reasoning ?? 0,
    reasoningKnown: reasoning !== undefined, requestLevel: true,
  }, session);
}

export function parseSessionDatabase(path, provider, record) {
  const database = new DatabaseSync(path, { readOnly: true });
  const records = new Map();
  let incomplete = 0;
  let invalidJson = 0;
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1500; BEGIN;');
    const tableExists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    for (const table of ['message', 'session_message']) {
      if (!tableExists.get(table)) continue;
      const modern = table === 'session_message';
      // Project only usage, dates, models and identifiers out of the session database.
      const rows = database.prepare(`
        WITH messages AS (
          SELECT id, session_id, time_created, CASE WHEN json_valid(data) THEN data END AS payload
          FROM ${table} ${modern ? "WHERE type IN ('assistant', 'compaction')" : ''}
        )
        SELECT id, session_id AS session, COALESCE(json_extract(payload, '$.time.created'), time_created) AS time,
          json_extract(payload, '$.tokens.input') AS input, json_extract(payload, '$.tokens.output') AS output,
          json_extract(payload, '$.tokens.reasoning') AS reasoning, json_extract(payload, '$.tokens.total') AS total,
          json_extract(payload, '$.tokens.cache.read') AS cached, json_extract(payload, '$.tokens.cache.write') AS cacheWrite,
          COALESCE(json_extract(payload, '$.model.id'), json_extract(payload, '$.modelID')) AS model,
          payload IS NULL AS invalidJson
        FROM messages
        WHERE payload IS NULL OR (
          json_type(payload, '$.tokens') = 'object' ${modern ? '' : "AND json_extract(payload, '$.role') = 'assistant'"}
        )`);
      for (const row of rows.iterate()) {
        if (row.invalidJson) {
          invalidJson++;
          continue;
        }
        const item = normalizedMessage(provider, row, record, modern);
        if (item) records.set(item.id, item);
        else if (item === null) incomplete++;
      }
    }
  } finally {
    database.close();
  }
  return { records: [...records.values()], incomplete: incomplete + invalidJson, diagnostics: { invalidJson } };
}

async function parseLegacyMessage(path, record) {
  const { data, incomplete, diagnostics } = await readJsonLog(path);
  if (incomplete || data?.role !== 'assistant' || !data.tokens) return { records: [], incomplete, diagnostics };
  const item = normalizedMessage('opencode', {
    id: data.id ?? basename(path, '.json'), session: data.sessionID ?? basename(dirname(path)),
    time: timestamp(data.time?.created) ?? data.time?.completed, model: data.modelID,
    input: data.tokens.input, output: data.tokens.output, reasoning: data.tokens.reasoning,
    total: data.tokens.total, cached: data.tokens.cache?.read, cacheWrite: data.tokens.cache?.write,
  }, record, false);
  return { records: item ? [item] : [], incomplete: item === null ? 1 : 0 };
}

const database = sessionDatabase('opencode');

export const opencode = {
  ...database,
  label: 'OpenCode',
  matches: (name, path, roots) => messageFile.test(name) || database.matches(name, path, roots),
  parse: (path, { record }) => messageFile.test(basename(path))
    ? parseLegacyMessage(path, record)
    : parseSessionDatabase(path, 'opencode', record),
};
