# Image reference replay contract

The Images tab reconstructs arguments from recorded `functions.exec` JavaScript.
QuickJS supplies JavaScript semantics; Tessera supplies the host helpers and recorded
tool responses. Running a JavaScript engine does not make an arbitrary recording
fully reproducible. Never substitute an invented value to make a replay finish.

## Version evidence

On 2026-09-21, the installed `/home/work/.local/bin/codex --version` reports
`codex-cli 0.155.0`. Reading only the first `session_meta` record (at most 64 KiB per
file) found 49 recordings dated September 12 and 29 dated September 14 with
`cli_version: 0.154.0`; six dated September 21 report `0.155.0`.
This confirms an update, but does **not** establish which version introduced a
helper or whether the update caused a particular failure. A resumed session's
initial metadata is not proof of the version used for every subsequent call.

The helper inventory below comes from the `functions.exec` tool instructions
injected into the September 21 conversation. Keep historical recording evidence
separate from today's installed tool inventory. Inspect installed runtime sources
or version-matched declarations before claiming a new contract is supported.

## Host helper inventory and required behavior

This matrix describes the implemented replay boundary. The tests and runtime
remain authoritative when this contract changes.

| Helper | Contract relevant to replay | Safe handling |
| --- | --- | --- |
| `text(value)` | Emits output; argument expressions still execute. | Discard display output after evaluating arguments. Never skip argument side effects. |
| `image(value, detail?)` | Emits an image. | Discard display output. A narrowly verified direct display can omit image bytes; calculations on omitted bytes stay unavailable. |
| `audio(value)` | Emits audio. | Discard display output after evaluating arguments. Do not load audio bodies. |
| `generatedImage(result)` | Emits a generated image and optional hint. | Discard display output; retain recorded metadata used elsewhere. |
| `notify(value)` | Emits intermediate output immediately. | No external notification during replay; evaluate arguments and preserve recorded continuation boundaries. |
| `store(key, value)` / `load(key)` | Carry serializable state across fresh exec isolates. | Export only stored graph values between contexts, capped at 8 MiB. Missing fields and unknown effects must not create fabricated paths. Arbitrary globals do not survive. |
| `yield_control()` | Yields output while the script remains alive. | Microtask continuation with a termination gate: after a recorded termination, stop when no recorded image results remain. Wait outputs associate with the original exec. This does not reconstruct arbitrary interleaved shared-state execution. |
| `exit()` | Immediately ends the script successfully. | Snapshot stored state at exit, suppress subsequent native tool effects, and interrupt the isolate. Preserve the snapshot, not later catch/finally mutations. Contract tests must verify short scripts as well as loops. |
| `setTimeout(callback, delayMs?)` / `clearTimeout(id)` | Schedule/cancel callbacks. Pending timers alone do not keep the script alive. | Virtual timers run only while top-level execution remains pending, after microtasks, in delay/insertion order; cancelled and leftover timers are discarded. Simultaneously pending timers and recorded tool returns fail explicitly because their historical ordering is unavailable. No host sleeping. |
| `ALL_TOOLS` | Array of `{name, description}` for the available tools. | Requires the historical catalog. Neither an empty array nor today's catalog represents an unrecorded historical catalog. Report unavailable metadata. |
| `tools.<name>(args)` | Calls an asynchronous tool. | Match recorded returns using evidence. Do not execute the original tool or fabricate a successful response. Unknown tools/fields remain explicit limitations. |

Unknown helper names must produce actionable diagnostics instead of silently
continuing with guessed values. A failed call must not suppress later independent
calls. CPU and heap limit failures dispose only the affected isolate; the next
cell receives a fresh one. Session-wide worker/recording limits still bound the
whole replay and are reported separately.

## Execution architecture and remaining limitations

- Each exec now receives a fresh QuickJS runtime/context. A bounded graph codec
  transfers explicit stored metadata only, including cycles, Map, Set, Date,
  BigInt, undefined, arrays and plain objects. It rejects functions/accessors and
  unsupported prototypes. Partial tool-result proxies retain their omitted-body
  behavior after transfer; image pixels never enter the VM.
- The scheduler checks top-level completion between microtasks and discards
  remaining jobs when it completes. Recorded tool invocations and execution of
  their later continuations are different facts.
- Image, view and uniquely associated command-result jobs use recording offsets.
  Returns without an association still cannot establish historical race ordering.
