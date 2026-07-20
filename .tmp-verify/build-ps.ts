import { resolveTerminalShell } from '../src/lib/terminal/terminal-resolver';
import { buildClaudeHookSettingsJson } from '../src/lib/terminal/claude-hook-settings';
import * as fs from 'fs';

const json = buildClaudeHookSettingsJson('windows-cmd');
// Exactly what buildProviderTerminalLaunch produces for a fresh (non-resume) claude session,
// but with `claude` swapped for node.exe + an argv printer so we can observe the child argv.
const shell = resolveTerminalShell({
  cwd: '/home/work',
  platform: 'win32',
  env: {},
  launchSpec: {
    program: 'C:\\Program Files\\nodejs\\node.exe',
    args: [
      'C:\\Users\\work\\AppData\\Local\\Temp\\tessera-argv.js',
      '--session-id', '123e4567-e89b-12d3-a456-426614174000',
      '--settings', json,
    ],
  },
});
console.log('command:', shell.command);
console.log('args[0..1]:', shell.args[0], shell.args[1]);
fs.writeFileSync('/mnt/c/Users/work/AppData/Local/Temp/tessera-ps-test.ps1', shell.args[2]);
fs.writeFileSync(
  '/mnt/c/Users/work/AppData/Local/Temp/tessera-argv.js',
  'const fs=require("fs");fs.writeFileSync(__dirname+"\\\\tessera-argv-out.json",JSON.stringify(process.argv.slice(2),null,1));',
);
console.log('ps1 written, first 120 chars:', shell.args[2].slice(0, 120));
