# Contributing to Tessera

Thanks for helping improve Tessera. This project moves quickly, so keep changes
small, focused, and easy to review.

## Branches

- `main` is the released branch.
- `dev` is the integration branch for active work.
- Open pull requests against `dev` unless a maintainer asks otherwise.

## Local Setup

```bash
npm install
npm run dev
```

Use the custom server entry point. Do not run `next dev` directly because the
WebSocket server is started from `server.ts`.

## Before Opening a PR

Run the checks that match your change:

```bash
npm run lint
npx tsc --noEmit
NODE_ENV=production npm run build
```

For UI or Electron changes, also include screenshots or a short QA note in the
PR description.

## Code Guidelines

- Keep provider-specific behavior behind the CLI provider interfaces.
- Prefer existing local patterns over new abstractions.
- Keep React components functional and typed.
- Avoid broad refactors in feature or bugfix PRs.
- Do not commit local data, credentials, generated caches, or private QA output.

## Reporting Bugs

Open an issue with:

- The OS and Node.js version.
- Which CLI provider you used.
- Steps to reproduce.
- Expected vs. actual behavior.
- Logs or screenshots with secrets removed.
