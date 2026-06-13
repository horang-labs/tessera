# Claude Code Fast Mode — Design Spec

**Date:** 2026-06-13
**Status:** Approved (pending written-spec review)
**Author:** RS + Claude

## 1. Goal

Add "fast mode" support to the **claude-code** provider in Tessera, reaching UX parity
with the existing **Codex** fast-mode feature:

- A **toggle button** in the composer (like the current Codex one).
- A **`/fast` slash command** that toggles it.
- Applies at **runtime with no session restart**, and is **injected at spawn** when a
  session starts with fast mode already on.

## 2. Verified CLI mechanism (evidence)

The installed `claude` CLI (Bun-compiled binary) was inspected directly. Findings:

- `fastMode` is a **settings boolean**, registered in the CLI's `"Model & output"`
  settings group: `["model","fastMode","outputStyle",...]`.
- The CLI documents its own entry points verbatim: *"settings key (`--settings` or
  `apply_flag_settings`)."* So `fastMode` can be set **two** ways:
  - **Spawn:** `--settings '{"fastMode":true}'`
  - **Runtime:** `control_request { subtype: "apply_flag_settings", settings: { fastMode: true|null } }`
    — this is exactly what the interactive `/fast` command does
    (`controlRequest({subtype:"apply_flag_settings",settings:{fastMode:H?!0:null,...}})`).
