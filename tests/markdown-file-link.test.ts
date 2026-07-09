import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalFileHref } from '../src/lib/workspace-tabs/file-path-actions';

test('treats POSIX absolute paths as local files', () => {
  assert.equal(parseLocalFileHref('/Users/rs/source/foxden/doc.md'), '/Users/rs/source/foxden/doc.md');
  assert.equal(parseLocalFileHref('/tmp/output.html'), '/tmp/output.html');
});

test('treats Windows absolute paths as local files', () => {
  assert.equal(parseLocalFileHref('C:\\Users\\rs\\doc.md'), 'C:\\Users\\rs\\doc.md');
  assert.equal(parseLocalFileHref('D:/projects/app/file.ts'), 'D:/projects/app/file.ts');
});

test('decodes file:// URLs into filesystem paths', () => {
  assert.equal(parseLocalFileHref('file:///Users/rs/a%20b.md'), '/Users/rs/a b.md');
  // Windows file URL keeps the drive letter, drops the spurious leading slash.
  assert.equal(parseLocalFileHref('file:///C:/Users/rs/doc.md'), 'C:/Users/rs/doc.md');
});

test('leaves web URLs and non-file links as normal links', () => {
  assert.equal(parseLocalFileHref('https://example.com/path'), null);
  assert.equal(parseLocalFileHref('http://localhost:4173/foo'), null);
  assert.equal(parseLocalFileHref('mailto:a@b.com'), null);
  assert.equal(parseLocalFileHref('#section'), null);
  assert.equal(parseLocalFileHref('//cdn.example.com/x.js'), null); // protocol-relative
  assert.equal(parseLocalFileHref('./relative/path.md'), null);
  assert.equal(parseLocalFileHref('relative/path.md'), null);
});

test('handles empty and missing hrefs', () => {
  assert.equal(parseLocalFileHref(undefined), null);
  assert.equal(parseLocalFileHref(null), null);
  assert.equal(parseLocalFileHref(''), null);
  assert.equal(parseLocalFileHref('   '), null);
});
