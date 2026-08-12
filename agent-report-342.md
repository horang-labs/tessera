# Agent report — GitHub issue #342

## Completion status

Complete. Managed Codex Sessions are bound to the authoritative provider home where their
provider conversation was created. Resume is fail-closed when that home or provider history is
unavailable, external provider sessions are not adopted, and outside-Tessera turns on an already
managed conversation are synchronized back into Tessera history without granting the external
runtime Tessera control authority.

The implementation was reviewed from the fixed point
`b710e8e6bec9c11adcd75dc705f1c7855b5d7ded`.

Product commits:

- `6fc5a389a1d74ba48339f681f932934abac67c17` — `feat: bind managed Codex sessions to origin home`
- `b78ee66a9b60101acac88e80c3dc22ffbe66cd76` — `fix(codex): harden managed session ownership`
- `7637f46ecaf5aef2e2252631fa1517a058151db9` — `fix(codex): close managed origin-home review gaps (#342)`
- `880b4c77e104e30f15a2c0da8f05cf60368419d4` — `fix(codex): synchronize managed resume state (#342)`
- `8881e552358c536fb1df928a8e9def4a200f34f6` — `fix(codex): normalize resumed provider history (#342)`
- `067145077c447e771d14ddad67c8d53630bc5587` — `refactor(codex): own resume history matching (#342)`

## Acceptance mapping

| Requirement | Implementation and evidence |
| --- | --- |
| Managed Sessions remain bound to their origin home | The database stores an immutable branded provider-home identity. Fresh app-server and direct-TUI handshakes persist it fail-closed; a verified legacy GUI resume binds an unbound migrated row only after the exact prepared home proves it owns the provider history. |
| Home changes require confirmation when Sessions become unavailable | Settings inspection resolves current and target provider homes and counts only managed Sessions transitioning from the current identity to a different target identity. The API and settings UI require explicit confirmation when the count is nonzero. |
| Resume availability follows the origin home | Provider Integration compares the immutable origin identity with the exact prepared authoritative home. A mismatch blocks resume; switching the authoritative environment back makes the identity match again without copying or rerouting provider state. |
| External Sessions are not adopted | Provider-session reconciliation requires managed lineage. Unknown history selections remain external and cannot create or bind a Tessera management record. |
| Outside-Tessera turns remain in managed history without external authority | Before GUI resume, Codex reads the rollout from the exact prepared home and imports only the provider-owned suffix. Provider-facing input translations and stable rollout tool identity make the operation idempotent across live/rollout representation differences. The external runtime never receives a Tessera pane token or control context. |
| Concurrent execution is prevented; parallel work uses a fork | Resume inspection and a continuing runtime-owner guard reject or terminate a second owner of the same rollout. Native fork creates a distinct provider conversation and independent Tessera history. |
| Deleting management does not delete provider history | Session deletion removes Tessera management state and history only; no provider-owned Codex rollout is removed. Regression coverage verifies this contract. |
| Missing provider history retains the record and reports unavailable | Exact-home history inspection fails resume closed with a provider-history-unavailable reason. It neither deletes the Session record nor restores, copies, or searches another home. |

## Architecture

- `ProviderIntegration` carries path-free provider decisions and opaque preparations pinned to
  the exact authoritative home.
- The provider contract exposes home-binding, resume inspection, runtime ownership, and exact-home
  history reading capabilities. Shared terminal launch code consumes capabilities rather than
  decoding Codex provider state.
- Codex owns its history identity rules in
  `src/lib/cli/providers/codex/resume-history.ts`; the shared session module only persists a suffix
  selected by the provider.
- Provider-home identity is immutable in Tessera persistence. Migration adds the column without
  guessing or backfilling old rows.
- The exact legacy overlay exception remains limited to resume of that existing overlay Session;
  new, forked, and derived executions use the authoritative real home.

The product diff is 57 files, 2,288 insertions, and 144 deletions.

## Verification

- Affected integration suite before the final history-only seam refinements — **PASS, 113/113**.
- Final history/provider integration focus:
  `node --import tsx --test tests/provider-resume-history.test.ts tests/codex-provider-integration.test.ts`
  — **PASS, 14/14**.
- Runtime ownership boundary test alone:
  `node --import tsx --test tests/codex-managed-runtime-ownership.test.ts` — **PASS, 3/3**.
- The final 12-file affected suite observed **113/114 passing**; its one failure was the same
  real-file-owner probe exceeding its hard-coded 5-second subprocess timeout. The unchanged test
  passed 3/3 immediately when isolated. Earlier the same full suite passed 113/113 before the
  additional history regression was added.
- `npx tsc --noEmit` — **PASS**.
- `npm run lint -- --quiet` — **PASS**.
- `npm run server:compile` — **PASS**.
- `npm run electron:compile` — **PASS**.
- `npm run build` — **PASS** after the final provider-seam refactor.
- `git diff --check` — **PASS**.
- `graphify update .` — **PASS** after final source edits: 11,101 nodes, 29,054 edges,
  420 communities. The tool retained its existing warning that `provider-skill-ids.json`
  produces no AST nodes.

## Independent fixed-point review

Standards and Spec reviews ran independently against
`b710e8e6bec9c11adcd75dc705f1c7855b5d7ded`.

Resolved review findings included:

- provider-specific resume lookup escaping the provider interface;
- fresh direct-TUI origin binding being overwritten by an inherited pane token;
- missing managed rows and failed binding not failing closed;
- legacy GUI rows remaining permanently unbound despite verified exact-home resume;
- external GUI history not entering Tessera's canonical history;
- home-change impact counting Sessions already unavailable before the proposed transition;
- false history divergence from translated inputs and live-only tool metadata;
- Codex-specific history normalization living in a shared session module.

Final Standards review at `0671450`: **PASS, no actionable findings**.

Final Spec review at `0671450`: **PASS, all eight acceptance criteria satisfied**.

## Boundary and scope

Native and simulated Windows-backend-to-WSL/custom-home behavior was exercised with isolated
fixtures and fake provider processes. No packaged Windows Electron instance was launched, and no
real Claude Code, Codex, or OpenCode home was read or modified. Nothing was pushed or merged, and
the GitHub issue was not edited or closed.
