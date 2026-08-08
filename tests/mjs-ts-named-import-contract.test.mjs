// Ticket #278 — a `.test.mjs` must be able to name the exports of a `.ts` module.
//
// This package has no `"type": "module"`, so tsx below 4.23.0 transpiled a bare `.ts`
// to CommonJS and handed the ESM importer a namespace carrying only `default`. A plain
//   import { thing } from '../src/lib/…/module.ts'
// then threw at link time, before a single assertion ran:
//   SyntaxError: The requested module '…' does not provide an export named 'thing'
// #254's unit file could therefore never go green — the export was always there.
//
// The trap was in the loader, not in the modules, and not in what they import: the two
// `.test.mjs` files that appeared to be immune were only using `import * as ns` plus
// `ns.default ?? ns`, which survives the CJS interop. `package.json` already asked for
// a tsx new enough to be fixed; only `package-lock.json` was pinned behind it, so
// `npm install` passed while `npm ci` failed.
//
// So: tsx is held at ^4.23.11 and plain named imports are the correct thing to write in
// a new `.test.mjs`. The namespace dance is not needed, and downgrading tsx brings the
// whole class of failure back — which is what the last case here guards.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A module that carries a type-only import — the shape #278 was filed against.
import { buildMessageInputDisplayContent } from '../src/lib/chat/attachment-content.ts';
// A module with no imports at all, to pin down that the import list never mattered.
import { ANCHORED_VIEWPORT_MARGIN } from '../src/lib/ui/anchored-viewport.ts';

test('a .ts module carrying a type-only import exposes its named exports to a .mjs importer', () => {
  assert.equal(typeof buildMessageInputDisplayContent, 'function');
});

test('a .ts module with no imports of its own is no different', () => {
  assert.equal(typeof ANCHORED_VIEWPORT_MARGIN, 'number');
});

test('tsx is declared new enough that named imports resolve', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const range = manifest.devDependencies.tsx;
  const floor = /^\^?(\d+)\.(\d+)\./.exec(range);
  assert.ok(floor, `could not read a version floor out of tsx range "${range}"`);
  const [, major, minor] = floor.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 23),
    `tsx must stay at 4.23 or newer — below it a .test.mjs cannot name a .ts export (got "${range}")`,
  );
});
