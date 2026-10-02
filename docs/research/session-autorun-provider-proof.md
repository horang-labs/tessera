# Autorun provider proof — #530 / R0a

Tested 2026-10-03 from `94c4d50fed91274bba36f824c9074a8b95a2e055`. This is a narrow executable feasibility proof, not an Autorun implementation. No product/S0/A/B/C files change. The latest #530 body (no comments) assigns this unit and supersedes the older wave split. See [reviewed design](../design/session-autorun-architecture.md).

## Evidence and reproduction

- **Observed:** Windows Node 24.15.0, `process.platform=win32`, existing `spawnCliProcess(...,'wsl',...)`, WSL Ubuntu-24.04 CLI, existing authenticated `buildHookCommand('posix')`, Windows `resolveAgentReportedPath` and real native file reads. An owned loopback listener accepts only its random pane token. No normal Tessera profile, DB, UI, Control credential or `TESSERA_DEV_PORT` is involved.
- **Observed:** Codex `0.159.2`, Claude Code `2.1.284`. Worker and supervisor: Codex `gpt-6.1-sol/high/default`; Claude `claude-sonnet-5-5/high`, service-tier selection null, returned provider usage tier standard. The Claude model is an exact ID in existing account settings, not an alias/fallback.
- **Deterministic:** sanitized native-record fixtures and mutation cases test cutoffs, delayed/partial flush, duplicate completion, wrong binding/Stop, unresolved tools, and supplied approval/child blocking evidence. They do not implement B's runtime admission.
- **Source-only:** full tool registration conditions, unsupported-version policy, parser bounds and future integrated host fences. Live model refusal is behavioral evidence, not a formal proof of prompt-injection immunity.

Run from the repository root with existing account auth and dependencies:

```sh
npx tsx --test tests/autorun-provider-proof-context.test.ts tests/autorun-provider-proof-finality.test.ts
node tests/autorun-provider-proof.live.mjs claude-worker /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-worker /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs claude-supervisor /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-supervisor /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs claude-supervisor /home/work/tmp/autorun-530-run probe
node tests/autorun-provider-proof.live.mjs codex-supervisor /home/work/tmp/autorun-530-run probe
node tests/autorun-provider-proof.live.mjs claude-cancel /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-cancel /home/work/tmp/autorun-530-run
```

Live calls are opt-in; ordinary tests never launch an account-auth CLI. The runner creates owned scratch, separate worker/supervisor config homes and an empty guest cwd. Only existing account-auth files are symlinked. It bundles the existing bridge for Windows execution. Each call records exact argv, output, closure and process manifest in scratch; raw transcripts stay there. Cancel modes need the corresponding prior supervisor argv. No credentials are printed/copied into fixtures. Stop/timeout only signal the newly created guest process group; no broad kill or ordinary Session inspection. Keep scratch for review or remove that exact directory after all manifests are quiescent.

## Native completion mapping

Both harmless worker turns answer exactly `PROOF_OK`; the second is an explicit resume of the same provider conversation. Supervisor invocations are fresh, use separate homes and never resume the worker.

| Provider | Observed IDs | Submit cursor → Stop cursor → complete end (original bytes) |
| --- | --- | --- |
| Claude conversation `c9303786-fff6-4b22-810e-07a5ba5b06a6`, turn 1 | prompt `7ab43974-3790-40ac-bf63-6fb3b2eed4fa`; assistant `754f6881-5d70-41cc-9e82-32d0c90bbb8d` | `0 → 10104 → 11469` |
| Same Claude conversation, turn 2 | prompt `b5eadbbd-547d-4bce-b447-0b8bfa67ab48`; assistant `1996e946-6f39-487a-80ad-bbae88e742d5` | `17525 → 19038 → 20478` |
| Codex conversation `01a0fd47-096d-7641-94f0-0013775e02e4`, turn 1 | `turn_id=01a0fd47-098b-74c2-ab46-5a4d33836280` | `38164 → 42148 → 42436` |
| Same Codex conversation, turn 2 | `turn_id=01a0fd47-371c-75a3-a5ba-13003db0b03a` | `45195 → 49195 → 49483` |

