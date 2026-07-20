import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const panelResizeSource = read('src/hooks/use-panel-resize.ts');
const terminalSurfaceSource = read('src/lib/terminal/terminal-surface-registry.ts');

test('panel divider drag owns the PTY resize hold lifecycle', () => {
  assert.match(panelResizeSource, /terminalPtyResizeHoldRef\.current = holdTerminalPtyResizes\(\);/);
  assert.match(panelResizeSource, /const handlePointerUp = \(\) => stopDragging\(\)\?\.flush\(\);/);
  assert.match(panelResizeSource, /terminalPtyResizeHoldRef\.current\?\.cancel\(\);/);
  assert.match(panelResizeSource, /window\.addEventListener\('blur', handleWindowBlur\);/);
  assert.match(panelResizeSource, /document\.addEventListener\('pointercancel', handlePointerCancel\);/);
});

test('terminal surfaces queue PTY resizes while a divider hold is active', () => {
  assert.match(
    terminalSurfaceSource,
    /if \(!queueTerminalPtyResizeIfHeld\(this\.surfaceId, request, send\)\) send\(request\);/,
  );
  assert.match(
    terminalSurfaceSource,
    /connectionGeneration !== this\.attachedConnectionGeneration/,
  );
});
