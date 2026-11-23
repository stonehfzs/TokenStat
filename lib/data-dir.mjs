import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function userDataDir() {
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'TokenStat');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'TokenStat');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tokenstat');
}
