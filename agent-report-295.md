# Agent report — GitHub issue #295

## Outcome

Implemented issue #295 from fixed point
`ba3532ea377631ffda86b6d4270001a93ae24ca9` and completed the interrupted
implementation using source-only verification. Canonical Worktree routing now
reconciles equivalent Windows-hosted WSL and agent-reported paths, routes
sessionless Git/Files through host-openable checkout paths, threads the configured
agent environment into session workspace readers, and derives managed Worktree
fallbacks only from the CLI's probed WSL `$HOME`.

Implementation commits:

- `79c0124c2ffa40f55ab23ad8b5b35cd9520260e7` — route bridged Worktree identities and readers
- `500d00fc4821acdb8ad74afcebf093d86603857a` — fix review findings in identity reconciliation and WSL-home discovery
- `9fea4892cde9ba13a5bf987ad24d948995a1079a` — constrain reconciliation authorization and remove all WSL-home guessing
- `51012519aa0616d60e67d60ac7c9eaec859171a6` — reject incomplete WSL `$HOME` probe output

Nothing was pushed or merged; no PR was opened and issue #295 was not changed.

## Acceptance mapping

| # | Acceptance criterion | Result and evidence |
|---|---|---|
| 1 | Windows and WSL spellings resolve to one Worktree | Implemented by `canonicalizeWorktreePath()` reference-path matching and canonical registry reconciliation. The focused test asserts identical UNC/WSL identity keys. |
| 2 | Importing linked C reuses identity and canonical Sessions | Project registration supplies equivalent agent/host paths and merges duplicate registry references without copying Sessions. The new bridged import test and the completed #289 projection tests passed. |
| 3 | Project, standalone, and one-Session composite route Git/Files | Worktree API, Git panel, Project/task projections, and session workspace readers route canonical paths. Non-Electron Worktree Git/Files and adaptive 0/1/many target tests passed. Packaged evidence completed Project Worktree Git/Files only; linked standalone/composite UI completion remains a risk. |
| 4 | Translate CLI-reported and agent-home paths before access/comparison | Creation persists host-openable paths only after agent-side Git completes; session/memory/watch readers receive `agentEnvironment`; managed-root fallback calls `resolveAgentHomeFilesystemPath()`. |
| 5 | Do not derive agent-side locations from Windows home/env | WSL home is accepted only from `$HOME` probed inside WSL (default distro, or one unambiguous named distro). Windows `USERNAME`, `USERPROFILE`, `homedir()`, UNC directory enumeration, and `/home/*` guessing are not used. |
| 6 | Native Windows/macOS/Linux remain unchanged | Native path translation remains a no-op; native managed-root and path-policy regression tests passed. |
| 7 | Isolated packaged Windows + WSL verification | **Partial.** Prior isolated packaged testing used a Windows server and WSL Git fixture, but the parent-app safety incident prohibited a complete final rerun. |
| 8 | Acceptance run covers Project, imported linked, adaptive navigation, Git, Files | **Partial.** Project Worktree Git/Files completed and was screenshotted; the harness then timed out at a linked Worktree row. Imported identity was observed earlier, but final standalone/composite navigation did not complete. |
| 9 | Evidence attributes filesystem/Git operations to processes | **Partial.** The harness observed `serverHostInfo.platform === "win32"`, WSL fixture paths, and packaged API results, but did not instrument every Git/filesystem operation with process-level attribution. |

## Design contracts read

- `AGENTS.md`, `CONTRIBUTING.md`, and `.claude/notes/cross-boundary-testing.md`
- sibling completed-ticket ADRs `../0809-t294/docs/adr/0001` through `0005`
- sibling reports `../0809-t289/agent-report-289.md`,
  `../0809-t291/agent-report-291.md`, and `../0809-t294/agent-report-294.md`

