import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

test('npm CLI package keeps Linux-friendly runtime dependencies and executable bin', () => {
  const binPath = new URL('../bin/tessera.mjs', import.meta.url);
  const binMode = fs.statSync(binPath).mode;

  assert.equal(packageJson.bin.tessera, 'bin/tessera.mjs');
  assert.equal(packageJson.dependencies['node-pty'], '1.2.0-beta.13');
  assert.ok(binMode & 0o111, 'bin/tessera.mjs must be executable in npm tarballs');
});

test('npm package excludes Next development build artifacts', () => {
  const files = packageJson.files;

  assert.ok(files.includes('.next/'));
  assert.ok(files.includes('!.next/dev/'));
  assert.ok(files.includes('!.next/dev/**'));
  assert.ok(files.includes('!.next/diagnostics/'));
  assert.ok(files.includes('!.next/diagnostics/**'));
  assert.ok(files.includes('!.next/cache/'));
  assert.ok(files.includes('!.next/cache/**'));
});
