import { createHash } from 'node:crypto';
import { extname } from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_COLUMNS = 100;
const WRAPPER_KEYS = ['records', 'data', 'items', 'results', 'responses', 'batch_result', 'response', 'chat_get_completion', 'body'];
const PROVIDERS = new Map([
  ['codex', 'codex'], ['openai codex', 'codex'],
  ['gemini', 'gemini'], ['google gemini', 'gemini'],
  ['antigravity', 'gemini'], ['google antigravity', 'gemini'],
  ['gemini-cli', 'gemini-cli'], ['gemini cli', 'gemini-cli'], ['google gemini cli', 'gemini-cli'],
  ['grok', 'grok'], ['grok cli', 'grok'], ['xai', 'grok'], ['x.ai', 'grok'],
  ['claude', 'claude'], ['anthropic', 'claude'], ['claude code', 'claude'],
  ['cline', 'cline'], ['roo', 'roo'], ['roo code', 'roo'], ['roo-code', 'roo'],
  ['other', 'other'], ['其他', 'other'],
]);

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  function finishCell() {
    row.push(cell);
    if (row.length > MAX_COLUMNS) throw new Error(`CSV 最多支持 ${MAX_COLUMNS} 列。`);
    cell = '';
    closedQuote = false;
  }

  function finishRow() {
    finishCell();
    if (row.some((value) => value.trim())) {
      rows.push(row);
      if (rows.length > MAX_RECORDS + 1) throw new Error(`CSV 最多支持 ${MAX_RECORDS} 条记录。`);
    }
    row = [];
  }

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        cell += char;
      }
    } else if (char === ',') {
      finishCell();
    } else if (char === '\n' || char === '\r') {
      finishRow();
      if (char === '\r' && content[index + 1] === '\n') index++;
    } else if (char === '"' && !cell && !closedQuote) {
      quoted = true;
    } else if (closedQuote || char === '"') {
      throw new Error('CSV 的引号格式有误。请使用双引号包裹含逗号的字段，并将字段内的双引号写成两个。');
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('CSV 有未闭合的双引号。');
  finishRow();

  const headers = rows.shift()?.map((header) => header.trim());
  if (!headers || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error('请为 CSV 提供首行字段名，每个字段名应非空且唯一。');
  }

  return rows.map((values, index) => {
    if (values.length > headers.length) throw new Error(`CSV 数据区第 ${index + 1} 条记录的列数超过表头。`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function normalizeDate(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const epoch = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof epoch === 'string' && /^[1-9](?:\d{9}|\d{12})$/.test(epoch)) {
    const milliseconds = Number(epoch) * (epoch.length === 10 ? 1000 : 1);
    return { date: new Date(milliseconds).toISOString() };
  }

  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i.test(raw)) {
    const calendarDay = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(calendarDay.getTime()) && calendarDay.getUTCFullYear() > 0 && calendarDay.toISOString().slice(0, 10) === raw.slice(0, 10)) {
      if (raw.length === 10) return { date: calendarDay.toISOString(), dateOnly: true };
      const timestamp = new Date(raw.replace(' ', 'T'));
      if (Number.isFinite(timestamp.getTime()) && timestamp.getUTCFullYear() > 0 && timestamp.getUTCFullYear() <= 9999) {
        return { date: timestamp.toISOString() };
      }
    }
  }

  throw new Error('请提供有效的日期（YYYY-MM-DD）、带 Z 或时区偏移的 ISO 时间戳，或 10 位秒级、13 位毫秒级 Unix 时间戳。');
}

function tokenCount(field, ...values) {
  const value = values.find((candidate) => candidate != null && (typeof candidate !== 'string' || candidate.trim()));
  if (value === undefined) return undefined;
  const count = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${field} 应为非负整数。`);
  return count;
}

function stringField(value) {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function providerFrom(model, usage) {
  if (/^(?:xai\/)?grok(?:-|$)/i.test(model)) return 'grok';
  if (/^(?:google\/|(?:publishers\/google\/)?models\/)?gemini(?:-|$)/i.test(model)) return 'gemini';
  if (/^(?:anthropic[./])?claude(?:-|$)/i.test(model)) return 'claude';
  if (/(?:^|-)codex(?:-|$)/i.test(model)) return 'codex';
  if (usage.promptTokenCount !== undefined || usage.prompt_token_count !== undefined) return 'gemini';
  if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) return 'claude';
  if (usage.num_sources_used !== undefined || usage.cost_in_usd_ticks !== undefined) return 'grok';
  return 'other';
}

function metadata(row, inherited = {}) {
  const model = [row.modelVersion, row.model_version, row.modelId, row.model_id, row.model]
    .find((value) => typeof value === 'string' && value.trim());
  return {
    date: row.date ?? row.timestamp ?? row.created_at ?? row.createdAt ?? row.created ?? inherited.date,
    model: model ?? inherited.model,
    provider: stringField(row.provider) ?? inherited.provider,
    requestLevel: row.request_level ?? row.requestLevel ?? inherited.requestLevel,
    requestId: stringField(row.request_id ?? row.requestId ?? row.response_id ?? row.responseId ?? row.id) ?? inherited.requestId,
    session: stringField(row.session ?? row.session_id ?? row.sessionId ?? row.conversation_id ?? row.conversationId) ?? inherited.session,
  };
}

function normalizeRow(usage, info, selected) {
  const model = info.model ?? null;
  if (model !== null && (model.length > 512 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(model))) {
    throw new Error('模型 ID 请使用 512 个字符以内的单行文本。');
  }
  const declared = PROVIDERS.get(info.provider?.toLowerCase());
  const vendor = providerFrom(model?.trim() ?? '', usage);
  const provider = selected ?? declared ?? vendor;
  const prompt = tokenCount('输入 Token', usage.input, usage.input_tokens, usage.inputTokens,
    usage.prompt_tokens, usage.promptTokenCount, usage.prompt_token_count);
  const completion = tokenCount('输出 Token', usage.output, usage.output_tokens, usage.outputTokens,
    usage.completion_tokens, usage.candidatesTokenCount, usage.candidates_token_count);
  const reportedTotal = tokenCount('总 Token', usage.total, usage.total_tokens, usage.totalTokens,
    usage.totalTokenCount, usage.total_token_count);

  if (prompt === undefined && completion === undefined && reportedTotal === undefined) {
    throw new Error('请提供 input、output、total 中的至少一项，或使用包含这些计数的 API 用量字段。');
  }

  const cached = tokenCount('缓存 Token', usage.cached, usage.cached_tokens, usage.cached_input_tokens,
    usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens,
    usage.cachedContentTokenCount, usage.cached_content_token_count, usage.cache_read_input_tokens) ?? 0;
  const reportedReasoning = tokenCount('推理 Token', usage.reasoning, usage.reasoning_tokens, usage.reasoning_output_tokens,
    usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens,
    usage.thoughtsTokenCount, usage.thoughts_token_count, usage.output_tokens_details?.thinking_tokens);
  const reasoning = reportedReasoning ?? 0;
  const cacheWrite = tokenCount('缓存写入 Token', usage.cacheWrite, usage.cache_write, usage.cache_write_tokens,
    usage.cache_creation_input_tokens) ?? 0;
  const toolPrompt = tokenCount('工具输入 Token', usage.toolUsePromptTokenCount, usage.tool_use_prompt_token_count) ?? 0;

  // Gemini and xAI chat completions can report reasoning outside the raw completion count.
  const geminiThoughts = usage.thoughtsTokenCount !== undefined || usage.thoughts_token_count !== undefined;
  const grokChat = [provider, declared, vendor].includes('grok') && usage.completion_tokens != null && completion !== undefined
    && (usage.output ?? usage.output_tokens ?? usage.outputTokens) == null;
  // Claude's input_tokens excludes both cache reads and writes.
  const claudeCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const input = (prompt ?? 0) + toolPrompt + (claudeCache ? cached + cacheWrite : 0);
  const separateReasoning = geminiThoughts || (grokChat && (reportedTotal === undefined || reportedTotal >= input + completion + reasoning));
  const output = (completion ?? 0) + (separateReasoning ? reasoning : 0);
  const total = reportedTotal ?? input + output;
  const requestLevel = info.requestLevel === true || info.requestLevel === 1 || info.requestLevel === 'true' || info.requestLevel === '1';
  if (![input, output, total].every(Number.isSafeInteger)) throw new Error('Token 数量超出可精确统计的整数范围。');
  const cacheParts = cached + cacheWrite;
  const minimumTotal = Math.max(input, cacheParts) + Math.max(output, reasoning);
  if ((prompt !== undefined && cacheParts > input) || (completion !== undefined && reasoning > output) || total < minimumTotal) {
    throw new Error('Token 分类与总量不一致。总量应覆盖输入和输出，缓存和推理分别计入输入和输出。');
  }

  const session = info.session ? createHash('sha256').update(JSON.stringify([provider, info.session])).digest('hex').slice(0, 24) : undefined;
  return { provider, model, ...normalizeDate(info.date), input, output, cached, reasoning, total, source: 'import', cacheWrite, session,
    ...(requestLevel ? { requestLevel: true } : {}),
    ...(reportedReasoning === undefined ? { reasoningKnown: false } : {}) };
}

export function parseUsageFile({ filename = '', content, provider = 'auto' } = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('请选择含用量记录的 UTF-8 CSV、JSON 或 JSONL 文件。');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('文件超过 8 MB，请拆分后导入。');
  const extension = extname(filename).toLowerCase();
  if (extension && !['.json', '.csv', '.jsonl', '.ndjson'].includes(extension)) {
    throw new Error('请选择扩展名为 .csv、.json、.jsonl 或 .ndjson 的文件。');
  }
  const selected = provider === 'auto' ? undefined : PROVIDERS.get(provider);
  if (provider !== 'auto' && !selected) throw new Error('请选择要导入的 AI 工具。');

  const payload = content.replace(/^\uFEFF/, '');
  const records = [];
  const occurrences = new Map();

  function addRecord(usage, info, label) {
    if (records.length >= MAX_RECORDS) throw new Error(`每个文件最多支持 ${MAX_RECORDS} 条用量记录。`);
    let normalized;
    try {
      normalized = normalizeRow(usage, info, selected);
    } catch (error) {
      throw new Error(`${label} 的用量记录有误。${error.message}`);
    }
    // Keep IDs stable for existing imports with undisclosed models or reasoning counts.
    const identity = JSON.stringify([{ ...normalized, model: normalized.model ?? '未知模型', cacheWrite: normalized.cacheWrite || undefined,
      session: undefined, reasoningKnown: undefined, requestLevel: undefined }, info.requestId]);
    const index = occurrences.get(identity) ?? 0;
    occurrences.set(identity, index + 1);
    const id = createHash('sha256').update(identity).update(`:${index}`).digest('hex');
    records.push({ id: `import:${id}`, ...normalized });
  }

  function readJson(value, label = 'JSON', inherited, depth = 0) {
    if (depth > 8) throw new Error('JSON 记录嵌套过深，请提供用量记录数组。');
    if (Array.isArray(value)) {
      value.forEach((row, index) => readJson(row, `${label}[${index + 1}]`, inherited, depth + 1));
      return;
    }
    if (value === null || typeof value !== 'object') throw new Error(`${label} 应为用量记录对象。`);

    const info = metadata(value, inherited);
    const usage = value.usage ?? value.usageMetadata ?? value.usage_metadata;
    if (usage !== undefined) {
      if (usage === null || Array.isArray(usage) || typeof usage !== 'object') throw new Error(`${label} 的用量字段应为对象。`);
      addRecord(usage, info, label);
      return;
    }

    const wrapper = WRAPPER_KEYS.find((key) => value[key] && typeof value[key] === 'object');
    if (wrapper) {
      readJson(value[wrapper], `${label}.${wrapper}`, info, depth + 1);
      return;
    }
    addRecord(value, info, label);
  }

  if (extension === '.jsonl' || extension === '.ndjson') {
    for (const [index, line] of payload.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const label = `JSONL 第 ${index + 1} 行`;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${label} 格式有误。请在每行放置一个完整的 JSON 对象。`);
      }
      if (Array.isArray(value)) throw new Error(`${label} 应为一个完整的 JSON 对象。`);
      readJson(value, label);
    }
  } else if (extension === '.json' || (!extension && /^\s*[\[{]/.test(payload))) {
    let value;
    try {
      value = JSON.parse(payload.trim());
    } catch {
      throw new Error('JSON 格式有误，请检查引号、逗号和括号后重试。');
    }
    readJson(value);
  } else {
    parseCsv(payload).forEach((row, index) => addRecord(row, metadata(row), `CSV 数据区第 ${index + 1} 条记录`));
  }

  if (records.length === 0) throw new Error('文件中没有用量记录。请添加日期和 Token 数量后重试。');
  return records;
}
