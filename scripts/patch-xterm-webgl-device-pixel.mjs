// Stops @xterm/addon-webgl from shrinking its canvas back to a 1x backing store when the
// browser reports a device pixel box that contradicts devicePixelRatio, which is what
// makes terminal glyphs render at devicePixelRatio times their intended size (#256). Like
// patch-xterm-webgl-atlas.mjs and patch-xterm-touch-scroll.mjs, this is idempotent and
// no-ops when its target string is absent (e.g. after an upgrade that renames or fixes it
// upstream) so a changed bundle is never corrupted.
//
// Both shipped bundles are patched: bundlers that honor the package's `module` field
// (Next.js webpack — the one the app actually loads) resolve lib/addon-webgl.mjs, while
// `main` resolvers get lib/addon-webgl.js. The two are minified by different tools, so
// each has its own find/replace strings.
//
// The bug — observeDevicePixelDimensions
//   The WebGL canvas is sized twice. WebglRenderer.handleResize sets it to
//   `dimensions.device.canvas`, which is the CSS size multiplied by the renderer's cached
//   devicePixelRatio, and that is also what every render layer beside it (the link layer)
//   is sized to. Then a ResizeObserver watching `device-pixel-content-box` calls
//   _setCanvasDevicePixelDimensions with whatever the browser reports, so the browser's
//   number wins for the WebGL canvas alone.
//
//   Those two numbers are meant to agree; the observer exists to absorb sub-pixel
//   differences on fractional ratios. They stop agreeing under Chromium's device-metrics
//   emulation (CDP Emulation.setDeviceMetricsOverride, which is what Playwright's
//   `deviceScaleFactor` and DevTools' device toolbar both use): `window.devicePixelRatio`
//   becomes the emulated ratio while `devicePixelContentBoxSize` keeps reporting the
//   host's real 1x box. Measured on this repo's Chromium at 360x880: an element with a
//   293x708 CSS box reports 293x708 device pixels at emulated DPR 3, and 879x2124 when the
//   same ratio comes from a real display scale (--force-device-scale-factor=3).
//
//   The glyphs are still rasterised into the DPR-scaled coordinate space the renderer
//   computed, so a backing store shrunk to 1x magnifies everything by exactly
//   devicePixelRatio — the reported symptom, where ten characters fill a 360px phone and
//   every line runs off the right edge.
//
//   The fix drops only a report that contradicts the ratio the same element's window
//   reports, comparing against the entry's own CSS content box so it stays generic in the
//   ratio. A real display scale reports a box that agrees within the rounding of one
//   pixel, so this is a no-op on a device and on a HiDPI desktop; only a contradictory
//   report is ignored, and the canvas then keeps the size handleResize gave it — the same
//   size the link layer beside it already has.
//
//   The ratio is read from the element's own window rather than the global one, because
//   the popped-out board window mounts terminals in a second window whose scale can differ.
//
// On an xterm upgrade, re-check: whether the observer still overwrites a size handleResize
// already set, and whether upstream started reconciling the two itself.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// esbuild (lib/addon-webgl.mjs): `i` is the observed element, `a` the ResizeObserver entry.
const MJS_OBSERVER_BUGGY =
  'let o=a.devicePixelContentBoxSize[0].inlineSize,n=a.devicePixelContentBoxSize[0].blockSize;'
  + 'o>0&&n>0&&t(o,n)';
const MJS_OBSERVER_FIXED =
  'let o=a.devicePixelContentBoxSize[0].inlineSize,n=a.devicePixelContentBoxSize[0].blockSize,'
  + 'ratio=i.ownerDocument.defaultView?.devicePixelRatio||1,'
  + 'cssBox=a.contentBoxSize&&a.contentBoxSize[0];'
  + 'if(cssBox&&cssBox.inlineSize>0&&Math.abs(o-cssBox.inlineSize*ratio)>1)return;'
  + 'o>0&&n>0&&t(o,n)';

// terser (lib/addon-webgl.js): `t` is the observed element, `s` the entry, `i` the callback.
// The window parameter is shadowed by the observer callback's own `e`, which is another
// reason to reach the ratio through the element.
const JS_OBSERVER_BUGGY =
  'const a=s.devicePixelContentBoxSize[0].inlineSize,o=s.devicePixelContentBoxSize[0].blockSize;'
  + 'a>0&&o>0&&i(a,o)';
const JS_OBSERVER_FIXED =
  'const a=s.devicePixelContentBoxSize[0].inlineSize,o=s.devicePixelContentBoxSize[0].blockSize,'
  + 'ratio=t.ownerDocument.defaultView?.devicePixelRatio||1,'
  + 'cssBox=s.contentBoxSize&&s.contentBoxSize[0];'
  + 'if(cssBox&&cssBox.inlineSize>0&&Math.abs(a-cssBox.inlineSize*ratio)>1)return;'
  + 'a>0&&o>0&&i(a,o)';

const TARGETS = [
  {
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
    patches: [
      {
        name: 'device pixel box contradicting devicePixelRatio (mjs)',
        find: MJS_OBSERVER_BUGGY,
        replace: MJS_OBSERVER_FIXED,
      },
    ],
  },
  {
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
    patches: [
      {
        name: 'device pixel box contradicting devicePixelRatio (js)',
        find: JS_OBSERVER_BUGGY,
        replace: JS_OBSERVER_FIXED,
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
        `[patch-xterm-webgl-device-pixel] target for "${patch.name}" not found`
          + ' — addon version likely changed. Skipping.',
      );
      continue;
    }
    src = src.replace(patch.find, patch.replace);
    changed = true;
    console.log(`[patch-xterm-webgl-device-pixel] applied: ${patch.name}`);
  }

  if (changed) {
    writeFileSync(target.file, src);
  }
}
