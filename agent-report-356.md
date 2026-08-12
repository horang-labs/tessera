# Agent report — GitHub issue #356

## Outcome

Implemented issue #356 on `feature/0812-t356`.

The packaged Windows-to-WSL acceptance runner no longer treats all of real
`~/.codex/config.toml` as byte-static. It now captures named, hash-only integrity
evidence at the user-preservation boundaries and permits changes only to the quoted
values of `last_updated` and `last_revision` directly inside Codex marketplace
tables. Every other byte of the config remains protected, including comments,
formatting, ordering, hooks, and unrelated settings.

The same evidence set fails closed for:

- the source `tessera-dev.db` and `tessera.db` files and each database's WAL, SHM,
  and rollback-journal sidecars;
- Codex, Claude, and OpenCode credentials;
- Codex and Claude user hook/configuration files;
- native Windows and real WSL `tessera-cli` provider skill trees; and
- the integrity snapshot itself.

Failures name each changed invariant. Verification now runs after the owned
packaged session completes shutdown and `-RemoveData` cleanup, so shutdown-time
mutations are covered.

## Skill invocation and TDD seams

`$implement` was invoked with GitHub issue #356 as the supplied ticket. Its loop was:
read the issue and required cross-boundary notes, characterize the current gate,
implement through the pre-agreed `/tdd` seams, run focused/static checks, invoke
`$code-review`, apply every valid finding, re-run checks, and commit locally.

The pre-agreed `/tdd` public seam was the fixture-only
`tests/fixtures/packaged-windows-wsl/integrity-check.py` CLI:

1. **Benign concurrent provider metadata:** snapshot synthetic homes, deterministically
   change marketplace `last_updated` and `last_revision`, then verify green.
2. **Unauthorized protected mutation:** independently mutate a source database and
   sidecars, credential, user hook, protected config content (including comment-only
   content), native skill, and real WSL skill, then require a nonzero result naming
   the changed invariant.

The acceptance-runner composition seam also verifies that protected evidence is
checked after the owned runtime's shutdown cleanup. The runner's actual packaged
execution could not use TDD in this child worktree because the ticket explicitly
forbade building, launching, or stopping Electron; the orchestrator owns that final
topology test.

## Exact verification record

All mutation tests used synthetic files under a unique
`~/.tessera/test-fixtures/unit-<pid>-<timestamp>` root created by `setup.sh` and
deleted by the test hook. No real provider home, app data, or database was mutated.

### Characterization and first TDD cycle

- `gh issue view 356 --repo horang-labs/tessera`
  - Failed before returning the issue because GitHub's Projects-classic field is
    deprecated.
- `gh issue view 356 --repo horang-labs/tessera --json number,title,body,labels,state,url`
  - Passed; issue body and acceptance criteria fetched without the deprecated field.
- `graphify query "config.toml provider hashes acceptance integrity" --budget 4000`
  - Located `source_hashes()` in
    `tests/fixtures/packaged-windows-wsl/run-acceptance.sh` and the adjacent fixture
    test seam. Direct source inspection confirmed one concatenated byte-hash compare
    and the generic `Source data/provider hashes changed` failure.
- `npx tsx --test tests/packaged-windows-wsl-fixture.test.ts` (red)
  - 6 tests: 4 passed, 2 failed, 0 skipped; duration 1267.91 ms.
  - Both new tests failed because `integrity-check.py` did not exist.
- Same targeted command after implementing the classifier (green)
  - 6 tests: 6 passed, 0 failed/skipped; duration 1631.37 ms.
- `bash -n tests/fixtures/packaged-windows-wsl/run-acceptance.sh && python3 tests/fixtures/packaged-windows-wsl/integrity-check.py --help >/dev/null && npx tsx --test tests/packaged-windows-wsl-fixture.test.ts && git diff --check`
  - Passed; targeted result 6/6, duration 1749.49 ms.

### Repository checks before review

- Initial `npx tsc --noEmit`
  - Environment/setup failure: this worktree had no `node_modules`, so `npx`
    selected the unrelated placeholder `tsc` package.
- Initial `npm run lint`
  - Environment/setup failure: global ESLint 6.4.0 ran and could not load the flat
    config.
- `sha256sum package-lock.json /home/work/Source/tessera-dev/package-lock.json package.json /home/work/Source/tessera-dev/package.json`
  - Both manifests matched byte-for-byte. An ignored `node_modules` symlink to that
    existing install was created; pinned tools were TypeScript 5.9.3 and ESLint
    9.39.4. No manifest or lockfile changed.
