import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COPY_BLOCK_CLOSE_MARKER,
  COPY_BLOCK_NOTICE,
  COPY_BLOCK_OPEN_MARKER,
  buildCopyCommand,
  hasCopyBlock,
  readCopiedCandidates,
  rewriteCopyBlock,
} from '@/lib/projects/preparation-copy-block';

const file = (path: string) => ({ path, isDirectory: false });
const directory = (path: string) => ({ path, isDirectory: true });

test('a file at the top level is copied into the worktree root', () => {
  assert.equal(buildCopyCommand(file('.env.local')), 'cp "$TESSERA_PROJECT_DIR/.env.local" .');
});

test('a directory is copied with its contents', () => {
  assert.equal(buildCopyCommand(directory('.claude')), 'cp -R "$TESSERA_PROJECT_DIR/.claude" .');
});

test('a nested entry gets the directory that will hold it made first', () => {
  assert.equal(
    buildCopyCommand(file('apps/web/.env.local')),
    'mkdir -p "apps/web" && cp "$TESSERA_PROJECT_DIR/apps/web/.env.local" "apps/web"',
  );
  assert.equal(
    buildCopyCommand(directory('packages/api/.claude')),
    'mkdir -p "packages/api" && cp -R "$TESSERA_PROJECT_DIR/packages/api/.claude" "packages/api"',
  );
});

test('the original checkout is reached through its exposed value, never a literal path', () => {
  // The candidate carries a path relative to the checkout, so nothing absolute
  // can reach the command in the first place.
  assert.equal(buildCopyCommand(file('.env')), 'cp "$TESSERA_PROJECT_DIR/.env" .');
});

test('a path holding shell punctuation is escaped, so the command copies that file', () => {
  // Unescaped, the shell would expand `$b` and copy whatever it named.
  assert.equal(buildCopyCommand(file('a$b.json')), 'cp "$TESSERA_PROJECT_DIR/a\\$b.json" .');
  assert.equal(buildCopyCommand(file('wei"rd.env')), 'cp "$TESSERA_PROJECT_DIR/wei\\"rd.env" .');
  assert.equal(buildCopyCommand(file('back\\slash.json')), 'cp "$TESSERA_PROJECT_DIR/back\\\\slash.json" .');
  assert.equal(buildCopyCommand(file('tick`.json')), 'cp "$TESSERA_PROJECT_DIR/tick\\`.json" .');
});

test('an escaped path reads back as the path it started as', () => {
  for (const path of ['a$b.json', 'wei"rd.env', 'back\\slash.json', 'tick`.json', 'with space/.env', 'weird$dir/a"b.json']) {
    const candidate = { path, isDirectory: false };
    assert.deepEqual(readCopiedCandidates(rewriteCopyBlock('', [candidate])), [candidate], path);
  }
});

test('a command built for a candidate reads back as that same candidate', () => {
  for (const candidate of [
    file('.env.local'),
    directory('.claude'),
    file('apps/web/.env.local'),
    directory('packages/api/node_modules'),
  ]) {
    const script = rewriteCopyBlock('', [candidate]);
    assert.deepEqual(readCopiedCandidates(script), [candidate], candidate.path);
  }
});

test('confirming an empty checklist against an empty script leaves nothing behind', () => {
  assert.equal(rewriteCopyBlock('', []), '');
});

test('a block written for the first time goes below what the user has typed', () => {
  const rewritten = rewriteCopyBlock('npm install', [file('.env.local'), directory('.claude')]);

  assert.equal(rewritten, [
    'npm install',
    '',
    COPY_BLOCK_OPEN_MARKER,
    '# Rewritten from the checklist. Move a line out of this block to keep your own version.',
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    'cp -R "$TESSERA_PROJECT_DIR/.claude" .',
    COPY_BLOCK_CLOSE_MARKER,
  ].join('\n'));
});

test('a block moved above an install step is rewritten where it now stands', () => {
  // Copying has to happen first for anything that installs from what was
  // copied, and moving the block is how that is arranged.
  const moved = [
    COPY_BLOCK_OPEN_MARKER,
    '# Rewritten from the checklist. Move a line out of this block to keep your own version.',
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    COPY_BLOCK_CLOSE_MARKER,
    '',
    'npm install',
  ].join('\n');

  const rewritten = rewriteCopyBlock(moved, [directory('.claude')]);

  assert.ok(rewritten.startsWith(COPY_BLOCK_OPEN_MARKER), 'it stayed at the top');
  assert.ok(rewritten.endsWith('npm install'));
  assert.deepEqual(readCopiedCandidates(rewritten), [directory('.claude')]);
});

test('rewriting again leaves the rest of the script alone', () => {
  const first = rewriteCopyBlock('npm install\nnpm run build', [file('.env.local')]);
  const second = rewriteCopyBlock(first, [directory('.claude')]);

  assert.deepEqual(readCopiedCandidates(second), [directory('.claude')]);
  assert.ok(second.startsWith('npm install\nnpm run build'));
  assert.ok(!second.includes('.env.local'));
});

test('unticking every candidate removes the block along with its markers', () => {
  const withBlock = rewriteCopyBlock('npm install', [file('.env.local')]);
  const cleared = rewriteCopyBlock(withBlock, []);

  assert.equal(cleared, 'npm install');
  assert.deepEqual(readCopiedCandidates(cleared), []);
});

