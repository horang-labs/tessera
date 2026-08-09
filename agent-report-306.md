# Issue 306 implementation report

## Scope and outcome

Implemented `horang-labs/tessera#306` from fixed point
`5c00c0f3c054ae38de9e91a659fdc6b94cb39304`, the completed blocker branch
`feature/0809-t300`. Commits at or before that fixed point were not rewritten or modified.

The final source commit is `38c77f98c1f9185aabf37baa4d1052b97f7ac2fa`
(`feat: preserve mobile lifecycle on quit (#306)`).

The desktop lifecycle now treats a completed Mobile Connection as its own quit risk rather
than inferring it from the number of currently connected remote devices. In particular:

- the Mobile Access Coordinator remembers whether verified ownership has been persisted;
- launch reconciliation restores that configured flag even while Tailscale is unavailable;
- every actual quit path passes the configured flag into the existing native confirmation;
- the confirmation states that mobile access and Push stop until Tessera is relaunched;
- connected-device and active-terminal consequences remain combined in the same dialog;
- tray hiding remains a silent window hide and does not enter the quit path;
- normal quit still stops only the local server, leaving the background Serve mapping and
  mobile trust state untouched.

Localized native confirmation copy was added for English, Korean, Japanese, and Chinese.

## Skill invocation and TDD seams

The provider `$implement` skill was loaded and GitHub issue 306 was supplied as its ticket.
The issue body and acceptance criteria were treated as the authoritative specification.
Repository orientation used the existing Graphify graph before source reads. Because the
behavior crosses Windows Electron, a packaged server child, and persisted mobile state, the
repository `tessera-electron-dev` skill and both cross-boundary isolation notes were followed.

The issue pre-agreed two public `/tdd` seams:

1. `buildQuitConfirmation()` plus the Electron close/quit orchestration seam;
2. the public `MobileAccessCoordinator` setup and launch-reconciliation seam.

Red-green slices ran vertically:

- configured Mobile Connection with zero connected devices: the new assertion initially
  failed with 8/9 passing because the confirmation was `null`; localized mobile/Push copy and
  the configured input made 9/9 pass;
- setup ownership: the new test initially failed with 18/19 passing because
  `hasConfiguredConnection()` did not exist; the coordinator now becomes configured only
  after verified ownership is persisted, making 19/19 pass;
- relaunch under stopped Tailscale: the new test initially failed with 19/20 passing because
  a fresh coordinator forgot persisted ownership; launch reconciliation now restores it,
  making 20/20 pass;
- Electron wiring: the contract initially failed with 4/5 passing because `main.ts` did not
  pass coordinator configuration into the confirmation; the wiring change made 5/5 pass.

Green characterization contracts then fixed the already-correct tray, saved preference,
cancel, normal-quit preservation, relaunch ordering, no-login-startup, and setup/preference
behavior without introducing additional production branches.

## Exact verification commands and measured results

Issue and baseline:

```text
gh issue view 306 --repo horang-labs/tessera --comments --json number,title,body,comments,labels,url
npx tsx --test tests/electron-remote-access-status.test.ts tests/electron-terminal-quit-contract.test.mjs tests/mobile-access-coordinator.test.ts tests/electron-app-secret-header-contract.test.mjs
```

The baseline command passed 33 tests, 33 passed, 0 failed. The GitHub issue had no comments.

Final targeted contracts:

```text
node --test tests/electron-mobile-lifecycle-contract.test.mjs tests/electron-terminal-quit-contract.test.mjs
npx tsx --test tests/electron-remote-access-status.test.ts tests/mobile-access-coordinator.test.ts tests/electron-app-secret-header-contract.test.mjs
```

Final result: 42 tests total, 42 passed, 0 failed. The first command passed 10/10; the second
passed 32/32. These cover tray, interactive and saved quit, cancel, configured and
unconfigured mobile access, combined terminal risk, setup ownership, mapping preservation,
and inherited relaunch reconciliation.

Static and compilation checks:

```text
npx tsc --noEmit
npm run lint
npm run electron:compile
git diff --check
```

- `npx tsc --noEmit`: exit 0, no output.
- `npm run lint`: exit 0, 0 errors and 3 pre-existing warnings in
  `preview-markdown.tsx`, `use-virtual-message-list.ts`, and `spawn-cli-runtime.ts`.
- `npm run electron:compile`: exit 0.
- `git diff --check`: exit 0, no output.

Dependency restoration used `npm ci`: 1,042 packages installed; npm reported 46 audit
findings (2 low, 13 moderate, 28 high, 3 critical). No dependency or audit rewrite was made.

Graph maintenance used:

```text
graphify query "mobile lifecycle tray quit mapping serve" --budget 3000
graphify update .
```

The final update produced 10,052 nodes, 26,631 edges, and 424 communities. Generated graph
outputs are ignored and were not committed.

No full suite was run, as required by the ticket's wave verification rules.

## Packaged Windows Electron verification

Inherited Tessera environment variables were inspected before launch. The installed app
invariants were recorded as main PID `44248`, packaged server PID `33516`, listening port
`32123`, and source development DB SHA-256
`e3271c7dc7a9ef4babfc82be8bb84e2c50ae0828f59509097c1e360fbea9c380`.
An unrelated ticket's isolated instance was also observed and was not stopped or reused.

