# Desktop README advertising assets

These are the approved final advertising assets for the desktop README.

| Asset | Story | Export | SHA-256 |
| --- | --- | --- | --- |
| `pty-chatview.gif` | A populated live Codex PTY conversation starts immediately, the real header Chat View control opens the same transcript, and the real composer sends “Turn the checks into a helper.” | 1280×823, 12 fps, 13.25 s, 159 frames, 3,078,893 bytes | `6ffec89d7cf05ef11cfe2515166dfbe33b4a050e0af4a97cd095edd5dfdd4c35` |
| `file-git-workflow.gif` | A changed `demo-notes.md` opens in the real Files panel, gains a useful retry-timeout note, saves, opens its real diff, selects the file, enters `docs: clarify retry guidance`, and reveals the primary Git action ladder. | 1280×823, 12 fps, 12.33 s, 148 frames, 1,778,892 bytes | `45373ae3c2466405ce7e484ad8fdef5c16375cf5857238371a9e82df0b53292f` |

## Final full-frame composition

- Every frame preserves the complete 1400×900 Electron renderer, including the left rail, header, workspace, right rail when open, and footer.
- The masters are scaled proportionally to 1280×823. No crop, punch-in, padding, reframing, or spatially selective transform is applied.

## Real-product provenance

Every visible screen is the renderer of the real packaged Windows Tessera app in the manifest-owned isolated instance `codex-readme-gifs-192739` (`Tessera [TEST · codex-readme-gifs-192739]`). Its packaged Windows server is on port 32125 and its CDP endpoint is owned by the same Electron process on port 9338. The app was seeded from the copied disposable demo home; the original installed Tessera remained on port 32123.

The PTY is a real WSL Codex process and the chat transcript is the product's real PTY Chat View projection. The file edit was typed into Tessera's real Monaco editor and saved to the disposable demo worktree. The diff, selection checkbox, commit message field, primary Commit button, and action ladder are all real Git panel controls. No commit, push, pull, or pull request action was executed.

The recorder drives real controls through Electron CDP. It does not create or alter visible DOM, insert overlays, replace text, mock status, or fake terminal/chat/editor content. Post-processing is limited to uniform aspect-ratio-preserving scaling, frame-rate conversion, and GIF palette quantization; no source region is removed or covered. The 1400×900 WebM masters remain in ignored local staging and hash to `4a7020fc6915a4a66dadc862a4747cd543da26bb7539cbc088b66914c1c2098e` (PTY) and `50b0dc5b027d90b9da250df5b6ee8341782d11e0b39bda2f7150ccb7e375f17e` (Files/Git).

Run `scripts/render-readme-demo-assets.sh <staging-dir>` to reproduce the GIF conversion from those masters.
