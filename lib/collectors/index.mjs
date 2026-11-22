import { claudeCode } from './claude-code.mjs';
import { cline, roo } from './editor-extensions.mjs';
import { geminiCli } from './gemini-cli.mjs';

export const extraProviders = {
  claude: claudeCode,
  'gemini-cli': geminiCli,
  cline,
  roo,
};