- Output from yielded cells, waits, interruption, termination and late results
  needs explicit association. Timestamp proximity alone is not proof of ownership.
  Recorded turn IDs exclude execs from other turns, while exact returned result
  IDs associate otherwise ambiguous events with an exec. Missing turn IDs remain
  unknown. Unfinished earlier cells do not prevent later independent replay.
  Exec liveness alone is not image-call liveness: an exec may have finished every
  image and still be waiting on unrelated work or have no terminal output.
  For otherwise unowned results, record the eligible exec IDs at event arrival.
  After replay, compare only their still-unassigned image invocations, requiring
  known matching turn ownership, an exact prompt, and a one-to-one match in both
  directions. A call discovered after a recorded tool completion cannot claim a
  result from before that completion. Already assigned calls, other turns and
  future execs do not compete; duplicate prompts and unknown turn ownership remain
  unresolved. This phase repairs captured input metadata only. It does not resume
  speculative continuations or invent tool responses/state. Prompt similarity and
  chronological proximity are never used as substitutes for this evidence.
  An eligible exec that failed before discovering any image arguments is an
  opaque competitor, not evidence of zero image calls. It blocks this fallback;
  an explicit returned result ID remains usable.
- Cells replay in invocation order. An intervening exec that modifies stored state
  while another exec is yielded is not a fully modeled concurrent timeline. A
  conservative source capability scan blocks shared-state reads and discards
  snapshots when overlapping cells both may use shared state. Independent image
  arguments can still replay; dependent reads report the unsupported overlap.
  Independent intervening cells can still replay. This scan is a scheduling guard,
  not a proof that arbitrary dynamic or adversarial JavaScript is reproducible.
- Omitted image/audio bodies, external filesystem changes, unknown tool results,
  runtime clocks/randomness and an absent historical catalog cannot be recovered
  by adding more JavaScript syntax support.

## Failure isolation and owned-image continuity (replay version 5)

An omitted or malformed metadata record creates an explicit replay barrier. The
streaming reader skips that record without retaining its oversized body, then
continues at the next JSONL boundary. The barrier invalidates stored state and
recent-image history and prevents same-turn ownership guesses across the gap.
An omitted JavaScript source receives the same treatment. A later known turn can
still reconstruct independent calls. Session-wide budgets remain enforced.

State completeness is separate from the set of known keys. After an unavailable
execution, `load('missing')` must not act like a known-absent key and silently
choose `load('missing') || '/default.png'`. It reports unavailable state. A later
explicit `store` can establish a known key again; independent literal references
remain usable. Per-cell failures do not stop subsequent execs.

Rebuilding an index preserves owned files for stable tool/image result IDs still
observed in the new recording. It does not resurrect removed events, match user
images by unstable byte offsets, reuse conflicting locators, or change failed
results to completed. Previous ledger metadata survives multi-batch rebuilds.
An empty recent-image cache locator counts as missing instead of producing a
broken thumbnail with a successful input count. Path insertion uses the surviving
owned cache file, translated for the agent environment, even when an older
`agentPath` names a deleted original.

Public image URLs include a locator revision. Content-addressed cache paths make
this metadata-only: rebuilding an association changes the URL and causes an open
Images tab to load the corrected content. A request for an obsolete revision
returns a non-cacheable 404 instead of placing new bytes under an old URL. Raw
non-indexed path locators identify a path, not arbitrary external file mutations.
Version 5 retries old persisted failures without requiring a transcript append.

## Required regression coverage

Cache reconciliation has its own identity contract: every public card ID must
select exactly the card displayed by the UI, and each recorded result must survive
without being attached to unrelated inputs. Both its pending placeholder and its
orphan result are consumed when a call is repaired, including incomplete batches.
Metadata-only normalization at database reads and writes repairs legacy duplicate
IDs even when replay or the transcript is unavailable. Distinct conflicting results
retain their result IDs instead of competing for an invocation URL. Replay version
4 also retries persisted version-3 failures without requiring a transcript append.
Reference reuse requires matching metadata
and nonempty cached locators; an empty input list is not proof of successful caching.
Partial cached inputs retain ownership while missing references are retried.

1. A multi-image loop yields between images, resumes through recorded waits and
   reconstructs every observed input. Interruption/termination after a yield must
   not invent subsequent calls or stored values.
2. Display helpers and notifications preserve argument side effects and allow
   later images. Image-body calculations remain unavailable without reading pixels.
3. Syntax errors skip only their cell. Unknown helpers report their name and do
   not prevent later independent calls; dependent state is not silently reused.
   CPU interruption and heap exhaustion must also be followed by a successful
   independent image call in the **same recording**, not a separate replay request.
4. Global assignments and modified built-ins do not leak across exec cells, while
   supported `store`/`load` values survive.
5. Unawaited callbacks after top-level completion cannot alter later references.
   Parallel tool completions follow recorded evidence, not invocation order.
6. Catalog reads, unknown tool returns and mixed timer/tool races produce explicit
   diagnostics. Timer tests cover cancellation, microtask ordering and discarded
   callbacks; exit tests cover `try/catch/finally`, short scripts and loops. Extend
   scheduling tests before changing supported behavior.
7. Replay remains bounded for long recordings and never loads media bodies into
   the VM. Keep per-cell CPU, VM heap and worker limits in place.
