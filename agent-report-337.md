# Issue #337 implementation report

## Scope and fixed point

- Issue: `horang-labs/tessera#337`, child of `#328`.
- Fixed review point: `3136d80c8831bda7783a1c7c5ee9ac4b84eb1227`.
- Implementation commits:
  - `3d043bb` — `feat: complete Project View workspace state migration`
  - `bf0d072` — `fix(project-view): complete review migration guardrails (#337)`
  - `1d57f2b` — `fix(project-view): resolve final contract review (#337)`
  - `cbcafea` — `fix(project-view): close final running guardrails (#337)`
- This report is committed separately after the code commits above.

No existing work was reset or discarded during recovery. The worktree, commits, uncommitted review fixes, `.next/dev/logs/next-development.log`, saved failure screenshots, listener state, and relevant processes were inspected before further edits.

## Delivered contract

- Project View UI consumers resolve Sessions, Project appearances, origin-only global representations, mutations, navigation, and open-surface lifetime through `projectViewWorkspaceState` and its reactive hooks.
- Direct, retained, and Task-summary representations resolve through shared stored/canonical resolution rather than store-specific lookup copies.
- Selected-project and All Projects Recent Work consume the Project View/origin representation respectively.
- Selected-project Kanban renders a Session owned by a visible Worktree Task only through that Task card, not again as an independent Chat card.
- The expand-ticket `SessionState.getMaterializedSession` compatibility API and all callers were removed. Tab restoration/opening now resolves through the workspace contract with an explicit Project View where available.
- UI lint guardrails reject legacy Session lookup, retained-store reads, direct `project.sessions` reconstruction, and the known Kanban/origin representation builders.
- UI code cannot read the Session store's Project backing array directly; reactive and imperative callers use workspace-boundary Project access, making the guardrail independent of local variable names.
- Project Strip Running badges use the origin representation and therefore include direct, retained, and Task-only canonical Sessions once.
- GUI/PT​Y status aggregation shares one Session-kind partition hook. Projected Session memoization uses nested Project View/Collection maps rather than an encoded string tuple.
- The React workspace adapter opts out of compiler memoization because its subscribed Zustand stores are followed by imperative workspace-boundary reads. Without this directive the React Compiler could cache a summary-only linked Session lookup by explicit IDs and leave the Kanban empty.

## TDD seams

The accepted seams were the public stateful Project View workspace contract plus the two browser-visible flows, not private helper/source strings.

- Stateful A/C matrix covers canonical resolution, unread/read acknowledgement, Collection placement, workflow and promotion, runtime, archive/restore/delete, inactive tab snapshots, retained lifetime, cross-window mutation, origin/global Running, Recent Work, navigation, and Project-local DnD.
- Render/state regression tests assert that linked Sessions appear once in Kanban and remain navigable through their Worktree representation.
- Browser flows assert visible yellow unread consistency and linked-Session Kanban navigation in Peek and tab modes, including the owning Worktree Git target.
- Newly added or modified tests assert public state, rendered markup, accessible/test IDs, API responses, and browser-visible results. Removed source-regex assertions were not replaced with implementation-string assertions.

## Recovered browser failure diagnosis

The interrupted sequential run was not treated as a flake.

1. PID/listener inspection found no stale test server or listener on the candidate isolated ports. Cleanup remained PID/process-group-specific; no bare `pkill -f` was used.
2. The prior Next log showed the isolated server ready on port `34146`, followed by repeated WebSocket authentication rejection for more than two minutes. Recovered `failure.png` images showed an empty Kanban and an unread event that never reached the page.
3. Fresh reproduction on port `35437` failed after the 120-second card wait with `ws-upgrade unauthorized`. Both E2Es were corrected to seed a browser user, install the real JWT browser cookie through `tests/helpers/dev-server.mjs`, and strip inherited Tessera/project/worktree environment variables from the child server.
4. With real authentication, the linked test still intermittently had a correct `/api/tasks` payload but an empty board. Temporary observation changed timing and made it pass. The stable cause was `reactCompiler: true` caching the workspace adapter's imperative store read by explicit Session/View IDs. Adding `'use no memo'` to the adapter was the smallest correct production fix; temporary diagnostics were removed.
5. The authenticated green reproduction passed on port `35442` in 20.5 seconds. The later final sequential run and post-review run both passed.

