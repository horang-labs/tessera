# Tessera — agent notes

Guidance for Claude/agents working in this repo. Human contributor setup lives in
`CONTRIBUTING.md` and `README.md`.

## Running the dev server

Standard: `npm install && npm run dev` — runs through `server.ts` on port `3100`
(never `next dev` directly).

**Gotcha — an agent shell often inherits the installed app's production env.**
When Claude Code runs inside (or as a child of) the installed Tessera desktop
app, a plain `npm run dev` fails. Check first: `env | grep -i tessera`.

Inherited vars that break it:

- `TESSERA_APP_ROOT` → points at `…/Tessera.app/…/app.asar`, so Next looks for
  `pages/`/`app/` there and dies with *"Couldn't find any pages or app directory"*.
- `TESSERA_PRODUCTION_DB=1`, `TESSERA_ELECTRON_SERVER=1` → force the **production**
  DB `~/.tessera/tessera.db`, the same file the running app uses. Sharing it can
  corrupt real user data.

Start it safely by stripping those. The dev server then uses the correct project
root and the isolated per-branch dev DB (`~/.tessera/tessera-dev.db`, auto-selected
on any non-`main` branch — see `src/lib/db/location.ts`):

```bash
env -u TESSERA_APP_ROOT -u TESSERA_PRODUCTION_DB -u TESSERA_ELECTRON_SERVER -u __CFBundleIdentifier \
  TESSERA_ELECTRON_AUTH_BYPASS=1 PORT=3100 \
  npm run dev
```

- `TESSERA_ELECTRON_AUTH_BYPASS=1` skips login so the UI is reachable in a browser.
- The dev DB is separate from production, so the installed app keeps running untouched.
- Next's first compile is lazy; wait for port `3100` to listen, then load a page.

## Screenshotting the dev UI

`playwright-cli` drives the browser — general usage and multi-session handling are
in the global `~/.claude/CLAUDE.md`. Against the running dev server, confirm the
sidebar rows rendered (Next compiles lazily) before capturing:

```bash
playwright-cli open http://localhost:3100
playwright-cli --raw eval "document.querySelectorAll('[data-testid^=\"collection-task-\"]').length"
playwright-cli screenshot --filename=/tmp/shot.png --hires
playwright-cli close
```

## Checks (before committing code changes)

```bash
npm run lint
npx tsc --noEmit
```