8. Verify the reported session in the real Windows backend + WSL filesystem
   topology. Distinguish worker evidence from full packaged Images-tab evidence.
9. A yielded parallel batch with all images matched must not suppress the next
   batch's last results, including results after an interruption and without a
   final returned-ID hint. Cover inverse completion order, repeated prompts
   across/within execs, multiple results competing for one call, failures after
   successful generation, turn boundaries and later same-prompt calls. Verify the
   streaming path across metadata windows and unchanged/append polls as well as
  in-memory fixtures. Seeded permutations must never interchange references.
10. Oversized metadata, excessive nesting, malformed JSONL and omitted JavaScript
    source must be followed by a successful independent call in the same replay.
    State-dependent defaults and recent-image history cannot cross the gap.
11. Rebuild with original reference/result files deleted; verify stable owned
    images survive, removed events do not reappear, and insertion paths remain
    readable to the configured agent. Corrected input/result URLs must update a
    visible image without a page reload and reject obsolete revisions.

## September 21 validation and September 22 correction

The frozen user recording contained 25 completed generation events. Packaged
Windows backend + WSL transcript QA originally restored inputs for 23, including
both reported second-in-loop failures. The two unresolved results were incorrectly
classified as unrecoverable: the earlier exec had already produced all five of its
images, while the next exec's last two calls had fully reconstructed arguments and
unique exact prompt matches within the recorded scope. Missing final exec output
was not evidence that the inputs themselves were missing. Version 4 repairs these
associations after argument replay. The frozen initial recording now resolves
25/25 results, the subsequent snapshot 26/26, and the September 22 snapshot of
the same session 34/34. Keep these counts separate from arbitrary-session coverage.
The same test removed the persisted replay version without appending to the
transcript and verified that the old failed cache was repaired again.

During the 128,647,861-byte transcript test, the packaged server process (including
worker threads) used 183.9 MiB working set before scanning, peaked at 209.9 MiB,
and settled at 189.2 MiB. Private bytes peaked 46.8 MiB above baseline. The unrelated
messages API was mocked; these numbers measure the Images flow, not total app or
renderer memory. Image bodies were streamed to cache without entering QuickJS.

September 22 packaged Windows backend + WSL file QA used the frozen 102,465,095-byte
current transcript: 34 completed results, zero unresolved inputs, and 84 successful
input/result image HTTP responses. Both previously missing references decoded in
the real Images tab. Downgrading the isolated cache to version 3 reproduced two
failed cards; a sync restored both at the same source offset, persisted version 4,
and survived reload. During scan and cache retry the server including its worker
rose from 167.9 MiB to 212.8 MiB working set and settled at 188.1 MiB; private bytes
peaked 65.1 MiB above baseline. The unrelated messages API was mocked and terminal
creation blocked, so this is Images-flow evidence, not session-start or total-app QA.

The subsequent version-5 audit repeated the current recording on a newly packaged
Windows backend: 34/34 resolved results and 84 image responses, including automatic
version-3 cache recovery at the unchanged source offset. Additional isolated
fixtures verified visible input/result replacement without reload, obsolete URLs
returning 404, rebuilding recent references/results after deleting only synthetic
originals, cache-backed `/mnt/c/...` insertion paths, and continued independent
generation after a 1.28 MiB metadata record. Dependent unknown state stayed
unresolved instead of selecting a fabricated default image.

Across the Images tests, packaged server working set rose from 171.2 MiB to
216.2 MiB and ended at 204.8 MiB; private bytes peaked 70.0 MiB above baseline.
These measurements include replay workers, exclude renderer/production processes,
and retain the same messages-API mock and terminal-creation block. Screenshots
01–14, HTTP assertions, runner sources and memory evidence are in Windows
Downloads `Tessera-image-audit-QA-0922`. Synthetic session-start error toasts are
outside this Images-only fixture; they are not evidence of successful CLI startup.

A separate disposable real Codex PTY verified the recovered image path through
browser DOM drag events in the list, direct Peek, Peek after the actual list
detach event, and reopened Peek. Each exact path reached the attached surface's
`terminal_input` and Codex returned an image-attachment marker. This tests the
browser drop handlers and Windows-to-WSL PTY route, not a physical mouse gesture;
no prompt was submitted. The regression suite passed 134 tests with one optional
historical fixture skipped; the current real recording was tested separately above.

Relevant implementation: `runtime/image-reference-replay.cjs`,
`runtime/replay-state-codec.cjs`,
`runtime/image-reference-replay-worker.cjs`, `runtime/image-record-reader.cjs`,
`src/lib/image-generation/replay-worker.ts`, and
`tests/image-reference-replay-engine.test.mjs`,
`tests/image-replay-association.test.mjs`,
`tests/image-replay-runtime-contract.test.mjs`, and `tests/replay-state-codec.test.mjs`.
