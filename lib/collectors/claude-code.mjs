import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MiB, opaqueId, timestamp, tokenCount } from './common.mjs';

const assistantLine = /"(?:role|type)"\s*:\s*"assistant"/;

async function parse(path, { forUsageLines, record }) {
  const messages = new Map();
  const fallbackSession = basename(path, '.jsonl');
  const incomplete = await forUsageLines(path, assistantLine, 16 * MiB, (event) => {
    const message = event?.message;
    if (event?.type !== 'assistant' || message?.model === '<synthetic>') return;
    const id = opaqueId(message?.id);
    const date = timestamp(event.timestamp);
    const usage = message?.usage;
    if (!id || date === undefined || !usage || typeof usage !== 'object') return;

    let entry = messages.get(id);
    if (!entry) {
      entry = { date, session: opaqueId(event.sessionId) ?? fallbackSession, model: opaqueId(message.model) };
      messages.set(id, entry);
    }
    if (date < entry.date) {
      entry.date = date;
      entry.session = opaqueId(event.sessionId) ?? fallbackSession;
    }
    if (!entry.model) entry.model = opaqueId(message.model);

    // Anthropic message usage snapshots are cumulative and can carry different field subsets.
    const cacheCreation = usage.cache_creation;
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens)
      ?? (tokenCount(cacheCreation?.ephemeral_1h_input_tokens) ?? 0) + (tokenCount(cacheCreation?.ephemeral_5m_input_tokens) ?? 0);
    const fields = {
      fresh: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cached: tokenCount(usage.cache_read_input_tokens),
      cacheWrite,
      reasoning: tokenCount(usage.output_tokens_details?.thinking_tokens),
    };
    for (const [key, amount] of Object.entries(fields)) {
      if (amount !== undefined) entry[key] = Math.max(entry[key] ?? 0, amount);
    }
  });

  const records = [];
  for (const [id, entry] of messages) {
    const cached = entry.cached ?? 0;
    const cacheWrite = entry.cacheWrite ?? 0;
    const input = (entry.fresh ?? 0) + cached + cacheWrite;
    const output = entry.output ?? 0;
    const item = record('claude', id, entry.model, entry.date, {
      input, output, cached, cacheWrite, total: input + output,
      reasoning: entry.reasoning ?? 0, reasoningKnown: entry.reasoning !== undefined,
    }, entry.session);
    if (item) records.push(item);
  }
  return { records, incomplete };
}

export const claudeCode = {
  label: 'Claude Code',
  roots: () => [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')],
  matches: (name) => name.endsWith('.jsonl'),
  parse,
};
