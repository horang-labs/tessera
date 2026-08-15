# Mobile remote README demo

- Asset: `mobile-remote.gif`
- Recorded: 2026-08-15
- Source viewport: 390 × 844 CSS pixels, dark color scheme
- Editorial crop: 32 pixels from the left edge, removing only the provider quota rail
- Output: 358 × 844, 157 frames, 13.08 seconds, 1,746,749 bytes
- SHA-256: `fdb04945a810869ec66de28768cd459f5ffaec6b2bf355841e7b67c0c485ed4a`
- Seed: read-only `/home/work/.tessera_demo` copy; combined database fingerprint
  `24d4a3a2b5c85dd177963636c1058a552d0523ac16b032b9f55d90b0f2b4574f`
- Reproduce: build the production UI with `npm run build`, then run
  `scripts/readme/record-mobile-remote.sh`

The story uses only existing persisted GUI sessions and their original transcript history:

1. `commands.ts command handler`
   - Tessera session: `acd4f912-392b-4a24-b9bc-783883bc9c8c`
   - Provider: OpenCode
   - Original history SHA-256:
     `508f1719945536252fa4055c81a3f571b43e423ab23f2f1645ad9bf8629858db`
2. `MV3 service worker connectivity`
   - Tessera session: `230084a9-6d71-4124-8f9f-310195947560`
   - Provider: OpenCode
   - Original history SHA-256:
     `2b96331d2c06483e308f25f7788d307221c3b208b3e341be408c51288bd9197e`

The recorder copies and migrates the seed privately, maps only project/worktree filesystem
paths to `/tmp/tessera-mobile-demo`, and preserves session titles, provider state, collections,
tasks, and history. It opens on the populated mobile sidebar, cuts to the real command-handler
conversation and attachment affordance, returns briefly to the real session list, then ends on
the populated MV3 investigation. It does not create or open a Shell, create a session or
worktree, send input, stage an attachment, inject UI, mock a provider, or claim PTY behavior.
