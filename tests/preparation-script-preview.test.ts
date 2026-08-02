import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREPARATION_BRANCH_NAME_ENV,
  PREPARATION_PROJECT_DIR_ENV,
  PREPARATION_WORKTREE_DIR_ENV,
} from '@/lib/projects/preparation-environment';
import { expandPreparationVariables } from '@/lib/projects/preparation-script-preview';

const values = {
  [PREPARATION_PROJECT_DIR_ENV]: '/home/work/src/my-repo',
  [PREPARATION_WORKTREE_DIR_ENV]: '/home/work/.tessera/worktrees/my-repo/feature-0514-au',
  [PREPARATION_BRANCH_NAME_ENV]: 'feature-0514-au',
};

test('a bare variable becomes the path it stood for', () => {
  assert.equal(
    expandPreparationVariables('cp "$TESSERA_PROJECT_DIR/.env.local" .', values),
    'cp "/home/work/src/my-repo/.env.local" .',
  );
});

test('the braced spelling expands the same way', () => {
  assert.equal(
    expandPreparationVariables('cd "${TESSERA_WORKTREE_DIR}"', values),
    'cd "/home/work/.tessera/worktrees/my-repo/feature-0514-au"',
  );
});

test('the batch spelling expands too, so a Windows script reads the same', () => {
  assert.equal(
    expandPreparationVariables('copy "%TESSERA_PROJECT_DIR%\\.env" .', values),
    'copy "/home/work/src/my-repo\\.env" .',
  );
});

test('every occurrence in a script is expanded, on every line', () => {
  const script = [
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    'cp -R "$TESSERA_PROJECT_DIR/.claude" .',
    'echo "$TESSERA_BRANCH_NAME"',
  ].join('\n');

  assert.equal(expandPreparationVariables(script, values), [
    'cp "/home/work/src/my-repo/.env.local" .',
    'cp -R "/home/work/src/my-repo/.claude" .',
    'echo "feature-0514-au"',
  ].join('\n'));
});

test('a longer name that merely starts the same is left alone', () => {
  // `$TESSERA_PROJECT_DIRECTORY` is somebody else's variable, not this one.
  assert.equal(
    expandPreparationVariables('echo $TESSERA_PROJECT_DIRECTORY', values),
    'echo $TESSERA_PROJECT_DIRECTORY',
  );
});

test('variables Tessera does not set are left as they were written', () => {
  // Expanding them would be a guess, and a wrong one reads as fact.
  assert.equal(
    expandPreparationVariables('cp "$HOME/.npmrc" .', values),
    'cp "$HOME/.npmrc" .',
  );
});

test('a value missing from the run leaves its variable standing', () => {
  assert.equal(
    expandPreparationVariables('echo "$TESSERA_BRANCH_NAME"', {
      [PREPARATION_PROJECT_DIR_ENV]: '/home/work/src/my-repo',
    }),
    'echo "$TESSERA_BRANCH_NAME"',
  );
});

test('comments are expanded like everything else, because they are read too', () => {
  assert.equal(
    expandPreparationVariables('# copies from $TESSERA_PROJECT_DIR', values),
    '# copies from /home/work/src/my-repo',
  );
});

test('a value holding a dollar sign is inserted literally, not re-expanded', () => {
  assert.equal(
    expandPreparationVariables('cd "$TESSERA_WORKTREE_DIR"', {
      [PREPARATION_WORKTREE_DIR_ENV]: '/home/work/$odd/dir',
    }),
    'cd "/home/work/$odd/dir"',
  );
});

test('an empty script stays empty', () => {
  assert.equal(expandPreparationVariables('', values), '');
});