test('a generated line moved out of the block becomes the user\'s own and survives', () => {
  const withBlock = rewriteCopyBlock('npm install', [file('.env.local')]);
  // The user drags the copy below the block and keeps it.
  const moved = withBlock.replace(
    `cp "$TESSERA_PROJECT_DIR/.env.local" .\n${COPY_BLOCK_CLOSE_MARKER}`,
    `${COPY_BLOCK_CLOSE_MARKER}\ncp "$TESSERA_PROJECT_DIR/.env.local" .`,
  );

  const rewritten = rewriteCopyBlock(moved, [directory('.claude')]);

  assert.ok(rewritten.includes('cp "$TESSERA_PROJECT_DIR/.env.local" .'));
  assert.ok(rewritten.includes('cp -R "$TESSERA_PROJECT_DIR/.claude" .'));
  // Only what is inside the block counts as the checklist's doing.
  assert.deepEqual(readCopiedCandidates(rewritten), [directory('.claude')]);
});

test('an unpaired opening marker never swallows the lines below it', () => {
  const damaged = `${COPY_BLOCK_OPEN_MARKER}\ncp "$TESSERA_PROJECT_DIR/.env" .\nnpm install`;

  const rewritten = rewriteCopyBlock(damaged, [directory('.claude')]);

  assert.ok(rewritten.includes('npm install'));
  assert.ok(rewritten.includes('cp "$TESSERA_PROJECT_DIR/.env" .'));
  assert.deepEqual(readCopiedCandidates(rewritten), [directory('.claude')]);
});

test('a stray opening marker above the block is not paired with the block\'s closer', () => {
  // Otherwise every line between the two would be inside the block, and the
  // next rewrite would replace the user's commands along with it.
  const withStray = [
    COPY_BLOCK_OPEN_MARKER,
    'npm install',
    '',
    COPY_BLOCK_OPEN_MARKER,
    COPY_BLOCK_NOTICE,
    'cp -R "$TESSERA_PROJECT_DIR/.claude" .',
    COPY_BLOCK_CLOSE_MARKER,
  ].join('\n');

  assert.deepEqual(readCopiedCandidates(withStray), [directory('.claude')]);
  assert.ok(
    rewriteCopyBlock(withStray, [file('.env')]).includes('npm install'),
    'the command between the markers survived',
  );
});

test('a stray closing marker above the block does not stand in for the block\'s own', () => {
  const withStray = [
    COPY_BLOCK_CLOSE_MARKER,
    'npm install',
    '',
    COPY_BLOCK_OPEN_MARKER,
    COPY_BLOCK_NOTICE,
    'cp -R "$TESSERA_PROJECT_DIR/.claude" .',
    COPY_BLOCK_CLOSE_MARKER,
  ].join('\n');

  assert.deepEqual(readCopiedCandidates(withStray), [directory('.claude')]);
  assert.ok(rewriteCopyBlock(withStray, [file('.env')]).includes('npm install'));
});

test('an unpaired closing marker never swallows the lines above it', () => {
  const damaged = `npm install\n${COPY_BLOCK_CLOSE_MARKER}\nnpm run build`;

  const rewritten = rewriteCopyBlock(damaged, [directory('.claude')]);

  assert.ok(rewritten.includes('npm install'));
  assert.ok(rewritten.includes('npm run build'));
  assert.deepEqual(readCopiedCandidates(rewritten), [directory('.claude')]);
});

test('a block is present only once one has been confirmed, and gone once it is cleared', () => {
  assert.equal(hasCopyBlock(''), false);
  assert.equal(hasCopyBlock('npm install'), false);
  // Half a block is not one, which is what keeps a rewrite off the lines around it.
  assert.equal(hasCopyBlock(`${COPY_BLOCK_OPEN_MARKER}\nnpm install`), false);

  const withBlock = rewriteCopyBlock('npm install', [file('.env.local')]);
  assert.equal(hasCopyBlock(withBlock), true);
  assert.equal(hasCopyBlock(rewriteCopyBlock(withBlock, [])), false);
});

test('a script with no block at all holds no copied candidates', () => {
  assert.deepEqual(readCopiedCandidates(''), []);
  assert.deepEqual(readCopiedCandidates('cp "$TESSERA_PROJECT_DIR/.env" .'), []);
});

test('a line inside the block that is not a generated command is not read as one', () => {
  const script = [
    COPY_BLOCK_OPEN_MARKER,
    'rsync -a "$TESSERA_PROJECT_DIR/.env" .',
    'cp -a "$TESSERA_PROJECT_DIR/.claude" .',
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    COPY_BLOCK_CLOSE_MARKER,
  ].join('\n');

  assert.deepEqual(readCopiedCandidates(script), [file('.env.local')]);
});

test('markers are recognised whatever indentation they were left with', () => {
  const script = [
    `  ${COPY_BLOCK_OPEN_MARKER}`,
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    `\t${COPY_BLOCK_CLOSE_MARKER}`,
    'npm install',
  ].join('\n');

  assert.deepEqual(readCopiedCandidates(script), [file('.env.local')]);
  assert.equal(rewriteCopyBlock(script, []), 'npm install');
});

test('windows line endings in a stored script do not hide the block', () => {
  const script = [
    COPY_BLOCK_OPEN_MARKER,
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    COPY_BLOCK_CLOSE_MARKER,
    'npm install',
  ].join('\r\n');

  assert.deepEqual(readCopiedCandidates(script), [file('.env.local')]);
});