**Both providers' Stop hooks preceded their final durable record.** Our observer saves the complete-line cursor and native bytes before posting. Timestamp/latest text alone would select stale evidence. Fixture byte offsets intentionally differ after sanitization; `observations.json` keeps original and fixture end offsets separately.

Claude Submit and Stop both carry `prompt_id`; the native human record carries `promptId`. Match session + exact prompt ID, then follow `uuid/parentUuid` through attachments/system records to the unique lead final assistant matching Stop text, retaining API message ID and final byte end. Never select a sidechain or an earlier identical answer. The observed final records have different UUIDs/API IDs despite identical text. The finality proof rejects unresolved tool uses; a production reader also needs provenance, compaction/error/record validation and B's gate.

Codex Submit and Stop both carry `turn_id`. Match `session_meta.id`, `thread_source=user`, one `task_started`, matching `turn_context.turn_id`, and one subsequent error-free `task_complete` with the same ID. Cut at that record end. The raw record is lifecycle evidence; the normal UI decoder omits it. Stop's cursor is already **after** task_started/turn_context: do not search for the turn start only after the submission-hook cursor.

Minimal R0/R1 observer fields: provider/session, native prompt/turn ID, terminal generation/server instance, observer submission ID, canonical source identity/file generation, complete-line start cursor, completion hook ID and dedup key. Preserve `prompt_id` and `turn_id` through the authenticated receiver; the current generic lifecycle contract does not freeze these fields. Compare before/after capture under B's gate; no unobserved children/approval/input changes. Retry flush readiness within the design's 10-second bound, then explicit unavailable. These are contract gaps for the orchestrator, not unauthorized S0 edits.

## Supervisor configuration and capability result

Bounded packet: two supplied assistant records, explicit goal/criterion `two`, constraints, full coverage, empty prior decisions. No file/URL fetch, raw reasoning, attachments or worker conversation reuse. The fixture preserves that exact packet; product bounds remain 96 KiB serialized / 16 KiB goal+constraints / 8 KiB ten decisions / 32 MiB scan / 2 MiB record, with labelled omissions. This proof does not claim to implement truncation/compaction.

Claude invocation:

```text
claude -p --output-format json --no-session-persistence
  --model claude-sonnet-5-5 --effort high --safe-mode --restricted --tools ''
  --disable-slash-commands --permission-prompts none
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --settings '{"disableAllHooks":true,"enabledPlugins":{}}'
  --json-schema <decision schema JSON>
```

Auxiliary same-selection `stream-json --verbose` runs expose effective init: only `StructuredOutput`, no MCP servers/skills. StructuredOutput is an output formatter, not command/file/network execution. Builtin `agents-md` and `telemetry` **still appear** in init even with safe mode; do not claim an empty plugin roster. A harmless scratch `CLAUDE.md/AGENTS.md` marker did not appear in the response; hook receipts were zero; write probes returned needs-user with no tool call/file. The standard Linux managed settings/config/requirements files were absent in this probe. Managed policy remains authoritative: R1 must reject conflicting mandatory managed capabilities, rather than silently disabling them or claiming universal isolation. `--bare` was excluded because it disables OAuth.

Codex invocation:

```text
codex exec --json --strict-config --ignore-user-config --ignore-rules --ephemeral
  --skip-git-repo-check --sandbox read-only -m gpt-6.1-sol
  --output-schema <schema path> <exact -c controls from codex-controls.json> -
```

The original design controls alone are insufficient. The installed catalog declares `apply_patch_tool_type=freeform`, `tool_mode=code_mode_only`, experimental clock/user-message tools and code-mode metadata. Disabling shell/unified exec is not an all-tools gate. The original candidate emitted a code-mode-host-unavailable warning; that is not evidence of a truly empty tool roster.

