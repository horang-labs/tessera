# Mobile remote README demo

- Asset: `mobile-remote.gif`
- Recorded: 2026-08-15
- Viewport: 390 × 844 CSS pixels, dark theme
- Output: 390 × 844, 12 fps, 185 frames, 15.41 seconds, 864,640 bytes
- SHA-256: `f2ec64b5ff148c581d5f606a49b5a284a5588c260e5bc895fe45f77175785ae7`
- Seed: read-only `/home/work/.tessera_demo` copy; database fingerprint
  `24d4a3a2b5c85dd177963636c1058a552d0523ac16b032b9f55d90b0f2b4574f`
- Reproduce: `scripts/readme/record-mobile-remote.sh`

The recorder creates a uniquely named private copy, migrates and anonymizes that copy,
and uses a disposable `/tmp/tessera-mobile-demo` Git project. It starts a browser-only
development server with an ephemeral JWT minted from the copied local key; no auth bypass,
credential, token, production database, or normal Tessera home is used or recorded.

The visible flow is real Tessera UI: copied demo session navigation, the compact tab
switcher, a standalone shell PTY, buffered mobile PTY input/send, and the PTY image file
input. The terminal attachment path is an isolated `/tmp/tessera-uploads/...` file. Remote
Access pairing was omitted because it did not improve this short interaction story. The
opening and closing black fades provide a clean loop. No production behavior is modified.
