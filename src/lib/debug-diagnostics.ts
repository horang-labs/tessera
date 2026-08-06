/**
 * Whether this build emits development-grade diagnostics — the store invariant checks and
 * per-message traces that a release normally compiles away.
 *
 * Guarding those on `NODE_ENV === 'development'` alone means a packaged build can never
 * produce them, which is exactly when a hard-to-reproduce bug needs them. The debug build
 * scripts (`electron:build:*:debug`) set `NEXT_PUBLIC_TESSERA_LOG_LEVEL=debug`, so the
 * checks survive there and nowhere else.
 *
 * Both operands are replaced with literals at build time, so a normal release still folds
 * this to `false` and drops the guarded blocks.
 */
export const DEBUG_DIAGNOSTICS =
  process.env.NODE_ENV === 'development' ||
  process.env.NEXT_PUBLIC_TESSERA_LOG_LEVEL === 'debug';
