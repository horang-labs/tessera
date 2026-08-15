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

const chatRowStart = source.indexOf("'group/chat relative flex");
const chatRowEnd = source.indexOf('{dropIndicatorAfter && (', chatRowStart);
assert.ok(chatRowStart >= 0 && chatRowEnd > chatRowStart, 'chat row markup is present');

const chatRow = source.slice(chatRowStart, chatRowEnd);
assert.match(
  chatRow,
  /group\/chat[^'`]*max-sm:pr-10/,
  'phone chat rows reserve the trailing width occupied by the always-visible overflow action',
);
assert.match(
  chatRow,
  /<DiffStatsBadge stats=\{session\.diffStats\} className="max-sm:hidden" \/>/,
  'phone chat rows hide Git diff stats without removing them from desktop',
);
assert.match(
  chatRow,
  /collection-chat-status-bubble-/,
  'the chat identity icon remains on the trailing edge when provider icons occupy the leading slot',
);
assert.match(
  chatRow,
  /max-sm:opacity-100 max-sm:pointer-events-auto/,
  'the chat overflow action remains visible and tappable without hover on a phone',
);

console.log('ok — phone task and chat actions retain identity while hiding Git diff stats only on phones');
