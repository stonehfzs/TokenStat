import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';

function openStream(path, start, end) {
  const input = createReadStream(path, { start, end, highWaterMark: 256 * 1024 });
  if (!path.endsWith('.zst')) return { input, stream: input };
  const stream = createZstdDecompress({ chunkSize: 256 * 1024 });
  input.on('error', (error) => stream.destroy(error));
  return { input, stream: input.pipe(stream) };
}

export async function boundarySignature(path, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  const hash = createHash('sha256');
  if (offset) {
    const width = Math.min(4096, offset);
    const starts = new Set([0, Math.floor((offset - width) / 2), offset - width]);
    const buffer = Buffer.allocUnsafe(width);
    const file = await open(path, 'r');
    try {
      for (const start of starts) {
        const { bytesRead } = await file.read(buffer, 0, width, start);
        if (bytesRead !== width) return null;
        hash.update(buffer);
      }
    } finally {
      await file.close();
    }
  }
  return hash.digest('hex');
}

export async function readUsageLines(path, matcher, limit, onEvent, options = {}) {
  let { offset = 0, lineNumber = 0 } = options;
  const { size, checkpoint: takeCheckpoint } = options;
  let currentOffset = offset;
  let lastBoundary = offset;
  let pieces = [];
  let buffered = 0;
  let skippedKnown = false;
  let skippedOversized = false;
  let incomplete = 0;
  let resumable = Boolean(takeCheckpoint);
  const markers = Array.isArray(matcher) ? matcher : matcher?.markers;

  function consume(line, final = false) {
    if (!line.length) return;
    const fast = matcher?.fastCheck?.(line);
    if (fast === false || (fast !== true && markers && !markers.some((needle) => line.includes(needle)))) return;
    const text = line.toString('utf8');
    if (matcher instanceof RegExp && !matcher.test(text)) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!final || !takeCheckpoint) incomplete++;
      return;
    }
    if (final) resumable = false;
    if (event) onEvent(event, lineNumber);
  }

  if (size !== 0 && (size === undefined || offset < size)) {
    const { input, stream } = openStream(path, offset, size === undefined ? undefined : size - 1);
    try {
      for await (const chunk of stream) {
        if (takeCheckpoint) {
          const lastNewline = chunk.lastIndexOf(10);
          if (lastNewline >= 0) lastBoundary = currentOffset + lastNewline + 1;
          currentOffset += chunk.length;
        }
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline;
          const piece = chunk.subarray(start, end);
          if (newline < 0 && !buffered && !skippedOversized && !skippedKnown) {
            skippedKnown = matcher?.fastCheck?.(piece) === false;
          }
          if (!skippedKnown && !skippedOversized && buffered + piece.length > limit) {
            pieces = [];
            buffered = 0;
            skippedOversized = true;
          }
          if (skippedOversized) {
            if (newline >= 0) incomplete++;
          } else if (!skippedKnown) {
            if (newline < 0 || buffered) {
              if (piece.length) {
                pieces.push(piece);
                buffered += piece.length;
              }
              if (newline >= 0 && buffered) consume(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, buffered));
            } else {
              consume(piece);
            }
          }
          if (newline < 0) break;
          pieces = [];
          buffered = 0;
          skippedKnown = false;
          skippedOversized = false;
          lineNumber++;
          start = newline + 1;
        }
      }
      if (skippedOversized && !takeCheckpoint) incomplete++;
      if (buffered) consume(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, buffered), true);
    } finally {
      stream.destroy();
      input.destroy();
    }
  }

  return {
    incomplete,
    checkpoint: resumable ? { offset: lastBoundary, lineNumber } : undefined,
  };
}

export async function forUsageLines(path, matcher, limit, onEvent) {
  return (await readUsageLines(path, matcher, limit, onEvent)).incomplete;
}
