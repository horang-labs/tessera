import { buildClaudeHookSettingsJson } from '../src/lib/terminal/claude-hook-settings';
import * as fs from 'fs';
const json = buildClaudeHookSettingsJson('windows-cmd');
fs.writeFileSync('/tmp/claude-1000/-home-work-Source-tessera-dev/a8edaf07-99a0-4bb8-82a8-d1949df65cbc/scratchpad/settings-windows-cmd.json', json);
console.log(json);
