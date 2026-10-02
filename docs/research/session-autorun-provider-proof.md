# Autorun provider proof — #530 / R0a

Tested 2026-10-03 from `94c4d50fed91274bba36f824c9074a8b95a2e055`. This is a narrow executable feasibility proof, not an Autorun implementation. No product/S0/A/B/C files change. The #530 R0a assignment and latest orchestrator comment govern this unit and supersede the older wave split. See [reviewed design](../design/session-autorun-architecture.md).

## Evidence and reproduction

- **Observed:** Windows Node 24.15.0, `process.platform=win32`, existing `spawnCliProcess(...,'wsl',...)`, WSL Ubuntu-24.04 CLI, existing authenticated `buildHookCommand('posix')`, Windows `resolveAgentReportedPath` and real native file reads. An owned loopback listener accepts only its random pane token. No normal Tessera profile, DB, UI, Control credential or `TESSERA_DEV_PORT` is involved.
- **Observed:** Codex `0.159.2`, Claude Code `2.1.284`. Worker and supervisor: Codex `gpt-6.1-sol/high/default`; Claude `claude-sonnet-5-5/high`, service-tier selection null, returned provider usage tier standard. The Claude model is an exact ID in existing account settings, not an alias/fallback.
- **Deterministic:** sanitized native-record fixtures and mutation cases test cutoffs, delayed/partial flush, duplicate completion, wrong binding/Stop, unresolved tools, and supplied approval/child blocking evidence. They do not implement B's runtime admission.
- **Source-only:** full tool registration conditions, unsupported-version policy, parser bounds and future integrated host fences. Live model refusal is behavioral evidence, not a formal proof of prompt-injection immunity.

Run from the repository root with existing account auth and dependencies:

```sh
npx tsx --test tests/autorun-provider-proof-context.test.ts tests/autorun-provider-proof-finality.test.ts tests/autorun-provider-proof-loader.test.ts
node tests/autorun-provider-proof.live.mjs claude-worker /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-worker /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs claude-supervisor /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-supervisor /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs claude-supervisor /home/work/tmp/autorun-530-run probe
node tests/autorun-provider-proof.live.mjs codex-supervisor /home/work/tmp/autorun-530-run probe
node tests/autorun-provider-proof.live.mjs claude-cancel /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs codex-cancel /home/work/tmp/autorun-530-run
node tests/autorun-provider-proof.live.mjs claude-loader /home/work/tmp/autorun-530-run
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
claude -p --output-format stream-json --verbose --no-session-persistence
  --model claude-sonnet-5-5 --effort high --safe-mode --restricted --tools ''
  --disable-slash-commands --permission-prompts none
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --settings '{"disableAllHooks":true,"enabledPlugins":{}}'
  --json-schema <decision schema JSON>
```

The replayable supervisor itself exposes effective init: only `StructuredOutput`, no MCP servers/skills. StructuredOutput is an output formatter, not command/file/network execution. Builtin `agents-md` and `telemetry` **still appear** in init even with safe mode; do not claim an empty plugin roster. A harmless scratch `CLAUDE.md/AGENTS.md` marker did not appear in the response; that is **not** proof that instructions were unloaded. Init does not expose loaded instruction sources. The owned loader proof below supplies actual file-open evidence in addition to installed flag semantics and isolation. Hook receipts were zero; write probes returned needs-user with no tool call/file. The standard Linux managed settings/config/requirements files were absent in this probe. Managed policy remains authoritative: R1 must reject conflicting mandatory managed capabilities, rather than silently disabling them or claiming universal isolation. `--bare` was excluded because it disables OAuth.

Codex invocation:

```text
codex exec --json --strict-config --ignore-user-config --ignore-rules --ephemeral
  --skip-git-repo-check --sandbox read-only -m gpt-6.1-sol
  --output-schema <schema path> <exact -c controls from codex-controls.json> -
```

The original design controls alone are insufficient. The installed catalog declares `apply_patch_tool_type=freeform`, `tool_mode=code_mode_only`, experimental clock/user-message tools and code-mode metadata. Disabling shell/unified exec is not an all-tools gate. The original candidate emitted a code-mode-host-unavailable warning; that is not evidence of a truly empty tool roster.

**Concrete tested adaptation:** an invocation-local `model_catalog_json` with the same exact model ID and context/effort/tier metadata, `shell_type=disabled`, `apply_patch_tool_type=null`, no experimental tools, `tool_mode=null`, `supports_search_tool=false`, `node_repl_disabled=true`, a packet-only base instruction and no inherited model-message template. Its explicit controls disable shell, both multi-agent feature flags **and `agents.enabled`** (model v2 metadata otherwise takes precedence), apps/plugins/remote plugins, browser/computer/image tools, goals/sleep/skill search/hooks/memories, shell snapshots, daemon auto-start, tool suggestion and code-mode/host; disable web search, plan, deferred executor, permission/user-input/async-message tools, token-budget/history-note tools, clock, cloud/bundled skills and skill instructions; skip host skill discovery; set project-doc budget zero. Exact argv/control/catalog fixtures are checked in. The model ID is never substituted. R0/R1 must version-pin and validate this adaptation; do not silently extend another model's catalog.

