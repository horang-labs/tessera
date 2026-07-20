import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeShellPath } from '../src/lib/terminal/shell-path-escape';

test('safe paths pass through without quoting', () => {
  assert.equal(escapeShellPath('/Users/rs/source/tessera/src/index.ts'), '/Users/rs/source/tessera/src/index.ts');
  assert.equal(escapeShellPath('relative/path-to_file.@2x.png'), 'relative/path-to_file.@2x.png');
});

test('paths with spaces or shell metacharacters are single-quoted', () => {
  assert.equal(escapeShellPath('/tmp/my file.txt'), "'/tmp/my file.txt'");
  assert.equal(escapeShellPath('/tmp/$(rm -rf).txt'), "'/tmp/$(rm -rf).txt'");
  assert.equal(escapeShellPath('/tmp/a;b&c.txt'), "'/tmp/a;b&c.txt'");
});

test('embedded single quotes are escaped so the shell reads one literal path', () => {
  assert.equal(escapeShellPath("/tmp/it's here.txt"), "'/tmp/it'\\''s here.txt'");
});

test('paths with control characters are rejected', () => {
  assert.equal(escapeShellPath('/tmp/evil\nrm -rf ~'), null);
  assert.equal(escapeShellPath('/tmp/bell\x07.txt'), null);
  assert.equal(escapeShellPath('/tmp/del\x7f.txt'), null);
});
