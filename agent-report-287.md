# Issue 287 implementation report

## Outcome

Implemented branch-scoped direct Sessions for Project Worktree views. A newly created direct
Session now persists the canonical `worktree_id` and immutable `scope_branch` captured from the
live Worktree branch. Project reads go through one projection boundary that shows the matching
branch, always shows legacy null-scope rows, and leaves task-owned Session behavior unchanged.

Normal Worktree Git refreshes update the live branch and reload the Project projection. A scoped
Session that disappears from the sidebar remains addressable and mutable while its panel is open,
so its existing composer remains usable. The header describes `Scope` separately from `Current`
branch and explicitly calls it presentation scope, not an execution lock.

Because one canonical Worktree can be reached through more than one saved Project, pagination now
uses an opaque compound cursor over `(sort_order, originating project_id, session_id)`. This avoids
skipping equal project-local sort orders. The grouped Project response supplies both global and
per-status cursors rather than asking the client to reconstruct a numeric cursor.

Database schema version 35 adds nullable `sessions.worktree_id` and `sessions.scope_branch` plus
an index. Existing rows intentionally remain null-scope and therefore legacy-visible.

## Skill and TDD invocation

The provider implementation workflow was invoked as `$implement` with GitHub issue 287 as the
ticket. Its implementation phase routed the persistence/projection and presentation seams through
`/tdd`:

- Projection red: `npx tsx --test tests/project-view-session-scope.test.ts` initially failed
  because `project-view-projection` did not exist; it passed after the DB/persistence/projection
  implementation.
- Presentation red: `npx tsx --test tests/session-branch-presentation.test.ts` initially failed
  because the branch-presentation resolver did not exist; it passed after the header resolver and
  labels were added.
- Open-panel review red: `npx tsx --test tests/project-view-open-session.test.ts` reproduced a
  stale retained Session after a title mutation; it passed after retained Session mutations were
  routed through shared update helpers.
- Pagination review red: `npx tsx --test tests/project-view-session-scope.test.ts` reproduced a
  missing second page (`0 !== 1`) when two Project-local rows both had `sort_order = 0`; it passed
  after compound cursors were implemented for global and status queries.
- Migration coverage uses a real temporary v34 SQLite database. Projection coverage uses a real
  temporary Git repository and Tessera database.

## Verification

Commands and measured results:

```text
gh issue view 287 --repo horang-labs/tessera
```

Issue body and all acceptance criteria were read before implementation. ADRs 0001 through 0005
were read from `docs/adr/` before code changes.

```text
npx tsx --test tests/project-view-open-session.test.ts tests/project-view-session-scope.test.ts tests/session-branch-presentation.test.ts tests/session-scope-migration.test.ts tests/project-worktree-root.test.ts tests/project-worktree-target.test.tsx tests/session-persistence-wiring-contract.test.mjs tests/git-action-session-refresh.test.ts
```

Result: 26 tests passed, 0 failed, in 4.842 seconds.

```text
npx tsc --noEmit
```

Result: exit 0, no diagnostics.

```text
npm run lint
```

Result: exit 0, 0 errors and 3 pre-existing warnings in `preview-markdown.tsx`,
`use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`; none are in issue 287 changes.

```text
git diff --check
```

Result: exit 0, no whitespace errors.

```text
/home/work/.local/bin/graphify update .
```

Result: exit 0; 1,193 code files re-extracted and the 9,934-node graph rebuilt.

## Browser runtime characterization

`.claude/notes/dev-server.md` was read and `env | grep -i tessera` was checked first. The server
was started on port 31287 with inherited app/production Electron variables removed,
`TESSERA_ELECTRON_AUTH_BYPASS=1`, and isolated data at
`/home/work/tmp/tessera-287-runtime.aZjrfL/data`. The test repository was a separate temporary real
Git repository.

The persistent isolated browser session was opened with the required session options:

```text
playwright-cli -s=t287 --persistent open http://localhost:31287
```

Observed result:

1. On `main`, the direct Session appeared and the header showed `Scope: main` and `Current: main`.
2. After an external checkout to `feature/external-switch` and the normal root Git refresh, the
   sidebar hid that Session while its already-open panel remained mounted.
3. The header changed to `Scope: main` and `Current: feature/external-switch`. A draft could be
   entered and `message-send-btn` measured `disabled=false`.
4. After checking out `main` and refreshing again, the same Session returned to the sidebar with
   the same title and draft.

Screenshot: `/home/work/tmp/issue-287-branch-scope.png`. The named browser session was closed and
the server was stopped with its own terminal control; no broad process kill was used.

## Runtime-specific code review

The required review was invoked exactly through `$code-review` against fixed point
`3362a2659294fd264946b7d6364b7df808ac70f5`. The skill launched its two authorized parallel,
read-only review agents:

- Spec: no findings; all eight acceptance criteria were accounted for and the reviewer found no
  scope creep.
- Standards: two hard findings. First, the retained copy of an open projected-out Session could
  become stale because mutation paths only updated `projects`. Second, Project projection could
  combine rows from multiple originating Projects while numeric `sort_order` pagination could
  skip ties.

Both findings were accepted and fixed. Regression tests now exercise hidden Session title/runtime/
unread/diff mutations and equal-sort-order pagination through both global and status-group reads.

## Not verified or deliberately left out

- The full suite was not run, as explicitly prohibited for this child worktree. Targeted coverage
  was used instead.
- The provider send action was not submitted because doing so would spawn a real external CLI;
  sendability was verified through the mounted composer, retained Session state, draft entry, and
  enabled send button.
- No isolated Windows Electron run was performed. This implementation does not cross a process,
  OS, filesystem, or network boundary; the reported behavior was exercised in the web topology.
- The isolated web fixture logged unavailable Codex app-server/skill reference calls because it
  had no provider runtime configured. These did not affect projection or composer evidence.
- Task-owned Session branch behavior, Worktree lifecycle mutation/deletion, backfilling legacy
  rows, execution locking, pushing, and opening a PR were deliberately excluded from this ticket.

## Commit

Implementation commit: `836a6e96bc7bee060426a1702a06e07d2f79a77f`
