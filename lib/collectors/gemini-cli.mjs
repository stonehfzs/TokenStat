import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MiB, opaqueId, readJsonLog, timestamp, tokenCount } from './common.mjs';

const sessionLine = /"type"\s*:\s*"gemini"|"sessionId"\s*:/;

function normalizedUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return;
  const reasoning = tokenCount(tokens.thoughts);
  const input = (tokenCount(tokens.input) ?? 0) + (tokenCount(tokens.tool) ?? 0);
  const output = (tokenCount(tokens.output) ?? 0) + (reasoning ?? 0);
  const total = tokenCount(tokens.total) || input + output;
  if (!total) return;
  return {
    input, output, total, cached: tokenCount(tokens.cached) ?? 0, cacheWrite: 0,
    reasoning: reasoning ?? 0, reasoningKnown: reasoning !== undefined,
  };
}

async function parse(path, { forUsageLines, record }) {
  const messages = new Map();
  let session = basename(path).replace(/\.jsonl?$/, '');
  let incomplete = 0;
  let diagnostics;

  function accept(message) {
    if (message?.type !== 'gemini') return;
    const id = opaqueId(message.id);
    if (!id) return;
    const previous = messages.get(id);
    const date = timestamp(message.timestamp) ?? previous?.date;
    if (date === undefined) return;
    const usage = normalizedUsage(message.tokens) ?? previous?.usage;
    const model = opaqueId(message.model) ?? previous?.model;
    if (usage || model) messages.set(id, { date, model, usage });
  }

  if (path.endsWith('.jsonl')) {
    incomplete = await forUsageLines(path, sessionLine, 16 * MiB, (event) => {
      session = opaqueId(event?.sessionId) ?? opaqueId(event?.$set?.sessionId) ?? session;
      // Rewind and content patches change the conversation history, while calls already made still count.
      accept(event);
    });
  } else {
    const { data, incomplete: unreadable, diagnostics: jsonDiagnostics } = await readJsonLog(path);
    diagnostics = jsonDiagnostics;
    incomplete = unreadable;
    session = opaqueId(data?.sessionId) ?? session;
    if (Array.isArray(data?.messages)) data.messages.forEach(accept);
  }

  const records = [];
  for (const [id, message] of messages) {
    if (!message.usage) continue;
    const item = record('gemini-cli', id, message.model, message.date, message.usage, session);
    if (item) records.push(item);
  }
  return { records, incomplete, diagnostics };
}

export const geminiCli = {
  label: 'Gemini CLI',
  roots: () => [join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini', 'tmp')],
  matches: (name) => /^session-.*\.jsonl?$/.test(name),
  parse,
};
