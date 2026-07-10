import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const messageInputSource = fs.readFileSync(
  new URL('../src/components/chat/message-input.tsx', import.meta.url),
  'utf8',
);

test('programmatic attachment and reference edits synchronously invalidate terminal launch drafts', () => {
  assert.match(
    messageInputSource,
    /const setInputValueFromProgrammaticEdit = useCallback\(\(value: SetStateAction<string>\) => \{\s+recordTerminalDraftEdit\(sessionId\);\s+setInputValue\(value\);/,
  );
  assert.match(
    messageInputSource,
    /useSessionRefs\(\{\s+textareaRef,\s+setInputValue: setInputValueFromProgrammaticEdit,/,
  );
  assert.match(
    messageInputSource,
    /useMessageInputAttachments\(\{\s+textareaRef,\s+setInputValue: setInputValueFromProgrammaticEdit,/,
  );
  assert.match(messageInputSource, /setInputValueFromProgrammaticEdit\(result\.newValue\)/);
});
