import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../src/components/chat/collection-group-sections.tsx', import.meta.url),
  'utf8',
);

const taskRowStart = source.indexOf("'group/task relative flex");
const taskRowEnd = source.indexOf('{isExpanded && (', taskRowStart);
assert.ok(taskRowStart >= 0 && taskRowEnd > taskRowStart, 'task row markup is present');

const taskRow = source.slice(taskRowStart, taskRowEnd);
assert.match(
  taskRow,
  /group\/task[^'`]*max-sm:pr-14/,
  'phone task rows reserve the trailing width occupied by the always-visible + and overflow actions',
);
assert.match(
  taskRow,
  /<DiffStatsBadge stats=\{task\.diffStats\} className="max-sm:hidden" \/>/,
  'phone task rows hide only the Git diff stats',
);
assert.match(
  taskRow,
  /<DiffStatsBadge[^>]+>\s*\{showProviderIcons && renderWorktreeMark\(false\)\}/,
  'the Worktree mark remains rendered beside the phone action rail',
);

console.log('ok — phone task actions hide Git diff stats and retain the Worktree mark');