The implementation preserves Projects as Worktree-rooted views, canonical
Session/Worktree state, immutable branch-based Creation Scope, separate
Session/Worktree lifecycles, and first-class sessionless Worktree Git/Files
targets. Schema v37 adds a narrow reconciliation authorization record: only the
canonical merge transaction may retarget an identical Worktree ID, and an
unrelated orphan-ID reparent remains rejected by the immutable-scope trigger.

## Verification commands and results

All commands below ran in this worktree without starting a server, browser,
Electron, or E2E harness.

- `gh issue view 295 --comments --json number,title,body,labels,comments,state,url`
  — exit 0; issue and acceptance criteria read.
- `git rev-parse ba3532ea377631ffda86b6d4270001a93ae24ca9` and
  `git diff ba3532ea377631ffda86b6d4270001a93ae24ca9...HEAD`
  — fixed point resolved and the review diff was non-empty.
- `npx tsx --test tests/worktree-bridged-routing.test.ts tests/agent-environment-paths.test.ts tests/project-worktree-root.test.ts tests/workspace-file-watch-manager.test.ts tests/memory-routes.test.ts tests/git-panel*.test.ts`
  — 39 passed, 0 failed.
- `npx tsx --test tests/linked-worktree-independent-project.test.ts tests/project-view-worktree-scope.test.ts tests/project-view-session-scope.test.ts tests/project-view-open-session.test.ts tests/task-session-kind.test.ts tests/adaptive-linked-worktree-navigation.test.tsx`
  — 18 passed, 0 failed.
- `npx tsx --test tests/worktree-path-template.test.ts tests/worktree-path-template-server.test.ts tests/worktree-path-policy.test.ts`
  — 6 passed, 0 failed.
- Final affected set:
  `npx tsx --test tests/worktree-bridged-routing.test.ts tests/agent-environment-paths.test.ts tests/worktree-creation-scope-migration.test.ts tests/worktree-identity-migration.test.ts tests/project-view-worktree-scope.test.ts tests/project-worktree-root.test.ts`
  — 23 passed, 0 failed.
- After the final empty-`$HOME` review fix:
  `npx tsx --test tests/agent-environment-paths.test.ts tests/worktree-bridged-routing.test.ts`
  — 16 passed, 0 failed.
- `npx tsc --noEmit` — exit 0 with no diagnostics, before and after review fixes.
- `npm run lint` — exit 0 with 0 errors and 3 pre-existing warnings outside this
  ticket (`preview-markdown.tsx`, `use-virtual-message-list.ts`,
  `spawn-cli-runtime.ts`).
- `git diff --check` and staged `git diff --cached --check` — passed.
- `graphify query "worktree identity path environment canonical filesystem routing git panel" --budget 2600`
  — oriented the change around Worktree identity, path environment, database,
  Git panel, session workspace, and Worktree API nodes.
- Final `graphify update .` — exit 0; rebuilt the ignored graph to 10,155 nodes,
  26,806 edges, and 394 communities.

One attempted combined regression command also included
`tests/control-worktree-creation.test.ts` and `tests/preparation-claim-timing.test.ts`.
Its visible assertions passed, but the combined Node process retained an open
handle after cleanup and was interrupted with exit 130; it is not counted as a
passing command above. The relevant Project/adaptive/path subsets were rerun in
terminating commands. No omnibus suite was run because this closeout explicitly
prohibited every E2E/server/Electron path.

## Two-axis code review

`$code-review` ran independent read-only Standards and Spec agents against
`git diff ba3532ea377631ffda86b6d4270001a93ae24ca9...HEAD`.

Initial findings:

- Standards: packaged cross-boundary proof was incomplete; possible Feature
  Envy in the canonical Worktree repository's cross-table reconciliation.
- Spec: duplicate reconciliation could trip the immutable Creation Scope
  trigger; WSL-home fallback could infer from Windows identity; packaged
  acceptance evidence was incomplete.

Disposition and fixes:

- Accepted the duplicate-scope finding. Schema v37 and the canonical merge now
  preserve branch scope while authorizing only the proven duplicate-ID rewrite;
  tests cover both the valid merge and rejection of unrelated orphan reparenting.
