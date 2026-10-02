import assert from 'node:assert/strict';
import test from 'node:test';
import { attestInstructionExclusion } from './autorun-provider-proof-loader';

const sources = [{ role: 'projectClaude', path: '/owned/empty/CLAUDE.md', positiveRequired: true },
  { role: 'homeClaude', path: '/owned/config/CLAUDE.md', positiveRequired: true }];
const control = sources.map(s => `100 openat(AT_FDCWD, "${s.path}", O_RDONLY) = 3<${s.path}>`).join('\n');
test('instruction-loader attestation counts successful opens of known sources, excluding auth and failed opens', () => {
  const candidate = '101 openat(AT_FDCWD, "/auth/.credentials.json", O_RDONLY) = 4</auth/.credentials.json>\n'
    + '101 openat(AT_FDCWD, "/owned/empty/CLAUDE.md", O_RDONLY) = -1 ENOENT';
  assert.deepEqual(attestInstructionExclusion(control, candidate, sources), [
    { role: 'projectClaude', controlOpens: 1, candidateOpens: 0 },
    { role: 'homeClaude', controlOpens: 1, candidateOpens: 0 },
  ]);
});
test('instruction exclusion refuses a silent positive control or an actual candidate source open', () => {
  assert.throws(() => attestInstructionExclusion('', '', sources));
  assert.throws(() => attestInstructionExclusion(control, control, sources));
});
test('an absent candidate trace cannot establish absence of instruction loading', () => {
  assert.throws(() => attestInstructionExclusion(control, '', sources));
});
test('a resumed open syscall still counts as instruction loading', () => {
  const candidate = '101 openat(AT_FDCWD, "/auth/.credentials.json", O_RDONLY) = 4</auth/.credentials.json>\n'
    + '102 <... openat resumed>) = 3</owned/empty/CLAUDE.md>';
  assert.throws(() => attestInstructionExclusion(control, candidate, sources));
});
