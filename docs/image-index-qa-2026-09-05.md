# Image index verification — 2026-09-05

## Contract

- Codex terminal Images tabs load persisted cards first. Only the selected session's visible Images tab synchronizes, on a serial two-second timer.
- SQLite stores cards, ordered image occurrences, pending image calls, decoder state, and the complete-line byte checkpoint together. Images live in session-owned disk files; persisted state contains no image base64.
- Initial indexing reads the transcript in bounded batches. Later indexing reads appended records; replacement/truncation invalidates the checkpoint. Incomplete final lines are retried.
- References are resolved against history at invocation time. Ambiguous references/results are explicitly unresolved, not guessed.
- Session deletion removes its cache. Closing a tab or restarting the application preserves it.
- Transient decoding and browser image display still use memory; this is not a claim of zero memory usage or proof against all application OOM causes.

## Evidence

Actual packaged Windows Electron/backend with WSL transcript files, separate owned test database and profile. UI tests append recorded protocol fixtures; they do not invoke a paid model or image generator.

- Final build: call card 1,877 ms; completed image 2,046 ms; tab revisit 35 ms.
- Verified appended-byte count, inactive-session polling stop, closed-Images-tab polling stop, cached display with source unavailable, and page reload.
- Full server restart on the preceding build: two cached cards in 154 ms; pending call restored and completed on the same card with unchanged reference inputs; cached image HTTP 200.
- Final build, read-only real transcript (472,434,659 bytes): initial indexing 5,025 ms across 18 batches; 48 cards; subsequent cached metadata query 18 ms, 301,887 bytes.
- Windows-over-WSL testing caught unstable birth time in file identity. Identity now uses device/inode; append no longer triggers a complete rescan.
- 49 focused tests pass; TypeScript and targeted ESLint pass.
- Full unit suite: 1,925 pass, two skip, two fail. Both failures reproduced on clean HEAD: `git-action-failure-report.test.ts` action count and `worktree-identity-persistence.test.ts` ordering.

Screenshots: `C:\Users\work\Downloads\image-index-qa-final-0905`.

## Boundaries

Incremental indexing currently targets Codex terminal sessions. A first-ever index can take seconds; warm cards do not wait for it. Individual image files are capped at 25 MiB and JSONL records at 96 MiB. Unsupported dynamic reference expressions remain unresolved. Existing heap diagnostics are retained for sustained real-use observation.
