# Contributing to Tessera

Thanks for your interest in Tessera. The best contributions are small, reproducible, and easy to review.

## Start Here

- New to the project: look for issues labeled `good first issue`.
- Want maintainer input: look for `help wanted` issues or open a GitHub Discussion.
- Reporting a bug: use the bug template and include clear reproduction steps.
- Proposing a larger workflow, new provider integration, or architecture change: open an issue first.

If there is no starter issue open, small docs fixes, focused bug reports, and platform QA notes are still useful.

## Good First Contributions

Good first pull requests usually improve one narrow thing:

- Documentation fixes, missing setup notes, or clearer troubleshooting steps.
- Reproduction steps for rough edges in Windows, macOS, Linux, npm, or desktop builds.
- Small UI polish that is easy to verify with a screenshot or recording.
- Provider diagnostics or compatibility notes for Claude Code, Codex, or OpenCode.
- Focused regression fixes tied to an existing issue.

## Issues

Use the bug or feature template. Screenshots, recordings, and clear reproduction steps are especially helpful. For npm or source installs, include Node.js only when it seems relevant.

## Pull Requests

- Open pull requests against `dev`.
- Keep changes focused.
- Open an issue first for larger features, new provider integrations, workflow changes, or architecture changes.
- Do not include secrets, private prompts, API keys, tokens, private repository names, or sensitive logs.

Small pull requests are reviewed fastest. If your change touches multiple areas, split it into separate PRs when possible.

## Cross-Platform Support

Tessera supports the npm runtime and desktop builds across Windows, macOS, and Linux. When changing runtime, filesystem, process spawning, shell, path, Electron, or CLI-provider behavior, keep cross-platform behavior in mind.

Test on the platforms you can access, and note what you tested in the PR. If you could not test a relevant platform, mention that too.

## Source Setup

```bash
npm install
npm run dev
```

The dev server runs through `server.ts` on port `3100` by default. Do not run `next dev` directly.

## Checks

For code changes, run the checks that match your change:

```bash
npm run lint
npx tsc --noEmit
NODE_ENV=production npm run build
```

For UI changes, include screenshots or a short recording.

## Review Expectations

Please describe what changed, what you tested, and what you could not test. It is fine if you cannot test every platform; call that out in the PR so reviewers know where to focus.

Maintainers may ask for smaller follow-up changes instead of broad rewrites. That keeps reviews quick and helps external contributions land without blocking on unrelated refactors.

## Code Guidelines

- Keep provider-specific behavior behind the CLI provider interfaces.
- Prefer existing local patterns over new abstractions.
- Avoid broad refactors in feature or bugfix PRs.
