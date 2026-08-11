# Agent report — GitHub issue #347

## Completion status

Complete for the #347 current-Project control-authority tracer bullet. Product and test changes are committed on `feature/0811-t347`; no push, PR, issue mutation, merge, or other-Worktree modification was performed.

All ticket-affected tests pass. Repository-wide diagnostic runs still expose unrelated baseline failures in files outside this ticket's diff; they are listed under **Tests and results** and were intentionally not changed because the ticket explicitly excludes unrelated work.

## Acceptance-criterion mapping

1. **Every Control Service read and mutation validates current-Project scope — met.** Every public read/mutation resolves a live authority grant before accessing its Project, Worktree, or Session target. HTTP also performs an early authority assertion before route/body parsing.
2. **No cross-Project CLI/HTTP access — met.** Explicit other-Project selectors and other-Project Worktree/Session identifiers are denied through the shared Control Service decision. CLI integration covers the HTTP transport path.
3. **No ordinary in-scope confirmation — met.** Authorized operations continue directly to existing service seams; no confirmation gate was introduced.
4. **Authority expires at Managed Session runtime termination — met.** Each runtime bridge owns a grant and revokes it synchronously when the runtime disposer begins, before asynchronous artifact cleanup. A copied token is denied after disposal.
5. **Child Session receives independent authority — met.** Each newly launched managed runtime prepares its own bridge/grant from that Session's authoritative Project context. Tests show a child grant remains valid after the parent grant is revoked.
6. **Already-running degraded managed Session retains existing authority — met.** Hook health is deliberately not an authority-registry input. An existing runtime grant remains valid until runtime disposal; new/outside runtimes have no grant.
7. **Stable non-disclosing cross-Project errors — met.** Foreign and nonexistent Worktree/Session identifiers both produce the same `CONTROL_AUTHORITY_DENIED` 403 with empty details, preventing an existence oracle. Project denials also contain no internal path or record data.
8. **Direct service and CLI integration exercise one decision — met.** Direct service tests cover all reads/mutations; CLI integration reaches the same service through authenticated HTTP.

## Architecture summary

- `ControlAuthorityRegistry` is process-local to the Control runtime host. It mints 256-bit opaque grants that bind agent environment, Project, Session, and optional Worktree.
- The provider CLI bridge owns the grant for one managed runtime. It injects the token into the protected host bridge and launch environment, passes it across Windows-to-WSL via `WSLENV`, and revokes it on runtime disposal.
- Provider launch construction clears any inherited control authority before adding the fresh bridge, so an external or newly spawned runtime cannot inherit another Session's grant.
- The CLI sends the opaque credential in `x-tessera-control-authority`. Request-supplied Project/Session/Worktree/environment headers are treated as untrusted metadata; the service uses only registry-resolved context.
- The HTTP handler rejects missing/expired authority before route-specific decoding or body reads. Every service operation independently revalidates authority and enforces Project scope.
- Audit persistence, mutation history, high-risk confirmation UX, and unrelated provider-integration work are intentionally absent.

## Changed files

- `src/lib/control/authority.ts` — authority grant/source/registry model.
- `src/lib/control/service.ts` — mandatory authority validation, Project scoping, public denial normalization, non-secret status DTO.
- `src/lib/control/http-handler.ts` — authority header intake and fail-closed pre-routing assertion.
- `src/lib/control/runtime-host.ts` — one shared registry for the service and bridge factory.
- `src/lib/control/cli-bridge.ts` — per-runtime grant creation, credential injection, synchronous revocation, cleanup handling.
- `bin/control-cli.mjs` — forwards the authority credential to Control HTTP.
- `src/lib/terminal/provider-launch-module.ts` — clears inherited authority and installs only the fresh managed bridge.
- `src/lib/terminal/terminal-manager.ts` — crosses the credential into WSL through `WSLENV`.
- `tests/control-authority.test.ts` — service-seam scope, lifetime, degraded, child, all-operation, and existence-oracle coverage.
- `tests/control-cli-bridge.test.ts` — native/WSL bridge credential ownership, secrecy, and expiry.
- `tests/control-cli-integration.test.ts` — CLI/HTTP current-Project behavior and stable cross-Project denial.
- `tests/control-http-handler.test.ts` — forged metadata, outside-Tessera denial, and denial before malformed-body parsing.
- `tests/control-runtime-host.test.ts` — no authority for ordinary external Control callers.
- `tests/control-service.test.ts` — authorized Project/Worktree service fixtures and denial behavior.
- `tests/control-session-database.test.ts` — authorized database seam fixtures and non-disclosing missing-ID behavior.
- `tests/control-session-operations.test.ts` — authorized Session operation fixtures and denial behavior.
- `tests/control-worktree-creation.test.ts` — authoritative Project/environment context for Worktree creation.
- `tests/provider-launch-module.test.ts` — fresh bridge authority injection and inherited-authority clearing.
- `tests/helpers/control-cli-runner.ts` — isolates ambient authority in CLI tests.
- `tests/terminal-contract.test.mjs` — WSL authority propagation/source-contract assertions.

## Tests and results

Final ticket-affected verification:

```text
npm run lint
```

Result: exit 0, 0 errors, 3 existing warnings (`preview-markdown.tsx`, `use-virtual-message-list.ts`, `spawn-cli-runtime.ts`).

