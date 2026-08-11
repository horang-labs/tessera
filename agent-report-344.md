# Agent report — GitHub issue #344

## Completion status

Complete. Issue #344's CLI-only, Orca-style explicit global `tessera-cli` discovery-skill management is implemented for Claude Code, Codex, and OpenCode. GUI onboarding/health (#345) and whole-app artifact removal (#346) were intentionally not implemented.

Fixed comparison point: `675481aa3886bf072f2e51e8802e27d8e77b8308`.

Implementation commits:

- `123b4acc470baef38b3682a41a4f939a2851bb86` — `feat(cli): manage global provider discovery skills`
- `19e82e44a01b5b2a9460b0d18f9822ee49784c68` — `fix(cli): enforce provider skill ownership boundaries`
- `9e5a31e5b3eb808f1f112051ec93549396e10980` — `fix(cli): harden global skill management transactions`

## Acceptance mapping

| Issue #344 acceptance criterion | Implementation and evidence |
| --- | --- |
| Install, inspect, update, and remove for all three providers | Added `tessera skills status\|install\|update\|remove` with repeatable `--provider`, Control HTTP/service operations, and provider-specific home resolution. CLI seam coverage exercises Claude Code, Codex, and OpenCode. |
| Default to every detected supported provider | Provider Integration detects the supported providers in the resolved Agent Environment and uses that set only when `--provider` is absent. Empty detection fails without touching any home. |
| Selected set is all-or-nothing | Every target is inspected before mutation; collisions stop the whole set. Installs/removals stage and back up provider directories, commit as one operation, roll back in reverse order, and commit consent only after provider paths succeed. Rollback failures are surfaced. A fault-injection test fails the second provider rename and verifies that neither provider nor consent remains changed. |
| State is user-global per Agent Environment | The consent ledger is keyed by a hash of user identity, then Agent Environment and provider. It is not Project/Worktree/Session state. Native and WSL fake homes are isolated; changing environments leaves the prior installation intact and starts without consent in the new environment. |
| Newly detected provider needs consent | Detection expands status only. Launch inspection does not install without that environment/provider's granted consent. |
| Keep current after consent; remove revokes | Launch maintenance updates a consented stale Tessera-owned skill. Explicit remove records `revoked`; later launch remains nonblocking and does not reinstall until explicit install grants consent again. |
| Never overwrite/remove a user skill; external edits conflict | A same-name path without Tessera ownership metadata is user-owned. Tessera-owned content is digest checked. User collisions and later external modifications return conflict and preserve content; status and uninstall use the same rules. |
| Skill problems never block Session launch | Provider Integration converts absent/stale/conflict/unavailable skill states into optional/degraded or unchecked health and always permits launch. Required Codex lifecycle health is not incorrectly elevated by a ready optional skill. |
| Managed-only authority | The installed skill remains discovery-only. Managed launches receive `TESSERA_CLI_COMMAND` backed by a private scoped runtime descriptor and a distinct bearer credential mapped server-side to immutable Agent Environment/Project/Session context. They do not receive the user-global credential, cannot downgrade by clearing caller environment variables, and global skill mutations are rejected. Outside a Managed Session the skill has no injected command or authority. |

Additional product-contract coverage:

- Explicit provider selections are de-duplicated and preserve unselected providers.
- Provider skill homes are resolved through each `CliProvider`; bridged Windows-backend + WSL resolution uses the actual WSL provider configuration/home and never falls back to the Windows side.
- Concurrent management/launch work is serialized within Provider Integration so consent ledger updates are not lost.
- Existing per-Session skill injection was removed. Codex/OpenCode overlays preserve user-global content and retain only their separate lifecycle responsibilities.

## Architecture

`ProviderIntegration` is the shared policy boundary. It resolves the launch Agent Environment once, delegates global skill work to `ProviderSkillManager`, and returns path-free lifecycle/skill/aggregate-health decisions to launch callers.

Each provider adapter owns `resolveSkillHome(environment)`. The shared home helper handles native versus Windows-hosted WSL routing and provider-specific environment variables without consulting the opposite filesystem.

`ProviderSkillManager` owns detection, the user/environment/provider consent ledger, ownership inspection, digest-based freshness, transaction staging/rollback, status, explicit management, and nonblocking launch maintenance. Managed artifacts contain `.tessera-managed.json`; files without valid ownership metadata are never adopted.

The CLI uses the existing version-matched local Control transport. User-invoked Control uses the private user-global runtime descriptor. Each Managed Session bridge instead creates and owns a scoped descriptor with a separate credential registered to fixed server-side caller context; disposal revokes the credential and removes the descriptor.

`bin/provider-skill-ids.json` is the single provider-ID manifest. The ESM CLI reads it directly, and server compilation copies it into `dist-server/bin` for the emitted CommonJS server.

## Changed files