Live adapted results: exit 0, one structured complete decision citing both supplied records; separate capability probe explicitly requests an actual scratch write, returns needs-user, no executable receipt, no sentinel, zero worker-hook receipts. Project instruction marker absence alone proves nothing. An auxiliary Linux app-server `thread/start` with the same controls returned exact model/high/default and `instructionSources=[]`; source `project_doc_max_bytes=0` disables project docs. This is supplemental exploratory evidence, not the replayable Windows exec proof. CLI-generated global developer scaffolding was visible in `debug prompt-input`; this is not evidence of an entirely empty system prompt. The replayable invocation isolates project discovery, conversation and executable capability registration; it does not remove every provider system instruction.

The capability boundary is **only Claude 2.1.284 / claude-sonnet-5-5 / high / null selected tier and Codex 0.159.2 / gpt-6.1-sol / high / default**, under these exact config/catalog and absent conflicting managed policy. Other existing UI models are unproven. Replay preflight rejects version drift, checks every requested effective feature, compares effective catalog selection/capability/context/effort/tier fields, requires effective MCP list empty, and requires Claude init model + only StructuredOutput + empty MCP/skills. No fallback. R0/R1 must validate fresh installed metadata before applying this adaptation; unknown model, version, registration/policy drift or unresolved isolation => explicit unavailable.

Pinned registration audit: release `rust-v0.159.2` → **`ff6aec96948b70d94983af2641a6b67c94faeff5`**, matching installed `codex-cli 0.159.2`. The [router source](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/tools/spec_plan.rs) builds core, MCP, extension, dynamic and hosted tools, then model-visible wrappers. These are all registration families, not just write tools:

| Registration family | Gate established by exact controls/catalog + pinned source |
| --- | --- |
| shell/exec/write_stdin, including one-shot fallback | `ShellTool=false` and model shell Disabled prevent `add_shell_tools` (1079). `unified_exec` is effectively **true** despite a false CLI override; the installed release reserves disabling it to managed policy. The ineffective override was removed; it is not the shell authority gate. |
| patch, view-image | Nonnull patch metadata would register unconditionally when an environment exists (1272); adapted null blocks it. ViewImage=false. |
| plan/environment-wait/user input/permissions/context-budget/clock/sleep/plugin install/test-sync | `add_core_utility_tools` (1148): plan/request-input config false; DeferredExecutor, RequestPermissionsTool, TokenBudget, CurrentTimeReminder, SleepTool, ToolSuggest, SendMessageToUserAsync false; model experimental tools empty; apps/plugins false. |
| agent spawn/message/resume/wait/interrupt/list and message board | `agents.enabled=false` + MultiAgentV2=false force Disabled before model v2 metadata (`core/src/config/mod.rs:1578`). Both multi-agent flags and AgentMessageBoard false prevent board binding (`core/src/agent_message_board.rs:47`). |
| MCP tools/resources; browser/computer/apps/plugins | No MCP config in auth-only home/cwd; ignore user/rules; apps/plugins/remote-plugin/browser/computer features false; source `add_mcp_tools` (1132) requires servers. No injected dynamic tools in exec ThreadStartParams (exec/src/lib.rs:1433). |
| extension web/image generation | `append_extension_tool_executors` (1477) filters web.run on disabled web mode, imagegen on disabled image feature. Hosted Responses tools empty with selected `use_responses_lite=true`; web disabled independently (622). |
| goal create/get/update | Goals=false sets runtime disabled; `ext/goal/src/extension.rs:533` requires tools_visible; `ext/goal/src/runtime.rs:126` requires enabled. |
| history notes / memory tools | `ext/history-notes/src/extension.rs:46` requires token-budget config using history notes; TokenBudget=false resolves config None (`core/src/config/mod.rs:2835`). `ext/memories/src/extension.rs:48,146` requires MemoryTool/use_memories; memories=false. |
| skills list/read | `ext/skills/src/tools/mod.rs:59` requires cloud provider enabled or selected executor roots. cloud.skills.enabled=false, no executor-selected roots in exec, skip host discovery, bundled/instruction config false; SkillSearch=false. |
| code mode / search wrappers | adapted tool_mode=null + CodeMode/CodeModeOnly/CodeModeHost false produce Direct; `register_code_mode_executors` (819) returns empty. supports_search_tool=false prevents search wrapper. |