- Accepted the WSL-home finding. Discovery now uses the CLI-side `$HOME` probe
  and fails closed rather than guessing from Windows identity or directory shape.
- Rejected the Feature Envy judgment: the canonical Worktree repository owns an
  atomic identity merge across references; introducing a service would move,
  not reduce, that knowledge and add speculative abstraction.
- Accepted the evidence finding as a remaining verification risk. It cannot be
  closed without the Electron activity explicitly prohibited by the user.

The first material-fix rerun correctly caught that the initial trigger exception
and sole-home fallback were still too broad. Commit `9fea489` replaced them with
explicit transaction authorization and probe-only home discovery. A later
Standards rerun found that empty probe output could still synthesize `/`; commit
`5101251` made missing distro or `$HOME` fail closed.

Final review:

- **Standards:** 0 documented-standard violations. One rejected judgment call
  remains: possible Feature Envy in `worktrees.ts`. The transaction is cohesive
  canonical-identity behavior today; extraction is deferred unless it grows.
- **Spec:** 0 missing/partial implementation requirements, 0 incorrect
  implementations, and 0 scope creep for criteria 1–6.
- **Evidence:** both axes separately retain the prohibited packaged-verification
  gap for criteria 7–9; it is documented below and was not converted into a
  false success claim.

Final count: Standards 0 hard findings and 1 rejected judgment finding; Spec 0
implementation findings. The worst Standards concern is future cross-aggregate
growth; the Spec axis has no code concern and retains only the packaged evidence
risk.

## Prior packaged evidence and safety limits

The prior implementation session used an isolated packaged Windows server with a
WSL CLI/Git fixture. That work found and fixed two real boundary defects:

1. Worktree creation converted the agent-side path too early, before Git ran in
   WSL. The final code keeps the agent spelling through Git and converts only
   before persistence/host-side reads.
2. A host-openable UNC path could be converted a second time. The final resolver
   treats WSL UNC and Windows drive paths idempotently.

The final post-fix packaged run reached the sessionless Project Worktree Git and
Files panels and produced `project-worktree-git-files.png` (SHA-256
`06fa50717f677e059cfd4e3a831f2ae8c91d3396cea4242bd45b4b1e464527c4`).
It showed the WSL fixture's branch/path and files, including `README.md` and
`bridge-dirty.txt`. The harness then timed out locating/clicking a linked
Worktree row. It did **not** complete the standalone and one-Session composite
navigation sequence, so this is not a full final E2E success. Another static
linked-row screenshot (SHA-256
`c0ebcb8e4f3cfac8bf888f818893f640e7e1807516128a05dc1703ff6a3d2b33`)
showed an incomplete zero-files state and is not completion evidence.

During child Electron testing, the user's already-running parent Electron became
unresponsive. Before this closeout began, root reported that exact isolated test
session `codex-t295-0810-0020` had been stopped/removed, ports 9445 and 32395 were
gone, and only the user's existing 32123 listener remained. This closeout did not
recheck or interact with those processes/ports because the user prohibited it.
No Electron instance, build, server, E2E, Windows process, port, installed app,
or production data was touched here.

The remaining risk is packaged Windows-server verification of imported linked,
standalone, and one-Session composite UI routing plus per-operation process
attribution. Further Electron verification was prohibited after the safety
incident, so the risk is explicitly carried rather than hidden.

## Cleanup state

After recording hashes and static observations, the untracked
`tests/worktree-bridged-routing.e2e.cjs` harness was removed. The three ignored
files under `artifacts/issue-295/` (`initial-renderer.png`,
`project-worktree-git-files.png`, and `standalone-linked-files.png`) were moved to
the desktop trash and the empty directory removed; the screenshots are therefore
recoverable. Existing ignored `.electron-runtime/` and `dist-electron/` directories
were left untouched because this closeout did not establish that they belonged
only to issue #295. No external fixture, process, port, or data cleanup was run.
