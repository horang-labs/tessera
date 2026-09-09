# Transcript image reference resolution — 2026-09-06

## Change

The Codex terminal image index now recognizes exec reference-only cells, including
`const paths = [...] ; store("refs", paths)`, then resolves later
`load("refs")` and `[p[0], p[1]]` inputs. It interprets data expressions using an
AST, without executing transcript JavaScript. Locals last for one exec cell;
stored reference values are persisted with the existing SQLite byte checkpoint.
Tool outputs do not execute the same bindings a second time. Failed cells discard
predicted bindings. Cards freeze their resolved inputs at invocation time.

Supported data expressions include strings, numbers, null, arrays, spreads of
known arrays, array indexes, string concatenation and template interpolation.
Unknown values, helper shadowing, ambiguous writes and duplicate reference keys
stay unresolved. This is not an arbitrary JavaScript interpreter. Reference
storage accepts path-like values only: at most 64 keys, 16 KiB per value, with
128 KiB source and 32-level expression limits. Other stored output/base64 is not
retained. Existing checkpoints/cards are preserved; no historical repair runs.

The existing session-owned image files, environment-aware path conversion,
visible-tab-only polling and incremental transcript reader are unchanged.

## Verification

- Replayed the reported transcript in order: both failing calls resolve all three
  inputs, including Korean filenames, with no unresolved references.
- 39 focused decoder, resolver, incremental-state, SQLite persistence and image
  projection tests passed. TypeScript and targeted ESLint passed.
- Regression cases cover store/load across serialized state, output replay,
  frozen inputs, unknown overwrites, storage bounds, Promise wrappers, chained
  calls, tool-argument mutations, duplicate properties, helper shadowing and
  unrelated destructuring.
- Real isolated packaged Windows backend reading WSL JSONL/image fixtures:
  both reference forms show three inputs; metadata order and cached HTTP image
  bytes match the supplied files; unknown references show a warning; reload and
  source-file deletion retain cached inputs. No paid generator/CLI call is made.
- Full unit suite: 1,941 pass, two skipped, two fail. Contracts: 435 pass, two
  fail. All four failures reproduced in a detached checkout of the unchanged
  base `06aa0ef5`: `git-action-failure-report`, `worktree-identity-persistence`,
  `app-click-telemetry-contract`, `pty-ui-cleanup-contract`.

Repro entry point: `tests/image-reference-electron.e2e.cjs` (Windows Node;
launcher ownership manifest, Windows-readable WSL fixture directory, corresponding
Linux fixture directory, screenshot directory). Screenshots are retained in
`C:\Users\work\Downloads\image-refs-qa-0906ke`.
