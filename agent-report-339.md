# Agent Report — GitHub Issue #339

## Completion status

Complete. The behavior-preserving shared Provider Integration prefactor is implemented, reviewed against fixed starting commit `501aa399b51be7e928ba3d34fed50a69efb2c0a5`, tested, and committed. No later real-home, hook-management, skill-management, consent UI, conflict-resolution, health-enforcement, removal, or acceptance-ticket behavior was added.

## Acceptance-criterion mapping

1. **Codex app-server and direct TUI use one public boundary** — `CodexAdapter.spawn()` and `createProviderLaunchModule()` both call the injectable `ProviderIntegration.resolveLaunch()` boundary. Production defaults use the same `providerIntegration` singleton.
2. **Native and WSL launch behavior is unchanged** — user-owned launches resolve the saved Agent Environment with the existing `getAgentEnvironment(userId)` path; userless app-server launches preserve the prior native server default through an explicit `server-default` owner. Callers continue their existing command, cwd, inherited-home, Claude overlay, and Codex overlay behavior after the policy decision.
3. **The boundary represents policy without filesystem mechanics** — the public decision expresses Agent Environment-owned provider home, required/optional/not-applicable lifecycle and skill policy, consent/artifact state, and per-provider/environment integration health. It exposes no home path and performs no home mutation. Codex declares required lifecycle integration and optional provider skill through its provider contract.
4. **Highest existing seams are covered** — focused tests exercise a real `CodexAdapter.spawn()` JSON-RPC handshake and the direct provider launch module, injecting the same public policy interface and asserting unchanged launch effects.
5. **Existing provider and Control Service tests remain green** — the focused provider suite and the proportionate provider/control/path regression suite pass; typecheck and full lint also pass.

## Architecture summary

`src/lib/cli/provider-integration.ts` is the shared, path-free policy boundary. Its launch request makes environment ownership explicit as either a known Tessera user or the pre-existing server default. It resolves Agent Environment ownership and returns representational lifecycle, skill, consent/conflict-capable artifact, and health state.

Provider-specific requirements live behind `CliProvider.getProviderIntegrationRequirements()`, keeping Codex policy with the Codex provider. Both launch surfaces accept boundary injection for seam-level tests and otherwise use the shared production singleton. The callers consume only the resolved Agent Environment/provider-home ownership needed to preserve today's launch behavior. Future health, lifecycle, skill, consent, and conflict outcomes remain representational and do not gate launches in this ticket.

This preserves the filesystem ownership rule: a Windows backend launching a WSL agent resolves the WSL Agent Environment and never substitutes the server's Windows home; native launches retain native ownership. No authoritative provider-home path is selected or mutated by this prefactor.

## Changed files

- `src/lib/cli/provider-integration.ts` — adds the shared policy vocabulary, explicit environment ownership request, path-free decision, and singleton.
- `src/lib/cli/providers/codex/adapter.ts` — routes app-server launch through the shared boundary while retaining command/cwd/environment behavior.
- `src/lib/cli/providers/provider-contract.ts` — adds provider-owned integration requirement declarations.
- `src/lib/cli/providers/types.ts` — exports the new provider requirement type.
- `src/lib/cli/spawn-cli.ts` — exposes the existing explicit server-default Agent Environment resolver.
- `src/lib/terminal/provider-launch-module.ts` — routes direct TUI launch through the same boundary without altering overlay behavior.
- `tests/codex-provider-integration.test.ts` — covers path-free policy representation, explicit server-default ownership, and app-server delegation with a real fake JSON-RPC process.
- `tests/provider-launch-module.test.ts` — covers direct TUI delegation and unchanged Codex overlay environment.

## Test commands and results

Test-first development established the direct-TUI seam first (initial failure: shared module absent), then the app-server seam (initial failure: the boundary was not called). Review fixes were likewise exercised against the focused tests before implementation.

- `npx tsx --test tests/codex-provider-integration.test.ts tests/provider-launch-module.test.ts`
  - PASS — 26 tests passed, 0 failed, 0 skipped.
