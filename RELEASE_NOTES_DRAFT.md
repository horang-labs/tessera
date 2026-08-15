## Tessera v0.2.3

Let agents operate Tessera itself, use Tessera from your phone, and ship changes from the Git panel.

## Highlights

- **Tessera CLI** — Lets agents operate Tessera itself—for example, create isolated Worktrees and Sessions for multiple tickets, monitor progress, and coordinate parallel delivery. **Use:** enable it in **Settings → Development**, then invoke `/tessera-cli` in a managed agent Session
  - Key commands: `tessera status`, `tessera worktree create`, `tessera session launch`, `tessera session wait`, `tessera session read`, `tessera session prompt`
- **Mobile** — Phone-ready UI, touch-friendly PTY controls, image attachments, and secure Tailscale device pairing. **Use:** open **Settings → Remote access**, then pair your phone with the QR code or link
- **Git workflow** — Select and commit files, generate commit messages, pull, push, publish, create PRs, and recover from conflicts. **Use:** open the **Git** panel and follow the primary action
- **Custom models** — Add provider model IDs that are not available through automatic discovery. **Use:** open **Settings → Models** and add the ID
- **PTY Chat View** — Replay Codex and OpenCode terminal conversations, send prompts and attachments, and switch views without losing activity. **Use:** click the chat icon in the PTY Session header
- **Worktree setup** — Run project preparation scripts, copy git-ignored config, inspect logs, and retry failed setup. **Use:** configure it in **Settings → Project**
- **File editing** — Create, edit, rename, and delete files and folders directly in Tessera. **Use:** open the **Files** panel
- **More controls** — GUI/Terminal defaults, slash-command discovery, Sub-Session reordering, and individual Session archive
- **Usage insights** — Basic app usage and feature interaction telemetry now helps improve Tessera; prompts, messages, file paths, command output, and other local content are never collected

## Fixes

- Git diff badges refresh instead of showing stale file and line counts
- The Context panel finds Codex and OpenCode instructions correctly in Windows + WSL setups
- Codex trust choices are remembered across PTY sessions
- The npm package installs correctly again

## Downloads

Windows x64 · macOS Intel · macOS Apple Silicon · Linux x64

The npm package is available as `@horang-labs/tessera@0.2.3`.