```text
npx tsc --noEmit --pretty false
```

Result: exit 0, no diagnostics.

```text
npx tsx --test --test-reporter=tap --test-reporter-destination=/home/work/tmp/t347-final-affected.tap tests/control-authority.test.ts tests/control-service.test.ts tests/control-session-operations.test.ts tests/control-session-database.test.ts tests/control-worktree-creation.test.ts tests/control-http-handler.test.ts tests/control-cli-integration.test.ts tests/control-cli-bridge.test.ts tests/control-runtime-host.test.ts tests/provider-launch-module.test.ts
```

Result: exit 0; 69 tests passed, 0 failed, 0 skipped.

```text
node --test --test-name-pattern="WSL terminals cross hook coordinates and overlay homes via WSLENV" --test-reporter=tap --test-reporter-destination=/home/work/tmp/t347-final-terminal-contract.tap tests/terminal-contract.test.mjs
```

Result: exit 0; 1 test passed, 0 failed.

```text
git diff --check
```

Result: exit 0, no whitespace errors.

Focused post-review authorization verification:

```text
npx tsx --test tests/control-authority.test.ts tests/control-http-handler.test.ts tests/control-service.test.ts tests/control-session-operations.test.ts tests/control-session-database.test.ts tests/control-cli-integration.test.ts
```

Result: exit 0; 31 tests passed, 0 failed.

Repository-wide diagnostics:

```text
npx tsx --test --test-force-exit --test-timeout=60000 --test-reporter=tap --test-reporter-destination=/home/work/tmp/t347-full-ts.tap tests/*.test.ts
```

Result: 1,559 tests; 1,551 passed, 6 failed, 2 skipped. Five failures reproduce alone and are in unchanged, unrelated files: `active-workspace-session.test.ts`, `parent-worktree-authority.test.ts`, two assertions in `terminal-input-bar-input.test.ts`, and `workspace-file-drag-contract.test.ts`. The sixth (`git-commit-message.test.ts`) passed when rerun outside the highly parallel full-suite process. An initial run without `--test-force-exit` was interrupted after unrelated tests retained open handles.

```text
npx tsx --test --test-force-exit --test-timeout=60000 --test-reporter=tap --test-reporter-destination=/home/work/tmp/t347-full-mjs-tsx.tap tests/*.test.mjs
```

Result: 357 tests; 345 passed, 12 failed. All failures are pre-existing static-contract assertions in unchanged files (`model-default-selection-contract`, `new-tab-singleton-contract`, `provider-usage-rail-contract`, several unrelated `terminal-contract` assertions, and `workspace-folder-open-contract`). The #347 WSL authority contract passes in both this run and the focused final run.

## `$code-review` findings and resolutions

Review fixed point: `501aa399b51be7e928ba3d34fed50a69efb2c0a5`.

### Standards

Initial result: **FAIL**, 3 actionable findings.

1. HTTP parsed routes/bodies before rejecting missing managed authority. **Resolved:** added `ControlService.assertAuthority()` at the HTTP boundary before route decoding/body reads and a malformed unauthorized POST regression test.
2. `ControlStatusDto` permitted the authority token and an impossible `null` caller context in its public type. **Resolved:** introduced a non-null `PublicControlCallerContext` derived from resolved authority while excluding `agentEnvironment` and the token.
3. The large CLI integration fixture used a force cast. **Resolved:** replaced it with `satisfies Parameters<typeof createControlService>[0]` and passed the validated fixture directly.

Verification pass: all 3 findings **RESOLVED**; reviewer reported 7/7 focused tests passing.

### Spec

Initial result: **FAIL**, criteria 1–6 and 8 met; criterion 7 partial because foreign-existing versus nonexistent resource IDs formed an existence oracle.

1. Unrestricted Worktree/Session lookup exposed identifier existence through different public errors. **Resolved:** foreign and missing IDs now share one stable 403 denial with empty details; paired Worktree and Session comparisons were added.

Verification pass: finding **RESOLVED**; reviewer reported 5/5 focused tests passing. No scope creep found.

## Commits

- `be5f6f99e8d19eebc40124b3ecc3cbc80e64aff1` — `feat(control): enforce managed session authority`
- `7c032350aaaf87c577345693ff1b64e4441e7dac` — `fix(control): close authority disclosure gaps`

Final product commit hash: `7c032350aaaf87c577345693ff1b64e4441e7dac`.

## Final git status

```text
(empty)
```

The Worktree is clean; the required agent report and all product and test changes are committed.

## Remaining risks and unverified boundaries

- A packaged isolated Windows Electron server with a real WSL provider CLI was not launched. The verified evidence is deterministic service/HTTP/CLI integration, real generated bridge execution where available, mocked PowerShell/WSL artifact behavior, and the `WSLENV` contract. Therefore the installed-app Windows-server-to-WSL transport remains an unverified cross-boundary smoke test.
- Repository-wide baseline suites contain the unrelated failures listed above. They are outside the fixed-point diff and this ticket's allowed scope; ticket-affected verification is green.
- Authority is intentionally process-local and runtime-lifetime only. Audit-history persistence and high-risk-operation confirmations remain deferred to their dedicated work.