- `npx tsx --test tests/codex-provider-integration.test.ts tests/provider-launch-module.test.ts tests/provider-terminal-launch.test.ts tests/codex-skills-refresh.test.ts tests/control-service.test.ts tests/control-cli-integration.test.ts tests/control-session-operations.test.ts tests/control-runtime-host.test.ts tests/agent-environment-paths.test.ts tests/spawn-cli-supplemental-paths.test.ts`
  - PASS — 84 tests total: 83 passed, 0 failed, 1 platform skip (`macOS: PATH includes Homebrew dirs when present`, skipped on Linux).
- `npx tsc --noEmit`
  - PASS — exit 0, no diagnostics.
- `npx eslint src/lib/cli/provider-integration.ts src/lib/cli/providers/codex/adapter.ts src/lib/cli/providers/provider-contract.ts src/lib/cli/providers/types.ts src/lib/cli/spawn-cli.ts src/lib/terminal/provider-launch-module.ts tests/codex-provider-integration.test.ts tests/provider-launch-module.test.ts`
  - PASS — exit 0, no diagnostics.
- `npm run lint`
  - PASS — exit 0, no errors or warnings.
- `graphify update .`
  - PASS — graph rebuilt after the final source change (10,760 nodes, 28,213 edges). The generated graph artifacts are ignored and did not change the tracked diff.
- `git diff --check 501aa399b51be7e928ba3d34fed50a69efb2c0a5...HEAD`
  - PASS — exit 0.

## `$code-review` findings and resolutions

The required review ran in parallel along both axes against `501aa399b51be7e928ba3d34fed50a69efb2c0a5`.

### Standards

- **Provider-specific policy was hard-coded outside provider contracts** — resolved by adding `getProviderIntegrationRequirements()` to `CliProvider`; Codex now owns its required-lifecycle/optional-skill declaration.
- **Optional `userId` could silently fall back to native** — resolved with the explicit `agentEnvironmentOwner` discriminated union. Known users must supply a user ID; the pre-existing userless adapter case deliberately selects `server-default`.
- **Repeated Codex/mode switches and filesystem-mode leakage** — resolved by removing caller-visible overlay modes and repeated policy branches. The decision exposes ownership and Agent Environment, not a filesystem path or overlay mechanism.
- **Duplicated test integration factories** — resolved by consolidating the focused test setup.
- **Speculative future policy/runtime branches** — initially identified because future health/skill/lifecycle branches were unreachable. Those branches were removed. The remaining consent/conflict/health and lifecycle/skill vocabulary is explicitly required by issue #339 and remains representational; the final Standards re-review reported no actionable findings.

### Spec

- **Provider-home filesystem mechanism leaked to callers** — resolved by replacing the session-overlay mode with path-free Agent Environment ownership.
- **Lifecycle was incorrectly required for every provider** — resolved with provider-owned requirements; the default is not-applicable lifecycle, while Codex declares required lifecycle.
- **A review fix rejected app-server launches without a user and changed observable behavior** — resolved by mapping that existing case explicitly to `server-default`, which preserves the former native fallback without hiding ownership.
- **A later review fix prematurely enforced future health/skill/lifecycle decisions** — resolved by removing the new launch gates and restoring unconditional existing Claude-optional/Codex-required overlay behavior. The final Spec re-review reported no actionable findings.

Final review result: **no remaining actionable Standards or Spec findings**.

## Commits

- `5958ef0` — `refactor(providers): share integration launch policy (#339)`
- `08cd4cf` — `fix(providers): keep integration policy path-free (#339)`
- `10383f6` — `fix(providers): preserve explicit environment ownership (#339)`
- `f877129` — `fix(providers): keep future policy representational (#339)`

Final product commit hash: `f8771291f23a008c81f667a883c573c12ecf87cc`.

## Final git status

`git status --short` is empty after committing this report.

## Remaining risks and unverified cross-boundary behavior

- No packaged Windows-backend/WSL-agent Electron instance was launched. This ticket does not change filesystem access or introduce the later real-home behavior; WSL ownership was verified through focused fake-environment and existing path tests instead. Actual packaged cross-boundary acceptance remains for the later behavior/acceptance tickets.
- The macOS-only PATH test was skipped because verification ran on Linux/WSL.
- Future hook installation, skill installation, consent persistence, conflict detection, health enforcement, GUI/CLI management, removal, and real-home selection remain intentionally unimplemented and TBD under their later tickets/ADRs.