- **Disable = `null`, not `false`** (matches the binary's `H?!0:null`).
- **Per-model gate:** models declare `supportsFastMode:true`. Unsupported models silently
  ignore the setting (same behavior as `ultracode`/xhigh). Supported: Opus 4.8 / 4.7 / 4.6.
- `fastMode` is **orthogonal to `effort`** — both travel in the same request
  (`{model, fastMode, effort, betas, ...}`). It controls output **speed** (high-speed
  serving tier), not thinking depth. It can coexist with any effort level and with ultracode.
- Fast mode "draws from usage credits at a higher rate; separate rate limits apply," and
  the CLI has an internal **cooldown / circuit-breaker** that auto-disables it when rate
  limited. Tessera just sends the setting; the CLI manages the breaker.

> **Correction to a prior research note:** an exploration agent claimed
> `apply_flag_settings` was "new / not implemented in the CLI — verify with CLI team."
> That is **false**. `apply_flag_settings` is a real control_request subtype present in the
> shipped binary, and its payload shape matches `writeControlRequest`'s envelope exactly.

## 3. Decisions

| Fork | Decision | Rationale |
|---|---|---|
| State representation | **Dedicated `fastMode: boolean \| null`** (not reuse of `serviceTier`) | `serviceTier` is a Codex/OpenAI string concept; Claude fast mode is a boolean. Clean types, no semantic overload. Codex keeps `serviceTier` untouched. |
| Apply timing | **Runtime toggle, no restart** | Matches Codex / "지금처럼". Uses the existing `writeControlRequest` path; also injected at spawn via `--settings`. |
| Keyboard shortcut name | **Generalize-rename** `toggle-codex-fast-mode` → `toggle-fast-mode` | One shortcut serves both providers; i18n key `toggleCodexFastMode` → `toggleFastMode`. Touches the Codex contract test (intentional). |
| Default state | **OFF** | Fast mode costs more credits / has separate rate limits → opt-in. |

## 4. Architecture & data flow

```
UI toggle  /  /fast command  /  $mod+Alt+f
  ├─ (always)   updateSessionRuntimeConfig(sessionId, { fastMode })   → store (persist)
  └─ (running)  wsClient.setFastMode(sessionId, fastMode)
                  → WS 'set_fast_mode'  → server-message-routing
                  → processManager.sendSetFastMode(sessionId, fastMode)
                  → writeControlRequest({ subtype:'apply_flag_settings',
                                          settings:{ fastMode: true|null } })  → CLI stdin

Spawn:  session.fastMode → SpawnOptions.fastMode → ClaudeCodeAdapter.getCliArgs()
        → merged into a single --settings '{"fastMode":true[,"ultracode":true]}'
```

**Key architectural win:** the runtime path needs **no new Claude-adapter method**.
`ProcessManager` already exposes a `writeControlRequest` fallback that `sendSetModel` and
`sendSetPermissionMode` use for Claude. `sendSetFastMode` mirrors them exactly. (An
exploration agent proposed adding `ClaudeCodeAdapter.updateSessionConfig`; that is
unnecessary and would diverge from how Claude runtime controls already work.)

## 5. Type changes (the `fastMode` field)

Add `fastMode?: boolean | null` to:

- `ProviderRuntimeControls` — `src/lib/session/session-control-types.ts:21`
  (provider-agnostic; `SpawnOptions` inherits it automatically).
- `UnifiedSession` — `src/types/chat.ts` (next to `serviceTier`, ~line 187).
- `ProcessInfo` — `src/lib/cli/process-types.ts` (next to `serviceTier`, ~line 50).
- `ProviderSessionRuntimeConfig` — `src/lib/settings/provider-defaults.ts:252`.

Add `supportsFastMode?: boolean` to:

- `ProviderModelOption` — `src/lib/cli/provider-session-option-types.ts:16`.

Nullable (`boolean | null`) so "unset" is distinguishable from "explicitly off", consistent
with `serviceTier`.

## 6. Spawn-time injection — `ClaudeCodeAdapter.getCliArgs`

File: `src/lib/cli/providers/claude-code/adapter.ts` (~lines 196–207). Restructure the
current ultracode-only `--settings` push so ultracode and fastMode **merge into one object**
(the CLI should receive a single `--settings` flag):

```ts
const { sessionId, resume, permissionMode, model, reasoningEffort, fastMode } = options;
// ...
const settings: Record<string, unknown> = {};
if (reasoningEffort === 'ultracode') {
  settings.ultracode = true;
} else if (reasoningEffort && reasoningEffort !== 'auto') {
  args.push('--effort', reasoningEffort);
}
if (fastMode === true) {
  settings.fastMode = true;
}
if (Object.keys(settings).length > 0) {
  args.push('--settings', JSON.stringify(settings));
}
```

Only inject when `fastMode === true`. Spawn never needs to inject the "off" case.

## 7. Runtime toggle — `ProcessManager.sendSetFastMode`

File: `src/lib/cli/process-manager.ts` (next to `sendSetServiceTier`, ~line 416). Mirror
`sendSetModel`:

```ts
sendSetFastMode(sessionId: string, fastMode: boolean | null): boolean {
  // Providers implementing updateSessionConfig (Codex) get the patch; Claude falls through.
  if (this.tryUpdateProviderSessionConfig(
    sessionId, { fastMode }, 'fast mode', { fastMode },
  )) {
    return true;
  }
  const sent = this.writeControlRequest(
    sessionId,
    { subtype: 'apply_flag_settings', settings: { fastMode: fastMode === true ? true : null } },
    'apply_flag_settings',
  );
  if (sent) {
    const info = this.processes.get(sessionId);
    if (info) info.fastMode = fastMode;
    logger.info({ sessionId, fastMode }, 'apply_flag_settings (fastMode) sent to CLI');
  }
  return sent;
}
```

`writeControlRequest(sessionId, request, ctx)` wraps `request` in
`{ type:'control_request', request_id, request }`, producing exactly the envelope the CLI
expects. Also extend `tryUpdateProviderSessionConfig` (~line 144) to sync
`info.fastMode` when `patch.fastMode !== undefined`, matching the `serviceTier` handling.
`ProcessInfo.fastMode` is initialized from `spawnOptions.fastMode` at process creation
(~line 66).

## 8. Transport (WebSocket)

Mirror the `set_service_tier` path with a boolean payload:

- `src/lib/ws/message-types.ts:81` — add to `ClientMessage` union:
  `| { type: 'set_fast_mode'; requestId: string; sessionId: string; fastMode: boolean | null }`
- `src/lib/ws/client.ts:284` — add `setFastMode(sessionId, fastMode)` →
  `this.sendRequest('set_fast_mode', { sessionId, fastMode })`.
- `src/hooks/use-websocket.ts:99` — expose `setFastMode` callback.
- `src/lib/ws/server-message-routing.ts:283` — add `case 'set_fast_mode'` →
  `runProcessManagerControlAction(... action: (id) => processManager.sendSetFastMode(id, message.fastMode) ...)`.

## 9. UI generalization

### 9a. Toggle — `src/components/chat/composer-session-controls.tsx`
Generalize the currently Codex-gated logic so it branches per provider:

- `canToggleFastMode` (line 701): `isCodexProvider(p) || (isClaudeCodeProvider(p) && currentModelSupportsFastMode)`.
  Add a helper `isClaudeCodeProvider` and read `supportsFastMode` from the current model
  option in `sessionOptions`.
- `isFastModeEnabled` (line 699): Codex → `serviceTier === CODEX_FAST_SERVICE_TIER`;
  claude-code → `session.fastMode === true`.
- `handleFastModeToggle` (line 574): branch — Codex keeps the `serviceTier` path;
  claude-code computes `next = !session.fastMode`, calls
  `updateSessionRuntimeConfig(sessionId, { fastMode: next })` and, when running,
  `wsClient.setFastMode(sessionId, next)`.
- `resolveFastModeToggleTitle` (line 467): provider-aware label text.
- Keyboard binding (line 727) + `ComposerToggleButton` (line 783): use the renamed
  `toggle-fast-mode` shortcut id; keep `controlId`/`testId` semantics (the button already
  reads generic `isFastModeEnabled`/`handleFastModeToggle`).

### 9b. `/fast` slash command
- New `src/lib/chat/claude-fast-command.ts`: `CLAUDE_FAST_BUILTIN_COMMAND = 'claude-fast'`
  and `isClaudeFastCommandSkill(skill)`. Reuse the shared `/fast` literal (the command name
  is generic; only the builtin id discriminates). **Leave `codex-fast-command.ts` untouched**
  so Codex behavior and its contract assertions stay intact.
- `src/hooks/use-skill-picker.ts:54` — extend `builtInCommands` so `providerId === 'claude-code'`
  also offers the `/fast` command (with `CLAUDE_FAST_BUILTIN_COMMAND`). Optionally gate on
  model `supportsFastMode`.
- `src/components/chat/message-input.tsx` — add `executeClaudeFastCommand()` (toggles
  `fastMode`, persists, sends `setFastMode` when running, toast "Claude fast mode
  enabled/disabled") and branch the three interception points (`handleSend` ~735,
  `handleKeyDown` Enter ~1006, `handleSkillSelect` ~846) by provider. Keep the existing
  `executeCodexFastCommand` for Codex.

### 9c. Shortcut rename (`toggle-codex-fast-mode` → `toggle-fast-mode`)
8 files: `src/lib/keyboard/registry.ts:27`, `src/lib/i18n/types.ts` (`toggleCodexFastMode`
→ `toggleFastMode`), the 4 locale files (`en.ts`, `ko.ts`, `ja.ts`, `zh.ts`),
`src/components/chat/composer-session-controls.tsx` (the `useEffectiveShortcut(...)` call +
`shortcutId`/`shortcutLabel`), and `tests/codex-fast-mode-contract.test.mjs` (update the two
shortcut assertions). Locale label copy may stay provider-neutral ("Toggle fast mode").

## 10. Model metadata
`src/lib/cli/provider-session-option-definitions.ts:156` — set `supportsFastMode: true` on
the Opus 4.8 / 4.7 / 4.6 entries of `CLAUDE_MODELS` (`claude-opus-4-8`, `claude-opus-4-8[1m]`,
`claude-opus-4-7`, `claude-opus-4-7[1m]`, `claude-opus-4-6`, `claude-opus-4-6[1m]`). Omit for
Sonnet/Haiku. `CLAUDE_MODELS` is a static curated list, so this is a one-line metadata add
per model — no CLI probing needed (unlike Codex `serviceTiers`).

## 11. Persistence & defaults
- `src/lib/settings/provider-defaults.ts`: add `fastMode` to `ProviderSessionRuntimeConfig`
  (252); return it from `getProviderSessionRuntimeConfig` (293) for claude-code; add
  `fastMode: false` to the `claude-code` block of `normalizeUserSettings` (519). **Default OFF.**
- `src/stores/session-store.ts`: add `'fastMode'` to both `Pick` lists (markSessionRunning 43,
  updateSessionRuntimeConfig 48); add an explicit spread
  `...(runtimeConfig.fastMode !== undefined && { fastMode: runtimeConfig.fastMode })` (~795);
  add `fastMode: 'fastMode' in s ? s.fastMode : undefined` in `mapApiSessionToUnified` (124).
- `src/hooks/use-session-crud.ts`: include `fastMode: result.fastMode` in the createSession
  result mapping (~203) if the API returns it.
- **Spawn threading:** verify the spot where `SpawnOptions` is assembled from session runtime
  config threads `fastMode` (it should flow automatically via the `ProviderRuntimeControls`
  spread, per the existing `serviceTier` precedent — confirm during implementation).

## 12. Testing (TDD)
- **`tests/claude-fast-mode-contract.test.mjs`** (new) — mirror the Codex contract:
  assert the `set_fast_mode` WS type, `client.setFastMode`, `use-websocket` exposure,
  routing case, `processManager.sendSetFastMode` + `writeControlRequest('apply_flag_settings')`,
  `ProviderRuntimeControls.fastMode`, the composer toggle branching + `testId="fast-mode-toggle"`,
  the `/fast` claude path, store persistence, and `supportsFastMode` on Opus models.
- **`tests/claude-code-fast-mode-args.test.ts`** (new) — `getCliArgs`: (a) `fastMode:true`
  alone → `--settings {"fastMode":true}`; (b) `fastMode:true` + `reasoningEffort:'ultracode'`
  → single `--settings {"ultracode":true,"fastMode":true}`; (c) unset → no `--settings`;
  (d) `fastMode:true` + `effort:'high'` → `--effort high` **and** `--settings {"fastMode":true}`.
- **`sendSetFastMode` unit test** — assert the exact control_request envelope
  (`{type:'control_request',request_id,request:{subtype:'apply_flag_settings',settings:{fastMode:true}}}`)
  and that disable sends `settings.fastMode === null`.
- Run via `npx tsx --test` inside WSL (per repo test-harness note). Keep the existing Codex
  contract test green (only its two shortcut-name assertions change).

## 13. Edge cases & gotchas
- **Disable = `null`**, not `false`, in the control_request `settings`.
- **Single `--settings`** flag — never push it twice; merge ultracode + fastMode.
- **Model gate:** toggle hidden when current model lacks `supportsFastMode`; CLI also
  silently ignores it server-side as a backstop.
- **Cooldown/credits:** out of scope to surface in v1 UI; the CLI manages the circuit
  breaker. (Possible follow-up: reflect cooldown state in the toggle.)
- **Codex untouched:** `serviceTier`, `codex-fast-command.ts`, and the Codex `/fast`
  behavior stay exactly as-is; only the *shortcut name* is generalized.

## 14. Out of scope
- Migrating Codex onto the `fastMode` field.
- Surfacing fast-mode cooldown/rate-limit state in the UI.
- Any change to ultracode behavior beyond the `--settings` merge.

## 15. Files touched (summary)
Types: `session-control-types.ts`, `types/chat.ts`, `cli/process-types.ts`,
`provider-session-option-types.ts`, `settings/provider-defaults.ts`.
Adapter/PM: `claude-code/adapter.ts`, `cli/process-manager.ts`.
Transport: `ws/message-types.ts`, `ws/client.ts`, `hooks/use-websocket.ts`,
`ws/server-message-routing.ts`.
UI: `composer-session-controls.tsx`, `message-input.tsx`, `use-skill-picker.ts`,
`chat/claude-fast-command.ts` (new), model defs `provider-session-option-definitions.ts`,
store `session-store.ts`, `use-session-crud.ts`.
Shortcut rename: `keyboard/registry.ts`, `i18n/{types,en,ko,ja,zh}.ts`,
`composer-session-controls.tsx`, `tests/codex-fast-mode-contract.test.mjs`.
Tests: `claude-fast-mode-contract.test.mjs` (new), `claude-code-fast-mode-args.test.ts` (new).