**Concrete tested adaptation:** an invocation-local `model_catalog_json` with the same exact model ID and context/effort/tier metadata, `shell_type=disabled`, `apply_patch_tool_type=null`, no experimental tools, `tool_mode=null`, `supports_search_tool=false`, `node_repl_disabled=true`, a packet-only base instruction and no inherited model-message template. Its explicit controls disable shell/unified exec, both multi-agent versions, apps/plugins/remote plugins, browser/computer/image tools, goals/sleep/skill search/hooks/memories, shell snapshots, daemon auto-start, tool suggestion and code-mode/host; disable web search and plan; skip host skill discovery; set project-doc budget zero. Exact argv/control/catalog fixtures are checked in. The model ID is never substituted. R0/R1 must version-pin and validate this adaptation; do not silently extend another model's catalog.

Live adapted results: exit 0, one structured complete decision citing both supplied records; separate capability probe explicitly requests an actual scratch write, returns needs-user, no executable receipt, no sentinel, zero worker-hook receipts. Project instruction marker absent. CLI-generated global developer scaffolding was visible in `debug prompt-input`; this is not evidence of an entirely empty system prompt. We claim empty project cwd/instructions, separate conversation and disabled executable capabilities, not absence of every provider system instruction.

The capability roster combines observed Claude init, observed Codex catalog metadata, source registration gates and live refusal/absence of side effect. We did **not** intercept the actual Codex inference tool array. A scratch loopback routing experiment failed because workspace backends require HTTPS; it produced no valid decision and is not counted as capability evidence. Complete wire-roster attestation remains an R1 capability-check obligation if stronger assurance is required; current source/gate evidence must stay labelled.

## Finality, cancellation and integration obligations

Accept only exit 0 **after owned process quiescence**, successful provider final envelope, exactly one structured decision, strict schema and supplied evidence/criterion references. Claude final `result/success`, `is_error=false`, `terminal_reason=completed`, `structured_output`; Codex one final agent-message JSON followed by `turn.completed`. Partial assistant text, timeout, cancellation, nonzero exit, provider error/tool receipt and uncertain quiescence fail. No repair/fallback/retry/worker write occurs in this proof.

Observed Windows-triggered cancellation uses an owned WSL wrapper, process group manifest and abort marker. TERM then bounded KILL covers the CLI and an owned sleeping descendant; closure records list remaining members/quiescence. Killing only `wsl.exe` is excluded. Deterministic settlement faults prove valid-looking partial text cannot become a decision. This is a cancellation strategy for R1 to integrate, not a change to existing `generateText` behavior.

R0 must freeze correlation/capability/cancellation DTOs and the catalog adaptation. R1 owns record/provenance/UTF-8/compaction bounds, managed-policy preflight, full effective-capability validation and bridge instrumentation. R2/R3 and #528/R4 retain analysis/paste races, counters, attention, normal panel/Peek, restart, approvals and final packaged Windows backend + WSL CLI QA with ordered screenshots in Downloads. This Node/backend harness is actual cross-OS evidence, **not** packaged Electron/UI evidence. No desktop build, UI screenshot, full suite or release was performed here.

## Sources

[Claude hook common fields](https://code.claude.com/docs/en/hooks#common-input-fields) document prompt_id from 2.1.196; [Stop input](https://code.claude.com/docs/en/hooks#stop-input) warns about final transcript lag. [CLI reference](https://code.claude.com/docs/en/cli-reference) and installed help establish the candidate controls. [Official Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents selection/tool configuration; [developer settings](https://learn.chatgpt.com/docs/developer-settings) documents strict-config and precedence. Installed help/features/catalog were also read; documentation alone was not treated as an effective roster.

[Codex protocol at ca466061](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/protocol/src/protocol.rs#L2153) defines turn completion ID/error and task_complete serialization. Tool/model registration source inspected at the source-tree revision recorded below: `codex-rs/core/src/tools/spec_plan.rs` (apply_patch requires nonnull model metadata), `codex-rs/protocol/src/openai_models.rs` (Disabled shell, optional patch/tool-mode fields). Source gates inform the adaptation; installed live results establish its tested behavior.

Tool/model source tree: `4cedd0caac89f9fdcb5ad385e8093da5363d91c2`.
