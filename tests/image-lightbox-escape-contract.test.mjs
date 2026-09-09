import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('image lightbox claims Escape before the PTY chat view capture handler', () => {
  const chatAreaSource = read('../src/components/chat/chat-area.tsx');
  const imageLightboxSource = read('../src/components/chat/image-lightbox.tsx');
  const closeOnEscapeSource = read('../src/hooks/use-close-on-escape.ts');

  assert.match(chatAreaSource, /onKeyDownCapture=\{handleTerminalChatKeyDown\}/);
  assert.match(
    imageLightboxSource,
    /useCloseOnEscape\(closeLightbox, \{ capture: true \}\)/,
  );
  assert.match(closeOnEscapeSource, /event\.preventDefault\(\)/);
  assert.match(closeOnEscapeSource, /event\.stopPropagation\(\)/);
  assert.match(
    closeOnEscapeSource,
    /document\.addEventListener\('keydown', handleEscape, capture\)/,
  );
});

test('image lightbox owns mobile gestures and clears the image opener focus when it closes', () => {
  const imageLightboxSource = read('../src/components/chat/image-lightbox.tsx');

  assert.match(
    imageLightboxSource,
    /touchAction:\s*'none'/,
    'the browser must not turn a pinch on the lightbox into page zoom',
  );
  assert.match(
    imageLightboxSource,
    /document\.activeElement instanceof HTMLElement[\s\S]*?\.blur\(\)/,
    'closing must clear the focused image opener so Android does not restore its keyboard',
  );
});
