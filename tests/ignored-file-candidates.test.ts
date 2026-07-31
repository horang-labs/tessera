import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyIgnoredFileCandidate,
  isIgnoredFileCandidateTickedByDefault,
  parseIgnoredFileCandidates,
} from '@/lib/projects/ignored-file-candidates';

/** What git writes for the paths below, NUL-separated as `-z` asks for. */
function gitOutput(...paths: string[]): string {
  return paths.map((path) => `${path}\0`).join('');
}

test('each NUL-separated path becomes one candidate', () => {
  const candidates = parseIgnoredFileCandidates(gitOutput('.env.local', 'node_modules/', 'dist/'));

  assert.deepEqual(candidates, [
    { path: '.env.local', isDirectory: false },
    { path: 'node_modules', isDirectory: true },
    { path: 'dist', isDirectory: true },
  ]);
});

test('a trailing slash is what marks a directory, and it is not kept in the path', () => {
  const [directory, file] = parseIgnoredFileCandidates(gitOutput('.claude/', '.claude-settings'));

  assert.deepEqual(directory, { path: '.claude', isDirectory: true });
  assert.deepEqual(file, { path: '.claude-settings', isDirectory: false });
});

test('a path holding a control character is dropped, not offered as a candidate', () => {
  // NUL separation is what lets the scan see such a path at all; a copy command
  // is one line, so there is no way to write one for it.
  assert.deepEqual(
    parseIgnoredFileCandidates(gitOutput('odd\nname.log', '.env', 'bell\u0007.json')),
    [{ path: '.env', isDirectory: false }],
  );
});

test('empty output, and the empty run left by a trailing separator, yield nothing', () => {
  assert.deepEqual(parseIgnoredFileCandidates(''), []);
  assert.deepEqual(parseIgnoredFileCandidates('\0'), []);
  assert.deepEqual(parseIgnoredFileCandidates('.env\0\0'), [
    { path: '.env', isDirectory: false },
  ]);
});

test('git answered with a trimmed run, as the shared runner hands it over', () => {
  // The git runner trims its stdout, so the final NUL may be gone by the time
  // the output arrives here.
  assert.deepEqual(parseIgnoredFileCandidates('.env\0node_modules/'), [
    { path: '.env', isDirectory: false },
    { path: 'node_modules', isDirectory: true },
  ]);
});

test('a duplicate path is listed once', () => {
  assert.deepEqual(parseIgnoredFileCandidates(gitOutput('.env', '.env')), [
    { path: '.env', isDirectory: false },
  ]);
});

test('configuration files are recognised as such', () => {
  for (const path of ['.env', '.env.local', '.env.development.local', 'config.local.json', 'settings.local.yml', '.npmrc', '.tool-versions']) {
    assert.equal(
      classifyIgnoredFileCandidate({ path, isDirectory: false }),
      'configuration',
      `expected ${path} to be configuration`,
    );
  }
});

test('agent instruction files and directories are recognised as such', () => {
  assert.equal(classifyIgnoredFileCandidate({ path: '.claude', isDirectory: true }), 'instructions');
  assert.equal(classifyIgnoredFileCandidate({ path: 'CLAUDE.local.md', isDirectory: false }), 'instructions');
  assert.equal(classifyIgnoredFileCandidate({ path: 'AGENTS.md', isDirectory: false }), 'instructions');
});

test('dependency directories, build output, logs and images are recognised as such', () => {
  assert.equal(classifyIgnoredFileCandidate({ path: 'node_modules', isDirectory: true }), 'dependencies');
  assert.equal(classifyIgnoredFileCandidate({ path: '.venv', isDirectory: true }), 'dependencies');
  assert.equal(classifyIgnoredFileCandidate({ path: 'dist', isDirectory: true }), 'buildOutput');
  assert.equal(classifyIgnoredFileCandidate({ path: '.next', isDirectory: true }), 'buildOutput');
  assert.equal(classifyIgnoredFileCandidate({ path: 'debug.log', isDirectory: false }), 'logs');
  assert.equal(classifyIgnoredFileCandidate({ path: 'logs', isDirectory: true }), 'logs');
  assert.equal(classifyIgnoredFileCandidate({ path: 'screenshot.png', isDirectory: false }), 'images');
});

test('a nested path is classified by its own name, not the directory holding it', () => {
  assert.equal(
    classifyIgnoredFileCandidate({ path: 'apps/web/.env.local', isDirectory: false }),
    'configuration',
  );
  assert.equal(
    classifyIgnoredFileCandidate({ path: 'packages/api/node_modules', isDirectory: true }),
    'dependencies',
  );
});

test('anything the rules do not cover is unrecognised', () => {
  assert.equal(classifyIgnoredFileCandidate({ path: 'scratch.txt', isDirectory: false }), 'unrecognised');
  assert.equal(classifyIgnoredFileCandidate({ path: 'private', isDirectory: true }), 'unrecognised');
});

test('configuration and instructions are ticked, everything else is not', () => {
  const ticked = [
    { path: '.env.local', isDirectory: false },
    { path: '.claude', isDirectory: true },
    { path: 'CLAUDE.local.md', isDirectory: false },
  ];
  const unticked = [
    { path: 'node_modules', isDirectory: true },
    { path: 'dist', isDirectory: true },
    { path: 'debug.log', isDirectory: false },
    { path: 'cover.jpg', isDirectory: false },
  ];

  for (const candidate of ticked) {
    assert.equal(isIgnoredFileCandidateTickedByDefault(candidate), true, candidate.path);
  }
  for (const candidate of unticked) {
    assert.equal(isIgnoredFileCandidateTickedByDefault(candidate), false, candidate.path);
  }
});

test('an unrecognised entry stays unticked, so nothing unknown is copied by accident', () => {
  assert.equal(
    isIgnoredFileCandidateTickedByDefault({ path: 'scratch.txt', isDirectory: false }),
    false,
  );
  assert.equal(
    isIgnoredFileCandidateTickedByDefault({ path: 'private', isDirectory: true }),
    false,
  );
});

test('a configuration extension on a directory does not make it configuration', () => {
  // A directory's size is unknown, so only the named instruction directories
  // are ticked; anything else claiming a configuration name is not.
  assert.equal(
    classifyIgnoredFileCandidate({ path: 'generated.json', isDirectory: true }),
    'unrecognised',
  );
  assert.equal(
    isIgnoredFileCandidateTickedByDefault({ path: 'generated.json', isDirectory: true }),
    false,
  );
});
