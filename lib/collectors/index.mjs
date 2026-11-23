import { claudeCode } from './claude-code.mjs';
import { cline, kilo, roo } from './editor-extensions.mjs';
import { geminiCli } from './gemini-cli.mjs';
import { opencode } from './opencode.mjs';

export const extraProviders = {
  claude: claudeCode,
  'gemini-cli': geminiCli,
  cline,
  roo,
  kilo,
  opencode,
};
