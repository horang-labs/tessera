// Stops @xterm/xterm from injecting arrow keys into the PTY when a touch gesture
// scrolls a buffer that has no scrollback. Like patch-xterm-webgl-atlas.mjs, this is
// idempotent and no-ops when its target string is absent (e.g. after an upgrade that
// renames or fixes it upstream) so a changed bundle is never corrupted.
//
// Both shipped bundles are patched: bundlers that honor the package's `module` field
// (Next.js webpack — the one the app actually loads) resolve lib/xterm.mjs, while `main`
// resolvers get lib/xterm.js. The two are minified by different tools, so each has its
// own find/replace strings.
//
// The bug — MouseService._handleTouchChange
//   The handler branches three ways: a TUI that requested wheel reporting gets wheel
//   reports; a buffer with no scrollback gets _handleTouchScrollAsKeys; anything else
//   scrolls the viewport. _handleTouchScrollAsKeys emits ESC [ A / ESC [ B through
//   triggerDataEvent, one per cell of travel, straight to the PTY. An alt-screen buffer
//   has hasScrollback === false, so on a touch device one swipe over a TUI becomes dozens
//   of arrow keys — history navigation in an input box, or literal [A / [B on screen.
//   There is no option to disable it.
//
//   Only the no-scrollback branch is removed. The wheel-report branch and the
//   viewport-scroll branch stay: they are what make TUI wheel scrolling and ordinary cell
//   scrolling work. With the branch gone, an alt screen without wheel reporting falls
//   through to a viewport scroll and finds nothing to scroll — which is exactly what a
//   desktop mouse wheel already does in the same state. _handleTouchScrollAsKeys itself is
//   left in place, now unreachable, so the patch stays as small as the behavior change.
//
//   Non-touch machines cannot reach this code at all: Gesture.addTarget no-ops unless
//   Gesture.isTouchDevice(), so patching it carries no desktop risk.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// terser (lib/xterm.js) keeps the three branches as a nested conditional expression, and
// orders them the other way round from the source: scrollback scrolls, no scrollback keys.
const JS_TOUCH_CHANGE_BUGGY =
  '_handleTouchChange(e,t){t.preventDefault(),t.stopPropagation(),'
  + 'e.requestedEvents.wheel?this._handleTouchScrollAsWheel(e,t):'
  + 'this._bufferService.buffer.hasScrollback?e.target.handleTouchScroll?.(t.translationY):'
  + 'this._handleTouchScrollAsKeys(t)}';
const JS_TOUCH_CHANGE_FIXED =
  '_handleTouchChange(e,t){t.preventDefault(),t.stopPropagation(),'
  + 'e.requestedEvents.wheel?this._handleTouchScrollAsWheel(e,t):'
  + 'e.target.handleTouchScroll?.(t.translationY)}';

// esbuild (lib/xterm.mjs) keeps the source's early-return shape.
const MJS_TOUCH_CHANGE_BUGGY =
  '_handleTouchChange(i,e){if(e.preventDefault(),e.stopPropagation(),i.requestedEvents.wheel)'
  + '{this._handleTouchScrollAsWheel(i,e);return}'
  + 'if(!this._bufferService.buffer.hasScrollback){this._handleTouchScrollAsKeys(e);return}'
  + 'i.target.handleTouchScroll?.(e.translationY)}';
const MJS_TOUCH_CHANGE_FIXED =
  '_handleTouchChange(i,e){if(e.preventDefault(),e.stopPropagation(),i.requestedEvents.wheel)'
  + '{this._handleTouchScrollAsWheel(i,e);return}'
  + 'i.target.handleTouchScroll?.(e.translationY)}';

const TARGETS = [
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.mjs',
    patches: [
      {
        name: 'touch scroll as arrow keys (mjs)',
        find: MJS_TOUCH_CHANGE_BUGGY,
        replace: MJS_TOUCH_CHANGE_FIXED,
      },
    ],
  },
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.js',
    patches: [
      {
        name: 'touch scroll as arrow keys (js)',
        find: JS_TOUCH_CHANGE_BUGGY,
        replace: JS_TOUCH_CHANGE_FIXED,
      },
    ],
  },
];

for (const target of TARGETS) {
  if (!existsSync(target.file)) continue;

  let src = readFileSync(target.file, 'utf8');
  let changed = false;

  for (const patch of target.patches) {
    if (src.includes(patch.replace) && !src.includes(patch.find)) {
      continue; // already applied
    }
    if (!src.includes(patch.find)) {
      console.warn(
        `[patch-xterm-touch-scroll] target for "${patch.name}" not found — xterm version likely changed. Skipping.`,
      );
      continue;
    }
    src = src.replace(patch.find, patch.replace);
    changed = true;
    console.log(`[patch-xterm-touch-scroll] applied: ${patch.name}`);
  }

  if (changed) {
    writeFileSync(target.file, src);
  }
}
