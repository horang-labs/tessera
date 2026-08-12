# Agent report — issue #343

Issue: **Complete the Codex hook lifecycle and degraded state**

Fixed point: `b710e8e6bec9c11adcd75dc705f1c7855b5d7ded`

## Product commits

- `b1e3dd6` — `feat: complete Codex hook lifecycle management`
- `4e37cdc` — `fix(codex): complete lifecycle review pass`
- `f38c647` — `fix(codex): align lifecycle health semantics`
- `88739e0` — `fix(codex): pin active lifecycle health scope`

## Delivered behavior

- GUI and Control CLI share lifecycle status/install/update/remove parsing and outcomes.
- Consent, managed version, managed definition, and revocation are scoped by Agent Environment and Authoritative Provider Home.
- A consented stale hook is refreshed to the running Tessera version before a new launch or resume.
- Home changes require new consent and do not mutate the previous home.
- External hook changes fail closed as conflicts; automatic maintenance does not overwrite them, while explicit update is the conflict-resolution action.
- Revocation removes only the current home's Tessera-owned hook content, preserves user hooks, and blocks new Codex launch/resume. All-known-home application removal remains issue #346.
- A running Managed Session remains alive with Project-scoped authority when hook health is lost. Its health is projected through API, WebSocket, UI, and Control observation as `degraded`; pre-launch unhealthy lifecycle states remain `blocked`.
- Active health polling is pinned to the launch-time home even if the authoritative home changes later.
- Managed health is isolated by user, Agent Environment, provider, and home; other providers remain available.
- CLI removal exits zero only for the complete `absent` + `revoked` outcome; conflict/unavailable removal exits nonzero.
- Long-lived health timers no longer keep test/server processes alive after work is complete.

## Verification

Passed after the final product changes:

- Focused lifecycle and CLI regression tests: 24/24.
- Widened #343/provider/runtime/UI projection suite: 130/130.
- `npx tsc --noEmit`.
- `npm run lint` (0 errors; 3 existing warnings).
- `npm run server:compile`.
- `npm run electron:compile`.
- `NODE_ENV=production npm run build`.
- `git diff --check`.
- `graphify update .` (11,079 nodes, 28,927 edges; the existing `provider-skill-ids.json` zero-node warning remains).

The broad repository command
`npx tsx --test --test-reporter=spec tests/*.test.ts tests/*.test.tsx tests/*.test.mjs`
reported 2,010 tests: 1,990 passed, 18 failed, and 2 skipped. The 18 failures are unrelated pre-existing/stale contract assertions (workspace special-tab selection, Codex home probe shell shape, deferred/new-tab/rail contracts, several terminal layout/handoff/path/overlay contracts, terminal input-bar key count, workspace drag payload, and workspace folder context-menu source regex). The same failures were present before the final #343 review fixes; sampled assertions already disagree with the fixed-point source (for example multiline/header and combined WSL-branch source-shape regexes). No failing test exercises the #343 lifecycle changes.

## Review

- Standards review found pre-launch `degraded` semantics, ambiguous all-home removal scope, and duplicated Session API health projection. Resolved by reserving `degraded` for active Managed Sessions, documenting current-home removal versus #346 uninstall cleanup, and centralizing the projection.
- Independent Spec review found two gaps: health polling followed a newly selected home, and failed CLI removal returned success. Both were fixed and covered by regressions.
- The same independent Spec reviewer rechecked the final diff: both findings resolved, 24/24 focused tests passed, and no actionable issue remained.

## Risks and follow-ups

- No real provider home was modified and no Electron instance was launched. Native/WSL ownership and health isolation are covered with isolated filesystem and fake Codex app-server boundaries, not a destructive real-home test.
- Full application uninstall across every known native/WSL provider home is deliberately not claimed here; that work is tracked by #346.
- The repository-wide stale contract failures remain outside this issue and should be reconciled separately.
