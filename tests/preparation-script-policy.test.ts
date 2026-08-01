import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasPreparationScript,
  normalizePreparationScript,
} from '@/lib/projects/preparation-script-policy';

test('a never-written script and a blank script normalize to the same absence', () => {
  assert.equal(normalizePreparationScript(null), null);
  assert.equal(normalizePreparationScript(undefined), null);
  assert.equal(normalizePreparationScript(''), null);
  assert.equal(normalizePreparationScript('   '), null);
  assert.equal(normalizePreparationScript('\n\t \r\n'), null);
});

test('a script with content keeps its body and loses only surrounding blank space', () => {
  assert.equal(normalizePreparationScript('cp "$TESSERA_PROJECT_PATH/.env" .'), 'cp "$TESSERA_PROJECT_PATH/.env" .');
  assert.equal(normalizePreparationScript('\n  npm install\n\n'), 'npm install');
});

test('indentation inside a multi-line script survives normalization', () => {
  const script = 'if [ -f .env ]; then\n  echo present\nfi';
  assert.equal(normalizePreparationScript(script), script);
});

test('windows line endings normalize to newlines so a stored script reads back the same everywhere', () => {
  assert.equal(normalizePreparationScript('a\r\nb\r\n'), 'a\nb');
  assert.equal(normalizePreparationScript('a\rb'), 'a\nb');
});

test('presence follows normalization, so blank input counts as no script', () => {
  assert.equal(hasPreparationScript(null), false);
  assert.equal(hasPreparationScript(undefined), false);
  assert.equal(hasPreparationScript(''), false);
  assert.equal(hasPreparationScript('  \n  '), false);
  assert.equal(hasPreparationScript('npm install'), true);
  assert.equal(hasPreparationScript('\n#comment only\n'), true);
});