- CLI and manifest: `bin/control-cli.mjs`, `bin/provider-skill-ids.json`.
- Provider Integration and global manager: `src/lib/cli/provider-integration.ts`, `src/lib/cli/provider-skill-management.ts`.
- Provider-owned home seam: `src/lib/cli/providers/provider-contract.ts`, `src/lib/cli/providers/provider-skill-home.ts`, and the Claude Code, Codex, and OpenCode adapters.
- Control transport: `src/lib/control/cli-bridge.ts`, `http-handler.ts`, `runtime-host.ts`, and `service.ts`.
- Launch/overlay integration: `src/lib/terminal/provider-launch-module.ts`, `tessera-control-skill.ts`, Codex overlay files, and OpenCode overlay files.
- Removed obsolete per-Session Claude skill overlays: `src/lib/terminal/claude-skill-overlay.ts`, `claude-skill-overlay-wsl.ts`, and their WSL test.
- Tests: `tests/provider-skill-management.test.ts`, `provider-skill-cli.test.ts`, `control-cli-bridge.test.ts`, `codex-provider-integration.test.ts`, plus updated provider launch, bundled skill, Codex overlay, and OpenCode overlay coverage.

Total against the fixed point: 30 files, 2,149 insertions, 609 deletions before this report.

## Tests and results

All completion-gate checks passed:

- `npm run lint -- --quiet` — pass, 0 errors.
- `npx tsc --noEmit` — pass.
- `npm run server:compile` — pass; `bin/provider-skill-ids.json` emitted at `dist-server/bin/provider-skill-ids.json`.
- `node --import tsx --test tests/provider-launch-module.test.ts tests/tessera-control-skill.test.ts tests/codex-wsl-overlay.test.ts tests/opencode-wsl-overlay.test.ts tests/provider-skill-management.test.ts tests/provider-skill-cli.test.ts tests/codex-provider-integration.test.ts tests/control-cli-bridge.test.ts tests/control-runtime-host.test.ts` — 61 tests passed, 0 failed.
- `NODE_ENV=production npm run build` — pass; optimized production build, TypeScript, all 46 static pages, and trace collection completed.
- `graphify update .` — pass after the final code changes. Graphify warned that the data-only JSON manifest has no AST nodes, as expected.

The focused tests use isolated temporary native and WSL provider homes and never write a real Claude Code, Codex, or OpenCode home. Coverage includes all providers, explicit/default selection, consent persistence and revocation, environment changes, newly detected providers, concurrency, collision/external modification, status, update, uninstall, mid-commit rollback, Managed credential scoping with cleared caller environment, and nonblocking Session launch.

A one-process repository-wide test attempt earlier in the work was not a useful completion gate: the unconstrained run hung on long-running/concurrent server tests, while a forced/concurrency-limited run exposed existing unrelated baseline contract/UI failures. For example, `tests/active-workspace-session.test.ts` imports the nonexistent `buildWorkspaceExplorerSessionId`; the same source and test are present at the fixed starting commit. No #344-focused or changed-area test is failing.

## Code review findings and resolutions

The required `$code-review` was run from `675481aa3886bf072f2e51e8802e27d8e77b8308` with parallel Standards and Spec reviewers, followed by repeated parallel re-review after fixes.

Resolved Standards findings:

- Rollback and staging cleanup errors were being swallowed: aggregate failures now preserve the primary and rollback errors; committed-backup cleanup is correctly treated as post-commit garbage collection.
- Provider-specific home dispatch leaked into the shared manager: home selection moved behind the `CliProvider` interface.
- Provider IDs were duplicated: CLI and server now share one packaged JSON manifest compatible with ESM, emitted CommonJS, and npm/Electron layout.
- Concurrent commands could lose ledger updates: Provider Integration management/maintenance operations are serialized and regression tested.
- Header-only Managed capability could be omitted to broaden authority: Managed bridges now use separate scoped bearer credentials/descriptors, not the global credential or caller-controlled authority headers.

Resolved Spec findings:

- Managed Sessions could reach user-global mutations: service guarding and then non-downgradable scoped transport credentials close the path, including when caller environment IDs are cleared.
- Agent Environment could be re-resolved during launch maintenance: maintenance stays pinned to the launch resolution.
- Pre-consent user collisions were hidden: launch performs read-only inspection and reports conflict without installation.
- Multi-provider rollback was best-effort: rollback failures are explicit, and injected second-provider commit failure proves the ordinary observable all-or-nothing path.
- Ready optional Codex skill incorrectly made aggregate health healthy while its required lifecycle was unchecked: aggregate health now remains unchecked and has regression coverage.

Final review result: no actionable Standards findings and no actionable Spec findings.

## Cross-boundary gaps

- No real provider home was mutated, by requirement. Therefore the exact installed Claude Code/Codex/OpenCode binaries did not consume the new global skill from the user's real WSL homes in this run.
- No packaged Windows Electron instance was used to perform real-home installation. Existing bridge tests did cross the live WSL-to-Windows PowerShell/Node boundary and passed, while provider-home routing and transactions used isolated fake native/WSL homes. A packaged real-home exercise would contradict the ticket's test constraint unless a separately isolated Windows user/provider home is provisioned.
- GUI consent/onboarding/health remains #345. Whole-app owned-artifact removal remains #346.

## Final status

Complete, reviewed, committed, and ready for integration. No push, PR, issue mutation, merge, or other Worktree change was performed.
