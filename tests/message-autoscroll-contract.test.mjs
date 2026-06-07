import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const hookSource = fs.readFileSync(
  new URL('../src/hooks/use-virtual-message-list.ts', import.meta.url),
  'utf8',
);

test('manual scroll-away state suppresses streaming bottom pinning', () => {
  assert.match(hookSource, /const userLockedAwayFromBottomRef = useRef\(false\)/);
  assert.match(hookSource, /const disableAutoScrollFromUser = useCallback/);
  assert.match(
    hookSource,
    /userLockedAwayFromBottomRef\.current = true;[\s\S]*forceBottomOnNextResumeRef\.current = false;[\s\S]*setAutoScroll\(false\);/,
  );
  assert.match(
    hookSource,
    /const scheduleAutoScrollToBottom = useCallback\(\(\) => \{\s*if \(userLockedAwayFromBottomRef\.current\) return;/,
  );
  assert.match(
    hookSource,
    /if \(userLockedAwayFromBottomRef\.current\) \{\s*isRestoringInitialScrollRef\.current = false;\s*return;\s*\}/,
  );
});

test('turn in flight alone does not force bottom restore', () => {
  const restorePredicate = hookSource.match(
    /const shouldRestoreToBottom = useCallback\(\(snapshot:[\s\S]*?\), \[\]\);/,
  );
  assert.ok(restorePredicate, 'expected a stable shouldRestoreToBottom predicate');
  assert.doesNotMatch(restorePredicate[0], /isTurnInFlight\s*\|\|/);
});

test('streaming snapshots captured after user scroll-away are not treated as bottom-pinned', () => {
  assert.match(
    hookSource,
    /capturedDuringTurn:\s*isTurnInFlight &&\s*!userLockedAwayFromBottomRef\.current &&\s*distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX/,
  );
  assert.match(
    hookSource,
    /const markBottomOnNextResume = useCallback\(\(\) => \{\s*if \(userLockedAwayFromBottomRef\.current\) return;/,
  );
});

test('explicit upward user scroll wins before near-bottom auto-scroll re-enable', () => {
  const upwardScrollIndex = hookSource.indexOf('if (scrollTop < previousScrollTop) {');
  const nearBottomIndex = hookSource.indexOf('// Near bottom \u2192 enable auto-scroll');
  assert.notEqual(upwardScrollIndex, -1);
  assert.notEqual(nearBottomIndex, -1);
  assert.ok(upwardScrollIndex < nearBottomIndex);
});
