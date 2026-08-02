import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(
  new URL('../src/lib/chat/hidden-slash-commands.ts', import.meta.url),
  'utf8',
);
const skillPickerSource = fs.readFileSync(
  new URL('../src/hooks/use-skill-picker.ts', import.meta.url),
  'utf8',
);
const favoriteButtonSource = fs.readFileSync(
  new URL('../src/components/chat/skill-favorite-button.tsx', import.meta.url),
  'utf8',
);
const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);
const routingSource = fs.readFileSync(
  new URL('../src/lib/ws/server-message-routing.ts', import.meta.url),
  'utf8',
);

// `@/...` 별칭은 data: URL 모듈에서 해석되지 않는다. 유일한 의존인 extractSlashCommandName의
// 원본을 앞에 붙이고 해당 import 문만 걷어내 한 모듈로 트랜스파일한다.
const tuiOnlySource = fs.readFileSync(
  new URL('../src/lib/terminal/tui-only-commands.ts', import.meta.url),
  'utf8',
);
const combinedSource = `${tuiOnlySource}\n${source.replace(
  /^import \{ extractSlashCommandName \} from '@\/lib\/terminal\/tui-only-commands';\n/m,
  '',
)}`;
assert.ok(
  !combinedSource.includes("from '@/lib/terminal/tui-only-commands'"),
  '별칭 import가 남으면 아래 동적 import가 실패한다 — import 문 형태가 바뀌었는지 확인할 것',
);
const output = ts.transpileModule(combinedSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const hidden = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('claude-code /clear is hidden from the picker', () => {
  assert.equal(hidden.isHiddenSlashCommandName('clear', 'claude-code'), true);
  assert.equal(hidden.isHiddenSlashCommandName('Clear', 'claude-code'), true, '대소문자 무관');
  assert.equal(hidden.isHiddenSlashCommandName(' clear ', 'claude-code'), true, '공백 무관');
});

test('hiding is scoped to the provider that has the problem', () => {
  assert.equal(hidden.isHiddenSlashCommandName('clear', 'codex'), false);
  assert.equal(hidden.isHiddenSlashCommandName('clear', 'opencode'), false);
  assert.equal(hidden.isHiddenSlashCommandName('clear', undefined), false);
  assert.equal(hidden.isHiddenSlashCommandName('clear', null), false);
});

test('unrelated commands stay visible', () => {
  assert.equal(hidden.isHiddenSlashCommandName('compact', 'claude-code'), false);
  assert.equal(hidden.isHiddenSlashCommandName('clearance', 'claude-code'), false, '접두사 일치가 아니라 완전 일치');
  assert.equal(hidden.isHiddenSlashCommandName('model', 'claude-code'), false);
});

test('every picker list path consumes the filtered command list', () => {
  assert.ok(
    skillPickerSource.includes("import { isHiddenSlashCommandName } from '@/lib/chat/hidden-slash-commands'"),
    '피커가 숨김 판정을 가져와야 한다',
  );
  assert.ok(
    /const visibleCommands = useMemo\(\s*\(\) => commands\?\.filter\(/.test(skillPickerSource),
    'store 원본을 한 번에 걸러 파생값을 만들어야 한다',
  );
  // 목록을 만드는 지점이 원본(commands)을 다시 집어 오면 숨김이 새어 나간다.
  assert.ok(
    !/for \(const command of commands \?\? \[\]\)/.test(skillPickerSource),
    'availableCommands 병합은 필터된 목록을 써야 한다',
  );
  assert.ok(
    !/commands\.filter\(\(command\) => !isReservedCodexSlashCommandName/.test(skillPickerSource),
    'skills-only 경로도 필터된 목록을 써야 한다',
  );
  assert.ok(
    !/\(commands \?\? \[\]\)\.filter\(\(command\) => !isReservedCodexSlashCommandName/.test(skillPickerSource),
    '로딩 직후 자동 표시 경로도 필터된 목록을 써야 한다',
  );
});

test('typing a hidden command is blocked, arguments and all', () => {
  assert.equal(hidden.isHiddenSlashCommandInput('/clear', 'claude-code'), true);
  assert.equal(hidden.isHiddenSlashCommandInput('  /clear  ', 'claude-code'), true);
  assert.equal(hidden.isHiddenSlashCommandInput('/clear now', 'claude-code'), true, '인자가 붙어도 같은 명령');
  assert.equal(hidden.isHiddenSlashCommandInput('/Clear', 'claude-code'), true);
});

test('ordinary input and lookalikes are not blocked', () => {
  assert.equal(hidden.isHiddenSlashCommandInput('clear', 'claude-code'), false, '슬래시가 없으면 명령이 아니다');
  assert.equal(hidden.isHiddenSlashCommandInput('/clearance', 'claude-code'), false);
  assert.equal(hidden.isHiddenSlashCommandInput('please /clear it', 'claude-code'), false, '문장 중간은 명령이 아니다');
  assert.equal(hidden.isHiddenSlashCommandInput('/clear', 'codex'), false);
  assert.equal(hidden.isHiddenSlashCommandInput('', 'claude-code'), false);
});

test('send is blocked on both the client and the server', () => {
  assert.ok(
    /if \(!hasSelectedSkill && isHiddenSlashCommandInput\(trimmed, sessionProviderId\)\)/.test(messageInputSource),
    '입력창이 전송 전에 막아야 한다',
  );
  assert.ok(
    /isHiddenSlashCommandInput\(\s*sendMessageInputText\(message\.content\)/.test(routingSource),
    '서버도 같은 판정으로 막아야 한다 — 입력창만 막으면 다른 전송 경로가 남는다',
  );
  const terminalBranchIndex = routingSource.indexOf("=== 'terminal'");
  const blockIndex = routingSource.indexOf('isHiddenSlashCommandInput(');
  assert.ok(terminalBranchIndex !== -1 && blockIndex !== -1);
  assert.ok(
    blockIndex > terminalBranchIndex,
    'PTY 세션은 진짜 TUI라 /clear가 정상 동작한다 — 차단은 터미널 분기 뒤여야 한다',
  );
});

test('favorite picker cannot reintroduce a hidden command', () => {
  assert.ok(
    favoriteButtonSource.includes("import { isHiddenSlashCommandName } from '@/lib/chat/hidden-slash-commands'"),
    '즐겨찾기 추가 목록도 숨김을 적용해야 한다',
  );
  assert.ok(
    /storeSkills\.filter\(\(skill\) => !isHiddenSlashCommandName\(skill\.name, providerId\)\)/.test(favoriteButtonSource),
    '즐겨찾기 목록은 필터된 목록이어야 한다',
  );
});
