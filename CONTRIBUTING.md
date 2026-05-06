# Contributing to Tessera

Thanks for your interest in contributing. Tessera is still early and moving quickly, so the easiest contributions to review are small, focused, and tied to a concrete issue or workflow.

## Good Contributions

- Clear bug reports with reproduction steps, logs, screenshots, or short screen recordings.
- Platform fixes for Windows, WSL, macOS, and the npm/browser runtime.
- Documentation improvements, setup notes, troubleshooting tips, and README fixes.
- Small UI polish with before/after screenshots.
- Provider-specific fixes that preserve the native behavior of Claude Code, Codex, or OpenCode.

## Before You Start

- For bugs, open an issue with the environment details and reproduction steps.
- For larger features, new provider integrations, workflow changes, or architecture changes, open an issue first so we can align on the approach.
- Open pull requests against `main` unless a maintainer asks otherwise.
- Keep pull requests focused. Avoid unrelated refactors, broad formatting-only changes, or mixing several features into one PR.
- Do not include secrets, private prompts, API keys, tokens, private repository names, or sensitive logs in issues or PRs.

## Development Setup

Install dependencies:

```bash
npm install
```

Run the local development server:

```bash
npm run dev
```

The `dev` script runs Tessera's custom `server.ts` runtime in development mode on port `3100` by default. Do not run `next dev` directly for local development.

To run on a different port:

```bash
PORT=32124 npm run dev
```

## Checks

Before opening a PR, run the checks that match your change:

```bash
npm run lint
npm run build
```

For UI changes, include screenshots or a short recording. For desktop/runtime changes, mention the OS and runtime you tested.

## Pull Request Guidelines

- Explain what changed and why.
- Link the issue when there is one.
- Include test notes, even if the note is "not tested" with a reason.
- Keep the PR small enough to review in one pass when possible.