This source audit establishes disabled executable registrations for the pinned candidate with the recorded effective controls; it is not an intercepted inference request or a universal guarantee about future releases/managed policy. Builtin provider networking for inference/auth remains. The unsupported top-level `tool_registry.turn_metadata_includes_tool_info` diagnostic and a scratch HTTP routing attempt produced no usable roster; neither counts as proof. Exact effective catalog and normalized feature/init/config observations accompany the fixtures. Write refusal is additional behavioral evidence. Tool results alone do not establish instruction exclusion; the separate observed loader proof below closes that requirement for the tested layout.

## Observed Claude instruction-loader exclusion

Latest orchestrator comment requested file-open-only tracing. Replay `claude-loader` first checks installed strace, then launches **new owned** WSL process trees through the same Windows bridge/group wrapper: `strace -f -yy -e trace=open,openat,openat2 -o <owned trace> -- claude <argv>`. No attach, read/write buffers, network, environment or credentials are traced. Raw syscall paths remain only in owned scratch; `loader-observations.json` preserves sanitized roles/counters, exact normalized argv/init and successful/quiescent settlement.

Four newly owned benign CLAUDE.md/AGENTS.md sources are created in isolated cwd/config home and removed in finally. Positive control removes only `--safe-mode` and `--restricted`; all executable tools/hooks/MCP/slash commands remain disabled, same exact selection and evidence packet. Both variants expose only StructuredOutput, empty MCP/skills, return valid structured finals, exit0/quiescent and zero worker-hook receipts.

| Source role | Control successful file opens | Exact candidate successful file opens |
| --- | --- | --- |
| Project CLAUDE.md | 2 | 0 |
| Isolated-home CLAUDE.md | 2 | 0 |
| Project AGENTS.md | 1 | 0 |
| Isolated-home AGENTS.md | 0 | 0 |

The first three sources have actual loading-positive controls and candidate exclusion; home AGENTS.md is recorded but **not** a positive-control-attested loader source. This closes the tested candidate's project instruction-loading proof without inferring from answer markers or claiming an empty provider system prompt. The parser rejects silent controls, an empty candidate trace, or any successful candidate source open. Failed open attempts do not count as loading. Future layouts/managed policy/version remain fail-closed R1 validation obligations.

## Finality, cancellation and integration obligations

Accept only exit 0 **after owned process quiescence**, successful provider final envelope, exactly one structured decision, strict schema and supplied evidence/criterion references. Claude final `result/success`, `is_error=false`, `terminal_reason=completed`, `structured_output`; Codex one final agent-message JSON followed by `turn.completed`. Partial assistant text, timeout, cancellation, nonzero exit, provider error/tool receipt and uncertain quiescence fail. No repair/fallback/retry/worker write occurs in this proof.

Observed Windows-triggered cancellation uses an owned WSL wrapper, process group manifest and abort marker. TERM then bounded KILL covers the CLI and an owned sleeping descendant; closure records list remaining members/quiescence. Killing only `wsl.exe` is excluded. Deterministic settlement faults prove valid-looking partial text cannot become a decision. This is a cancellation strategy for R1 to integrate, not a change to existing `generateText` behavior.

R0 must freeze correlation/capability/cancellation DTOs and the catalog adaptation. R1 owns record/provenance/UTF-8/compaction bounds, managed-policy preflight, version/selection capability validation and bridge instrumentation. R2/R3 and #528/R4 retain analysis/paste races, counters, attention, normal panel/Peek, restart, approvals and final packaged Windows backend + WSL CLI QA with ordered screenshots in Downloads. This Node/backend harness is actual cross-OS evidence, **not** packaged Electron/UI evidence. No desktop build, UI screenshot, full suite or release was performed here.

## Sources

[Claude hook common fields](https://code.claude.com/docs/en/hooks#common-input-fields) document prompt_id from 2.1.196; [Stop input](https://code.claude.com/docs/en/hooks#stop-input) warns about final transcript lag. [CLI reference](https://code.claude.com/docs/en/cli-reference) and installed help establish the candidate controls. [Official Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents selection/tool configuration; [developer settings](https://learn.chatgpt.com/docs/developer-settings) documents strict-config and precedence. Installed help/features/catalog were also read; documentation alone was not treated as an effective roster.

[Codex protocol at the pinned release](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/protocol.rs) defines task_complete identity/error. The registration table names exact pinned source paths and starting lines; [model metadata](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/openai_models.rs) defines Disabled shell and optional patch/tool-mode fields. Installed effective diagnostics and live calls corroborate the gates. Source review is not inferred from model refusal.
