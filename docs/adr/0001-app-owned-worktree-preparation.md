# Worktree preparation runs in the app, not in a Git hook

A newly created worktree is missing everything Git does not track — local configuration files a project needs to run. Git already offers a hook for this: `post-checkout` fires on `git worktree add`, runs with the new worktree as its working directory, and receives a null SHA as its first argument so worktree creation is distinguishable from a branch switch. We nonetheless run preparation from the app, and store the preparation script in Tessera rather than in a file committed to the repository.

## Why not the Git hook

Measured, not assumed:

- **A failing hook fails the worktree creation.** When `post-checkout` exits non-zero, `git worktree add` exits 1 — but the worktree is already on disk. Tessera reports a non-zero `git worktree add` as a creation failure, so one failed `pnpm install` would produce "worktree creation failed" alongside a worktree that exists. That is the worst kind of inconsistency to debug.
- **Hook output is unobservable.** It is interleaved into the Git process's stdout, and Tessera's Git runner collects output only when the process closes. A multi-minute preparation would show nothing, and there would be no way to cancel it or retry it.
- **The hook slot is not ours to take.** Repositories that set `core.hooksPath` (husky and friends) ignore hooks placed in `.git/hooks` entirely, and a repository that already has a `post-checkout` cannot have it overwritten.

Orca, Herdr, and vibe-kanban all reached the same conclusion independently: none of them install Git hooks for this.

## Why the script lives in the app

Committing preparation config to the repository is the common alternative (Orca's `orca.yaml`, herdr plugins' `.worktree-seed`). It buys team sharing, and it costs a trust gate: if the app executes a script found in a repository, cloning someone's repository becomes remote code execution. Tessera is used primarily on personal projects, where the sharing is worth little and the trust gate is real work. Storing the script per project inside Tessera avoids the question entirely.

## Consequences

- Tessera owns the execution layer — native/WSL routing, shell wrapping per platform, and preparation status tracking.
- Team sharing stays possible later by adding file support, but it must arrive together with a trust gate.
- A repository that already has its own `post-checkout` will still run it, so preparation may appear to happen twice.
