# Tessera CLI orchestration GIF provenance

- Output: `tessera-cli-orchestration.gif`
- Story: full-screen prompt → concise success → Board with three cards → real child result → populated Board
- Sources: four authentic 2100×1350 full-screen PNG checkpoints and four CLI JSON evidence snapshots captured on 2026-08-15
- Scene inputs: `01-prompt-ready.png` → `02-cli-success.png` → `03-board-three.png` → `04-child-result.png` → `03-board-three.png`; the final scene deliberately reuses the fully visible Board frame
- Rendering: full-frame Lanczos scaling to 1280×823, 2.2-second scene holds, four 200 ms crossfades, 128-color GIF; no crop, overlays, captions, invented UI, or synthesized state
- Duration: 11.8 seconds (25 frames, looping)
- Output SHA-256: `02df7c3e3503d833ffac85a4718f49d3a6f30172c3eaf20258ef6ae25a45861d`

## Source SHA-256

| Source | SHA-256 |
| --- | --- |
| `keyframes/01-prompt-ready.png` | `a794763568631217bad5c544f25677077fb4c1d4cee90ffc87130efe59263e25` |
| `keyframes/02-cli-success.png` | `5afa1085e21d252c5e37e0627f7245625647e7e49673be854d043984cac3faa0` |
| `keyframes/03-board-three.png` | `7df899bc751d60b8673f70f3c76c573936c348a0418403f652d3040573837b07` |
| `keyframes/04-child-result.png` | `704ab37887e989bf7a13c56fb5a9b95896f59e329d92e7a1d6ea6cf0d8aac180` |
| `cli/session-1.json` | `04f4d4dda024242e63c4bf436cb0e1efb4fe1c04b4ff76adcbe3952182d902a0` |
| `cli/session-2.json` | `7ebad8ec692eeb12b17862220b0f709ee5fe4bb90bd6282f4c9f061413f79e88` |
| `cli/session-3.json` | `209c2b53900c37ae51a430d03200b7909969aef0d5a3057a75a0e4cc01d50665` |
| `cli/worktrees.json` | `0a1155e7ca83978a3059dc58f4eb3d1604f311c62f6d2aaf7b660d6d971e1660` |

Render with `scripts/render-readme-tessera-cli-orchestration.sh`; pass an alternate checkpoint root and output path as its two optional arguments.
