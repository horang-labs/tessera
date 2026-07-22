// Patches two @xterm/addon-webgl WebGL bugs that garble Claude Code TUI output
// on long-running sessions, most visibly on Windows (ANGLE/D3D11) and in
// glyph-heavy Korean sessions. Each patch is applied independently, is
// idempotent, and no-ops when its target string is absent (e.g. after an
// upgrade that renames or fixes it upstream) so a changed bundle is never
// corrupted.
//
// Both shipped bundles are patched: bundlers that honor the package's `module`
// field (Next.js webpack — the one the app actually loads) resolve
// lib/addon-webgl.mjs, while `main` resolvers get lib/addon-webgl.js. The two
// are minified by different tools, so each has its own find/replace strings.
//
// Patch 1 — TextureAtlas.clearTexture() no-op guard
//   clearTexture() early-returns whenever _pages[0].currentRow sits at the
//   origin. A page produced by a page merge is never written through
//   currentRow, so it stays at the origin; once a merged page lands at index 0,
//   every atlas wipe for the rest of the session silently does nothing. The
//   stale coordinates in _cacheMap survive, so glyphs sample the wrong atlas
//   cell after the merge relayouts the pages and paint the "tiny-glyph garble"
//   (fragments of each line drawn at the wrong place). The public entry point
//   clearTextureAtlas() already calls _clearModel(true) and requests a redraw,
//   so dropping the guard completes the recovery chain.
//
// Patch 2 — fragment shader unwritten outColor
//   The fragment shader branches on v_texpage across sampler slots 0..N-1
//   (N = maxAtlasPages, usually 16). A v_texpage past that budget matches no
//   branch, leaving outColor unwritten — undefined behavior in GLSL. Native
//   macOS drivers tend to yield transparent; ANGLE on Windows paints garbage
//   pixels. Long/Korean sessions grow the atlas past the budget via merge
//   fallback, so add a terminal else that renders those pages blank.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SHADER_ELSE = ' else { outColor = vec4(0.0, 0.0, 0.0, 0.0); }';

// The fixed clearTexture also bumps _pageLayoutVersion: upstream only bumps it
// on page merges, so a wipe was invisible to the OTHER renderers sharing the
// atlas (their beginFrame sees an unchanged version and keeps vertex data
// pointing into the wiped texture — the xterm.js #4480 garble family).
const MJS_CLEAR_BUGGY =
  'clearTexture(){if(!(this._pages[0].currentRow.x===0&&this._pages[0].currentRow.y===0)){' +
  'for(let e of this._pages)e.clear();this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1}}';
const MJS_CLEAR_V1 =
  'clearTexture(){for(let e of this._pages)e.clear();' +
  'this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1}';
const MJS_CLEAR_V2 =
  'clearTexture(){for(let e of this._pages)e.clear();' +
  'this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1,this._pageLayoutVersion++}';

const JS_CLEAR_BUGGY =
  'clearTexture(){if(0!==this._pages[0].currentRow.x||0!==this._pages[0].currentRow.y){' +
  'for(const t of this._pages)t.clear();this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1}}';
const JS_CLEAR_V1 =
  'clearTexture(){for(const t of this._pages)t.clear();' +
  'this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1}';
const JS_CLEAR_V2 =
  'clearTexture(){for(const t of this._pages)t.clear();' +
  'this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1,this._pageLayoutVersion++}';

const TARGETS = [
  {
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
    patches: [
      { name: 'clearTexture() wipe + layout bump (mjs)', find: MJS_CLEAR_BUGGY, replace: MJS_CLEAR_V2, optional: true },
      { name: 'clearTexture() layout bump upgrade (mjs)', find: MJS_CLEAR_V1, replace: MJS_CLEAR_V2, optional: true },
      {
        // The .mjs bundle keeps real newline characters inside the template literal.
        name: 'fragment shader unwritten outColor (mjs)',
        find: '  } ${e}\n}`',
        replace: `  } \${e}${SHADER_ELSE}\n}\``,
      },
    ],
  },
  {
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
    patches: [
      { name: 'clearTexture() wipe + layout bump (js)', find: JS_CLEAR_BUGGY, replace: JS_CLEAR_V2, optional: true },
      { name: 'clearTexture() layout bump upgrade (js)', find: JS_CLEAR_V1, replace: JS_CLEAR_V2, optional: true },
      {
        // The .js bundle escapes newlines as backslash-n inside the template literal.
        name: 'fragment shader unwritten outColor (js)',
        find: '  } ${e}\\n}`',
        replace: `  } \${e}${SHADER_ELSE}\\n}\``,
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
      if (!patch.optional) {
        console.warn(
          `[patch-xterm-webgl-atlas] target for "${patch.name}" not found — addon version likely changed. Skipping.`,
        );
      }
      continue;
    }
    src = src.replace(patch.find, patch.replace);
    changed = true;
    console.log(`[patch-xterm-webgl-atlas] applied: ${patch.name}`);
  }

  if (changed) {
    writeFileSync(target.file, src);
  }
  if (!src.includes('this._didWarmUp=!1,this._pageLayoutVersion++')) {
    console.warn(
      `[patch-xterm-webgl-atlas] ${target.file}: clearTexture patch not present after run — addon version likely changed.`,
    );
  }
}
