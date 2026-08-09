// Stops @xterm/xterm from sending a mouse report whose coordinates are not numbers.
// Like patch-xterm-touch-scroll.mjs and patch-xterm-webgl-atlas.mjs, this is idempotent.
// An unrecognised or missing target fails closed: silently shipping an
// unverified xterm bundle would re-open the PTY corruption this patch prevents.
//
// Both shipped bundles are patched: bundlers that honor the package's `module` field
// (Next.js webpack — the one the app actually loads) resolve lib/xterm.mjs, while `main`
// resolvers get lib/xterm.js. The two are minified by different tools, so each has its own
// find/replace strings.
//
// The bug — MouseCoordsService.getMouseReportCoords
//   `getCoordsRelativeToElement` computes `event.clientX - rect.left - paddingLeft`. When
//   the event carries no `clientX` that is `undefined - number`, which is NaN, and the
//   Math.min/Math.max/Math.floor chain that follows preserves it. The method then returns
//   `{col: NaN, row: NaN, x: NaN, y: NaN}` — an object, so every caller's `if (coords)`
//   guard passes — and the report is encoded as `ESC [ < 65 ; NaN ; NaN M`. That is not a
//   parseable mouse report, so a TUI prints the tail of it as literal text: the
//   `aN;NaNMaN;NaNM…` the user sees in their prompt.
//
//   The event with no `clientX` is xterm's own. `Gesture._handleTouchMove` copies
//   `clientX`/`clientY` onto the CHANGE event it dispatches, but `Gesture._inertia` — which
//   keeps dispatching CHANGE events on animation frames after the finger lifts, to carry
//   the scroll on — sets only `translationX`/`translationY`. So a touch swipe over a TUI
//   that requested wheel reporting produces well-formed reports while the finger is down
//   and coordinate-less ones for as long as the inertia runs.
//
//   The guard goes in `getMouseReportCoords` rather than in the one caller, because
//   returning nothing is what the method already does when it cannot place the event
//   (`hasValidSize` false) and every caller already handles it. A report with no position
//   has nothing to tell the TUI, so dropping it costs nothing.
//
//   Non-touch machines cannot reach the inertia path at all: Gesture.addTarget no-ops
//   unless Gesture.isTouchDevice(). A real mouse always carries coordinates, so the guard
//   is inert on the desktop paths that share this method.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// esbuild (lib/xterm.mjs): `t` is the [x, y] pair from getCoordsRelativeToElement.
const MJS_REPORT_COORDS_BUGGY =
  'getMouseReportCoords(i,e){let t=qt(se(e),i,e);'
  + 'if(this._charSizeService.hasValidSize)return';
const MJS_REPORT_COORDS_FIXED =
  'getMouseReportCoords(i,e){let t=qt(se(e),i,e);'
  + 'if(this._charSizeService.hasValidSize&&Number.isFinite(t[0])&&Number.isFinite(t[1]))return';

// terser (lib/xterm.js): same shape, with the pair in `i` and the helpers still namespaced.
const JS_REPORT_COORDS_BUGGY =
  'getMouseReportCoords(e,t){const i=(0,n.getCoordsRelativeToElement)((0,o.getWindow)(t),e,t);'
  + 'if(this._charSizeService.hasValidSize)return';
const JS_REPORT_COORDS_FIXED =
  'getMouseReportCoords(e,t){const i=(0,n.getCoordsRelativeToElement)((0,o.getWindow)(t),e,t);'
  + 'if(this._charSizeService.hasValidSize&&Number.isFinite(i[0])&&Number.isFinite(i[1]))return';

const TARGETS = [
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.mjs',
    patches: [
      {
        name: 'mouse report coords without a position (mjs)',
        find: MJS_REPORT_COORDS_BUGGY,
        replace: MJS_REPORT_COORDS_FIXED,
      },
    ],
  },
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.js',
    patches: [
      {
        name: 'mouse report coords without a position (js)',
        find: JS_REPORT_COORDS_BUGGY,
        replace: JS_REPORT_COORDS_FIXED,
      },
    ],
  },
];

const plannedWrites = [];
const failures = [];

for (const target of TARGETS) {
  if (!existsSync(target.file)) {
    failures.push(`expected bundle not found: ${target.file}`);
    continue;
  }

  const original = readFileSync(target.file, 'utf8');
  let patched = original;
  const applied = [];

  for (const patch of target.patches) {
    if (patched.includes(patch.replace) && !patched.includes(patch.find)) {
      continue; // already applied
    }
    if (!patched.includes(patch.find)) {
      failures.push(`target for "${patch.name}" not found in ${target.file}`);
      continue;
    }
    patched = patched.replace(patch.find, patch.replace);
    applied.push(patch.name);
  }

  if (patched !== original) plannedWrites.push({ ...target, source: patched, applied });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[patch-xterm-mouse-report-coords] ${failure}`);
  }
  throw new Error('Refusing to continue with an unverified xterm mouse-coordinate patch.');
}

for (const planned of plannedWrites) {
  writeFileSync(planned.file, planned.source);
  for (const name of planned.applied) {
    console.log(`[patch-xterm-mouse-report-coords] applied: ${name}`);
  }
}
