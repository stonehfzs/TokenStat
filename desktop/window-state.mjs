import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const defaults = { width: 1440, height: 1000, minWidth: 365, minHeight: 580 };

function cleanBounds(value) {
  const { x, y, width, height } = value ?? {};
  if (![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 ||
      [x, y, width, height].some((number) => Math.abs(number) > 100_000)) return null;
  return { x, y, width, height };
}

export function restoreWindowBounds(state, screen) {
  const saved = cleanBounds(state?.bounds);
  const { workArea } = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay();
  // Ozone can report a 1×1 placeholder before there is a usable display.
  if (workArea.width <= 1 || workArea.height <= 1) return { ...defaults };
  const minWidth = Math.min(defaults.minWidth, workArea.width);
  const minHeight = Math.min(defaults.minHeight, workArea.height);
  const width = Math.min(workArea.width, Math.max(minWidth, saved?.width ?? defaults.width));
  const height = Math.min(workArea.height, Math.max(minHeight, saved?.height ?? defaults.height));
  const overlaps = saved && saved.x < workArea.x + workArea.width && saved.x + saved.width > workArea.x &&
    saved.y < workArea.y + workArea.height && saved.y + saved.height > workArea.y;
  const x = overlaps ? Math.max(workArea.x, Math.min(saved.x, workArea.x + workArea.width - width)) : workArea.x + Math.floor((workArea.width - width) / 2);
  const y = overlaps ? Math.max(workArea.y, Math.min(saved.y, workArea.y + workArea.height - height)) : workArea.y + Math.floor((workArea.height - height) / 2);
  return { x, y, width, height, minWidth, minHeight };
}

export async function loadWindowState(directory) {
  const path = join(directory, 'window-state.json');
  let state = null;
  try {
    const info = await lstat(path);
    if (info.isFile() && info.size <= 2048) {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const bounds = cleanBounds(saved?.bounds);
      if (bounds) state = { bounds, maximized: saved.maximized === true };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      console.error('[TokenStat] Unable to read window geometry:', error.code);
    }
  }

  let pending = Promise.resolve();
  return {
    get state() { return state; },
    remember(bounds, maximized) {
      const clean = cleanBounds(bounds);
      if (!clean) return;
      const next = { bounds: clean, maximized: Boolean(maximized) };
      const content = JSON.stringify(next);
      if (content === JSON.stringify(state)) return;
      state = next;
      pending = pending.then(async () => {
        const temporary = path + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      }).catch((error) => console.error('[TokenStat] Unable to save window geometry:', error.code));
    },
    flush() { return pending; },
  };
}