The final source was built and launched with:

```text
bash "$PWD/.codex/skills/tessera-electron-dev/scripts/build_and_launch.sh" \
  --repo "$PWD" \
  --count 1 \
  --session-id "codex-306-lifecycle-0809" \
  --seed-data-dir "/home/work/.tessera" \
  --output-name "Tessera-issue-306-lifecycle.exe" \
  --output-dir-name "Tessera-issue-306-lifecycle-unpacked"
```

Production Next build, TypeScript validation, Electron compile/runtime preparation, and
Windows x64 portable packaging succeeded. The portable SHA-256 was
`1184e4b21802c858aced02517259420c52fa3552310f8486329641b61ae8ee50`; the matching unpacked
`Tessera.exe` SHA-256 was
`7a5fd3f60548cc730faa6b6b0a3c3630a839e626ba36f6898ef5bd2535231bec`.

The initial safe unconfigured launch used Electron PID `45488`, server PID `48660`, server
port `32124`, and CDP port `9337`. Windows Node/CDP verified a complete page titled `Tessera`
at `http://localhost:32124/chat`. This instance was stopped through its ownership manifest
without removing its isolated data.

To avoid changing the user's real Tailscale Serve target, a completed ownership fixture with
the deliberately different DNS name `tessera-issue-306.invalid` was added only to the
isolated data. Relaunch reconciliation therefore established “configured” state and failed
closed on the origin change before Serve inspection or mutation. The relaunched app used
Electron PID `45728`, packaged server PID `40148`, server port `32124`, and CDP port `9337`.

Measured lifecycle results:

- saved `tray`: renderer close dialog count was 0, `/api/settings` remained reachable, and
  Windows UI Automation found no visible top-level window for PID `45728`;
- saved `quit`: renderer close dialog count was 0, but the native confirmation appeared;
- the native Korean confirmation measured 771 by 289 pixels and visibly stated that mobile
  access and Push notifications stop until relaunch; because the isolated DB contained one
  active terminal, it also accurately stated that one terminal task would stop;
- the screenshot was captured at
  `C:\Users\work\AppData\Local\Temp\issue306-mobile-quit-print.png`, visually inspected,
  and moved to trash during required cleanup;
- pressing Escape cancelled the confirmation; Electron PID `45728`, server port `32124`,
  and CDP port `9337` all remained alive;
- confirming the same saved-quit path terminated the Electron process and closed both ports;
- isolated `mobile-access.json` SHA-256 remained
  `115038303f0ba18dc2574f2484e9505b586f1f8ba243bcf7830d8711e0f8888d` before quit, after
  confirmed quit, and after relaunch;
- a post-quit relaunch used Electron PID `46328`, again loaded `/chat`, and reported the
  expected fail-closed `ownership-conflict` for the deliberately different DNS without
  deleting the ownership record.

Cleanup used `scripts/stop-electron-test-session.ps1 -SessionId
'codex-306-lifecycle-0809' -RemoveData`. It stopped only PID `46328`, removed the isolated
manifest/data, and left only the installed app's port `32123` listening. The installed main
PID `44248`, server PID `33516`, and source DB SHA-256 were unchanged. The unique Downloads
portable/unpacked copies, temporary CDP/UI-Automation scripts, screenshots, and worktree
release artifact were moved to trash and remain recoverable there.

## Code review

The requested `$code-review` skill pinned fixed point `5c00c0f`, confirmed a non-empty
`git diff 5c00c0f...HEAD`, and dispatched its Standards and Spec agents in parallel with
read-only restrictions.

Initial reports were kept as separate axes:

### Standards

One hard finding: the source-text lifecycle contract did not itself prove the packaged
Electron/process/network topology, and the runtime evidence was not present in the diff or
commit message. No baseline smells were found.

The packaged evidence and precise limitations are now durably recorded in this report,
addressing the documentation gap. The narrow deterministic tests remain paired with that
exact-environment smoke test as required by the cross-boundary note.

### Spec

No findings.

Initial summary: Standards 1 finding (worst: packaged runtime evidence was not durably
recorded); Spec 0 findings.

## Not verified and deliberately left out

- A real owned Tailscale Serve endpoint was not repointed to the isolated server, because
  that would interrupt or mutate the user's live mobile origin. Consequently, real mobile
  reachability and Push delivery after relaunch were not claimed from the packaged smoke.
  Mapping no-op/repair/recreation, origin retention, unavailable Tailscale, and ownership
  loss are covered deterministically through the coordinator seam.
- Real paired mobile devices and browser Push subscriptions were not disconnected. The
  native dialog used a safe isolated ownership fixture and an isolated DB snapshot.
- OS login startup settings were not toggled. The regression contract proves setup contains
  no `setLoginItemSettings`/`openAtLogin` path, and no startup feature was introduced.
- The full test suite, dependency audit remediation, unrelated lint warnings, Mobile
  Connection Removal, Funnel mutation, user Serve mutation, pushing, and opening a PR were
  deliberately left out.
- No new browser e2e file was needed. The new lifecycle contract file is 78 lines, and the
  native packaged behavior was exercised directly over CDP plus Windows UI Automation.
