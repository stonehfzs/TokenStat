import { open } from 'node:fs/promises';

export const MiB = 1024 * 1024;

export function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function opaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 250 ? value : undefined;
}

export function timestamp(value) {
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return;
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export async function readJsonLog(path, limit = 64 * MiB) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size > limit) return { incomplete: 1, diagnostics: { oversizedFile: 1 } };
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    try {
      return { data: JSON.parse(bytes.toString('utf8', 0, offset).replace(/^\uFEFF/, '')), incomplete: 0 };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { incomplete: 1, diagnostics: { invalidJson: 1 } };
    }
  } finally {
    await file.close();
  }
}