## Review rounds

### Round 1 (recovered from the interrupted runtime)

Standards found duplicated canonical stored-Session resolution. Spec found global Kanban rebuilding backing stores, an overly narrow guardrail, and modified tests that asserted source/private implementation strings.

Resolutions in `bf0d072`:

- Shared stored resolution moved to `src/lib/projects/stored-session-resolution.ts` and is consumed by both the session store and workspace boundary.
- Kanban consumes Project View/origin representations.
- UI import/syntax guardrails were expanded.
- Stale source-regex assertions were removed without replacement by new source regexes.
- Browser authentication and the React Compiler stale-read fix were included after diagnosing the recovered E2E failure.

### Round 2 (`$code-review` against `3136d80`)

Standards reviewers reported:

- Actionable: duplicated GUI/PT​Y Session-kind partitioning.
- Actionable: a magic-delimited `(projectViewId, collectionId)` cache key.
- Judgment only: the 64-file migration breadth. This is inherent in moving the remaining consumers required by #337; the new boundary reduces future coupling, so no unrelated redesign was undertaken.

Spec reviewers reported:

- Linked Sessions could render as both a Worktree Task card and Chat card in selected-project Kanban.
- Selected-project Recent Work still used raw Project/Task backing state.
- Guardrails still allowed direct `project.sessions` reconstruction.
- `SessionState.getMaterializedSession` remained as a public compatibility resolver with tab-store callers.

Resolutions in `1d57f2b`:

- Added the shared `useSessionKindGroups` partition hook.
- Replaced the encoded cache tuple with nested maps.
- Excluded visible Task child IDs from independent Kanban Chat projection and added render plus browser negative assertions.
- Routed both Recent Work scopes through shared representations.
- Migrated the remaining direct UI scans and strengthened lint guardrails.
- Removed `getMaterializedSession` and migrated tab callers to the workspace resolver.

The first post-resolution follow-up found Project Strip still counting only direct Project Sessions, selected-project Recent Work needing explicit regression coverage, and a variable-name-dependent guardrail. It also questioned three inherited source-contract suites; fixed-point comparison established that #337 only deletes stale assertions from those files and adds no replacement implementation-string assertions, so rewriting 390 lines of unrelated pre-existing contract tests was correctly classified as outside this ticket.

Resolutions in `cbcafea`:

- Project Strip consumes canonical origin Running counts and the state matrix proves direct + retained + Task-only Running count as three.
- Selected-project Recent Work uses a representation-specific public builder, with retained live title/runtime assertions at the workspace seam.
- All UI/hook direct `useSessionStore(...projects...)` and imperative Project-array reads moved behind the workspace boundary. An identifier-independent lint probe using `candidate.sessions` is rejected at the backing-store read.

Final parallel follow-up found **0 remaining Standards findings** and **0 remaining actionable Spec findings**.

## Verification

### Focused A/C state matrix

```sh
npx tsx --test tests/active-workspace-session.test.ts tests/project-view-workspace-state.test.ts tests/project-view-workspace-state-activation.test.ts tests/project-view-task-mutation.test.ts tests/project-view-collection-placement.test.ts tests/project-view-session-lifetime.test.ts tests/project-view-cross-window-mutation.test.ts tests/project-view-dnd.test.ts tests/adaptive-linked-worktree-navigation.test.tsx tests/project-view-open-session.test.ts tests/project-view-tab-state.test.ts tests/project-view-unread-selector.test.tsx tests/recent-work-sort.test.ts tests/origin-project-representation.test.ts tests/kanban-board-scope.test.ts tests/kanban-project-projection-render.test.tsx tests/task-session-archive.test.ts tests/session-archive-client.test.ts tests/terminal-session-runtime-state.test.ts tests/project-view-session-scope.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-membership-migration.test.ts
```