- `npx tsc --noEmit`
  - Passed with 0 errors in 12.12 s.
- `npm run lint`
  - Passed with 0 errors and 3 pre-existing warnings in unrelated files
    (`preview-markdown.tsx`, `use-virtual-message-list.ts`, and
    `spawn-cli-runtime.ts`) in 28.58 s.
- `graphify update .`
  - Passed; graph rebuilt to 11,354 nodes / 30,152 edges / 460 communities.
- `git diff --check`
  - Passed.

### Review-finding TDD cycle and final checks

- `npx tsx --test tests/packaged-windows-wsl-fixture.test.ts` (red review regressions)
  - 6 tests: 4 passed, 2 failed, 0 skipped; duration 1521.93 ms.
  - The failures demonstrated missing WAL coverage and verification before shutdown.
  - The comment-only config case was in the same protected-class table and was
    exercised after the first failing case was fixed.
- `bash -n tests/fixtures/packaged-windows-wsl/run-acceptance.sh && npx tsx --test tests/packaged-windows-wsl-fixture.test.ts && git diff --check` (green)
  - Passed; targeted result 6/6, 0 failed/skipped; duration 2159.05 ms.
- Final `npx tsc --noEmit`
  - Passed with 0 errors in 3.64 s.
- Final `npm run lint`
  - Passed with 0 errors and the same 3 unrelated pre-existing warnings in 34.52 s.
- `graphify update . && git diff --check && bash -n tests/fixtures/packaged-windows-wsl/run-acceptance.sh && python3 -m py_compile tests/fixtures/packaged-windows-wsl/integrity-check.py`
  - Passed; graph rebuilt to 11,359 nodes / 30,155 edges / 486 communities.
  - The generated `__pycache__` was removed afterward.

Per ticket instruction, the complete suite was not run.

## `$code-review` invocation and findings

Fixed point: `b1b7e50` (`b1b7e50299d441d1e9b68f23ebf98443be496f2d`).

Diff command: `git diff b1b7e50...HEAD`.

Commit list at review time:

```text
219fa04 fix: classify packaged acceptance integrity (#356)
```

The skill's Standards and Spec reviewers ran in parallel as separate read-only
agents, with findings restricted to acceptance gaps and hard documented-standard
violations.

### Standards

0 findings. No hard violation of `AGENTS.md`, `CONTRIBUTING.md`,
`.claude/notes/cross-boundary-testing.md`, or
`.claude/notes/electron-isolated-test.md`; no reportable baseline smell.

### Spec

3 findings:

1. Database evidence omitted SQLite WAL/SHM sidecars.
2. Semantic TOML canonicalization was too permissive because lexical changes such
   as comments or formatting could escape detection.
3. Integrity verification ran before packaged shutdown/cleanup.

All three were valid and applied. The reviewed fix added main/WAL/SHM/journal
evidence, changed normalization to redact only the two quoted marketplace refresh
values while preserving all other bytes, added comment-only protection coverage,
and moved verification after `stop-electron-test-session.ps1 -RemoveData`.

Review summary: Standards 0 findings (worst: none); Spec 3 findings (worst:
database/config mutations could escape the gate). No scope creep was reported.

## Commits

- `219fa04` — initial integrity classifier, deterministic tests, and runner wiring.
- `e43d7e7` — all valid `$code-review` findings fixed and reverified.

The report is committed separately after these implementation hashes so it can
record stable code commit IDs without a self-referential hash.

## Not verified

- No Electron build, launch, stop, CDP session, or Windows packaged acceptance run
  was performed, as explicitly required by the ticket. Therefore this child session
  does not claim packaged Windows Electron → Windows backend → WSL agent runtime
  evidence or end-to-end cleanup completion. The root orchestrator owns that final
  post-integration acceptance.
- The full test suite was not run; the orchestrator owns the post-integration suite.
- Installed Tessera process/port preservation was not re-measured here because doing
  so belongs to the prohibited packaged runtime test. The runner retains its existing
  before/after invariant.

## Deliberately left out

- No product runtime or provider-integration behavior was changed; this ticket only
  changes the acceptance evidence/classification boundary.
- No generalized TOML writer or new production dependency was added. Python 3.11's
  standard `tomllib` validates the file; the classifier redacts only the two known
  provider refresh value tokens.
- No provider homes, installed-app data, source database, user hook, or real skill
  was modified.
- No Electron artifact was built or copied, no process was killed, no GitHub state
  was changed, and nothing was pushed or opened as a PR.
