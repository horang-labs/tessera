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
  Multiple live execs in the same turn can still leave unassociated results when
  no output identifies their owner; prompt similarity must not resolve this.
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

## Required regression coverage

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

## September 21 validation

The frozen user recording contained 25 completed generation events. Packaged
Windows backend + WSL transcript QA restored inputs for 23, including both
reported second-in-loop failures. Two results remain unassociated: multiple execs
were live in the same turn, and their returned output did not identify those
result IDs. They remain unresolved rather than being assigned by prompt similarity.
The same test removed the persisted replay version without appending to the
transcript and verified that the old failed cache was repaired again.

During the 128,647,861-byte transcript test, the packaged server process (including
worker threads) used 183.9 MiB working set before scanning, peaked at 209.9 MiB,
and settled at 189.2 MiB. Private bytes peaked 46.8 MiB above baseline. The unrelated
messages API was mocked; these numbers measure the Images flow, not total app or
renderer memory. Image bodies were streamed to cache without entering QuickJS.

Relevant implementation: `runtime/image-reference-replay.cjs`,
`runtime/replay-state-codec.cjs`,
`runtime/image-reference-replay-worker.cjs`, `runtime/image-record-reader.cjs`,
`src/lib/image-generation/replay-worker.ts`, and
`tests/image-reference-replay-engine.test.mjs`,
`tests/image-replay-runtime-contract.test.mjs`, and `tests/replay-state-codec.test.mjs`.