Result: **137/137 passed**, 0 failed, measured final test duration `2437.973123 ms` after all review fixes.

### Source/contract set

```sh
node --test tests/board-popout-live-sync-contract.test.mjs tests/kanban-collection-menu-contract.test.mjs tests/kanban-cross-project-dnd-feedback-contract.test.mjs tests/kanban-session-peek-contract.test.mjs tests/session-activation-focus-contract.test.mjs tests/tab-panel-persistence-contract.test.mjs tests/unread-notification-priority-contract.test.mjs tests/board-state-persistence-contract.test.mjs
```

Result: **38/38 passed**, 0 failed, measured final test duration `72.367951 ms`.

### Final isolated browser acceptance

Preflight and cleanup checks:

```sh
ss -ltnp 'sport = :35451'
ss -ltnp 'sport = :35452'
ps -eo pid,ppid,etimes,args | rg '(^ *PID|tsx server\.ts|next-server|project-view-unread-consistency|linked-session-materialization)'
```

Both ports were free before their runs. Afterward ports `35450`, `35451`, and `35452` were closed and no test/Next server process from this worktree remained. An unrelated development server in sibling worktree `feature/0812-t345` was observed and deliberately left untouched.

```sh
TESSERA_E2E_PORT=35451 TESSERA_EVIDENCE_DIR="$PWD/.tmp/issue-337-evidence/final-guardrail-linked" node tests/linked-session-materialization.e2e.mjs
TESSERA_E2E_PORT=35452 TESSERA_EVIDENCE_DIR="$PWD/.tmp/issue-337-evidence/final-guardrail-unread-exit0" node tests/project-view-unread-consistency.e2e.mjs
```

Result: both passed with explicit `LINKED_EXIT=0` and `UNREAD_EXIT=0`. Each test created and removed its own temporary data/project directories.

Screenshots inspected at original resolution:

- `.tmp/issue-337-evidence/final-guardrail-unread-exit0/unread-tab-sidebar-consistency.png` (`77,422` bytes): inactive tab and both Recent Work/sidebar rows show the same yellow unread status; the unread notification/toast is present.
- `.tmp/issue-337-evidence/final-guardrail-linked/linked-session-peek.png` (`58,584` bytes): summary-only linked Session is open in Peek and Git targets the owning Worktree.
- `.tmp/issue-337-evidence/final-guardrail-linked/linked-session-tab.png` (`61,559` bytes): one Doing Worktree card is visible, no duplicate Chat card exists, the linked Session is open in a tab, and Git targets the owning Worktree.

### Static and graph checks

```sh
npx tsc --noEmit --pretty false
npm run lint
git diff --check
graphify update .
```

Results:

- TypeScript: exit 0.
- ESLint: exit 0, 0 errors, 3 pre-existing warnings (`preview-markdown.tsx` `<img>`, TanStack Virtual compiler incompatibility, and an unused disable in `spawn-cli-runtime.ts`).
- `git diff --check`: no whitespace errors.
- `graphify update .`: exit 0. The final update reported no code-graph topology changes and left generated outputs untouched. An earlier update measured 10,940 nodes, 28,764 edges, and 442 communities, with the existing label-drift warning (423 saved labels versus 442 current; 167 renamed by hub).

## Not verified and deliberate exclusions

- The full repository suite was deliberately not run in this child worktree, per the orchestrator instruction; it remains for post-integration verification.
- Electron/Windows/WSL packaged-app testing was not run. The changed regressions are browser client-state/projection behavior and do not cross a process, filesystem, OS, or native Electron boundary; the parent testing decision explicitly permits isolated web-server acceptance here.
- No GitHub issue, PR, label, branch, or remote state was mutated. Nothing was pushed and no PR was opened.
- Three inherited source-contract suites remain source-based legacy tests, but #337 only removes their stale private assertions; it introduces no new implementation-string assertion. New and changed regression coverage for this issue is state/render/browser based.
- No visual redesign, database/schema change, store-framework replacement, recursive Worktree hierarchy, or unrelated notification/files/Git behavior was included.
