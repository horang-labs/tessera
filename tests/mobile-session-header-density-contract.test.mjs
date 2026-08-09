import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const headerSource = fs.readFileSync(
  new URL('../src/components/chat/header.tsx', import.meta.url),
  'utf8',
);

test('the Phone header keeps the editable provider and title identity', () => {
  assert.match(headerSource, /data-testid="panel-title-drag-handle"/);
  assert.match(headerSource, /className="h-5 rounded-md px-2 text-\[10px\] leading-none max-sm:px-1"/);
  assert.doesNotMatch(headerSource, /isSinglePanel && 'max-sm:hidden'/);
  assert.match(headerSource, /Hash className="[^"]*max-sm:hidden"/);
});

test('phone header actions retain their touch-target spacing', () => {
  assert.match(headerSource, /'max-sm:gap-0'/);
  assert.match(headerSource, /'ml-auto flex shrink-0 items-center gap-2'/);
  assert.match(headerSource, /PHONE_TOUCH_TARGET/);
});
