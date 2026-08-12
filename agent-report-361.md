# Agent report — GitHub issue 361

## What changed and why

Pending Codex GUI Sessions can be created through the control/API seam with explicit `model`,
`reasoningEffort`, and `serviceTier`. The normal composer still sends renderer defaults in the
first `send_message`. Before this change, those request values outranked the stored creator
choices in `resumeSessionWithLifecycle`, so the first provider launch and the stored Session were
rewritten to the UI defaults.

The implementation now:

- declares, through the `CliProvider` interface, that Codex gives stored creator options priority
  on a fresh Session launch;
- merges each fresh launch field independently, using the composer value only when the stored
  Session omitted that field;
- persists the resolved successful launch configuration without changing the Session timestamp;
- reports the resolved service tier returned from the same configuration passed to the provider
  launch request.

This does not change established precedence after provider history exists. It also does not alter
Codex provider-home selection or origin-home binding from ADR-0006/ADR-0013.

## Skill invocation and TDD seams

`$implement` was invoked with GitHub issue 361 as the ticket. Its loop was followed as:
issue/design reading, graph-assisted code orientation, focused TDD, implementation, targeted
verification, `$code-review`, finding fixes, re-verification, and commits.

`$tdd` ran at the agreed pending-session option-precedence seam. The durable test now exercises:

1. `createSessionFromWebSocket` as the control/API pending GUI Session creation boundary;
2. `sendSessionMessageFromWebSocket` with the normal composer-style default `spawnConfig`;
3. the provider process-manager launch-request boundary;
4. the emitted `session_started` configuration; and
5. the persisted Session record.

The provider process manager is replaced only at the external process boundary; database,
control creation, first-send routing, lifecycle option resolution, and persistence are real.

TDD measurements:

- Initial command: `npx tsx --test tests/pending-session-option-precedence.test.ts`
  - first infrastructure attempt stopped before assertions because this child worktree had no
    `node_modules` (`Cannot find module 'pino'`);
  - `npm ci` installed 1,042 packages from `package-lock.json` successfully;
  - after loading the normal provider bootstrap, the true red was measured: expected
    `gpt-5.6-sol / high / fast`, actual launch request
    `gpt-5.3-codex-spark / low / default` (0 passed, 1 failed).
- First green: the same command passed 1/1 after persisted values gained fresh-launch priority.
- Second red: a partially specified Session launched with the right fallback values, but its
  stored `reasoning_effort` and `service_tier` remained `null` instead of `low / default`
  (1 passed, 1 failed).
- Second green: successful launch persistence made both tests pass 2/2.
- Review refinement then moved the test through the full control-create and WebSocket first-send
  seams; the focused file still passed 2/2.

## Exact verification commands and results

No full test suite was run, per the ticket constraint.

Final targeted command:

```text
npx tsx --test tests/pending-session-option-precedence.test.ts tests/session-persistence-wiring-contract.test.mjs tests/codex-fast-service-tier.test.ts tests/control-session-database.test.ts
```

Result: 13 tests passed, 0 failed, 0 skipped, duration 2.984 seconds. This covered explicit and
partial pending options, fast-tier resolution helpers, API/database persistence wiring, and the
existing control Session database adapter.

```text
npx tsc --noEmit
```

Result: exit 0, no diagnostics.

```text
npm run lint
```

Result: exit 0, 0 errors and 3 pre-existing unrelated warnings:

- `src/components/chat/preview-markdown.tsx`: `@next/next/no-img-element`;
- `src/hooks/use-virtual-message-list.ts`: React Compiler incompatible-library warning for
  TanStack Virtual;
- `src/lib/cli/spawn-cli-runtime.ts`: unused `no-control-regex` disable directive.

```text
graphify update .
```

Result after the final code/test changes: exit 0; graph rebuilt to 11,466 nodes, 30,295 edges,
and 469 communities. Graphify warned that `provider-skill-ids.json` produces zero AST nodes and
that community labels can be refreshed; neither affects this implementation.

`git diff --check` also passed before both implementation commits.

## Code review invocation and findings

`$code-review` was invoked exactly as a two-axis parallel review with:

- fixed point: `282a2d1` (`282a2d1432c6f663905a077aa8f99b263283bfa6`);
- diff command: `git diff 282a2d1...HEAD`;
- reviewed initial commit: `66a6c7c fix: preserve pending Codex launch options (#361)`;
- spec sources: issue 361, ADR-0006, ADR-0013, and the ticket verification constraints;
- standards sources: `AGENTS.md`, `CONTRIBUTING.md`, and `docs/agents/domain.md` plus the
  skill's smell baseline.

## Standards

The Standards reviewer reported one hard violation: the initial implementation selected the new
Codex policy with `providerId === 'codex'` inside the generic Session orchestrator, conflicting
with `CONTRIBUTING.md`'s rule to keep provider-specific behavior behind CLI provider interfaces.
It also noted duplicated setup in the two tests as a judgement-call smell, not an actionable hard
violation. It found no ADR-0006 or ADR-0013 conflict.

Disposition: applied. `CliProvider.prefersPersistedLaunchOptionsForFreshSession()` now owns the
provider policy, Codex opts in from its adapter, and shared orchestration consumes the capability.
The review-driven integration helper also removed the duplicated test setup.

## Spec

The Spec reviewer reported that the initial test bypassed the API/control creation and
WebSocket/composer first-send route, and that it did not observe a real Codex app-server
`thread/start`/`turn/start` in an authoritative provider home.

Disposition: the focused integration gap was applied. The durable tests now create through
`createSessionFromWebSocket`, start through `sendSessionMessageFromWebSocket`, assert the provider
launch request, assert first-message delivery, and compare `session_started` plus the DB record.
The real app-server/provider-home portion could not be applied in this child worktree because the
ticket explicitly forbids launching or mutating a live Electron instance or real provider home;
that remains final orchestrator QA.

Review summary: Standards had 1 hard finding (provider policy placement), fixed. Spec had 2
coverage findings; the focused integration finding was fixed, while packaged real-provider
verification remains deliberately assigned to the root orchestrator.

## What could not be verified

- Packaged Windows Electron with a Windows Tessera backend and WSL Codex CLI was not launched or
  mutated.
- A real authoritative Codex home and real app-server `thread/start`/first `turn/start` payload
  were not exercised. The focused test environment logged that native Windows Codex-home
  resolution was unavailable and therefore used the supplied options; the test proves the
  deterministic request/persistence contract, not packaged cross-boundary execution.
- The full test suite was not run. The integration orchestrator is expected to run it after merge.

## Commits

- `66a6c7c` — `fix: preserve pending Codex launch options (#361)`
- `7edd1f0` — `test: cover control-created Codex first send (#361)`

The final implementation HEAD before this report commit is `7edd1f0`.

## Deliberately left out

- No Electron build, launch, stop, or mutation of an existing isolated QA instance.
- No real provider-home files, Codex authentication/configuration, or app-server process changes.
- No full-suite run, push, PR, GitHub issue mutation, or unrelated lint-warning cleanup.
- No changes to legacy Codex overlay compatibility, real-home cutover policy, origin-home binding,
  other providers' fresh-session precedence, or post-history resume behavior.
