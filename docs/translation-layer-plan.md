# Translation Layer — Implementation Plan

Adds a per-message translation layer so a Korean user can type in Korean, have it
translated to English before it reaches the coding agent, let the agent run/output
in English, and read the agent's output translated back to Korean. Translation is
performed by invoking a user-configured CLI one-shot, mirroring the existing
**auto-title generation** mechanism.

## Confirmed behavior (product decisions)

- **Input**: Korean input → translated to **English** server-side before reaching the
  agent. The user's own bubble stays **Korean**; the English actually sent to the agent
  is also recorded and viewable ("show what was sent" affordance).
- **Output**: the agent streams **English live** (instant). After the turn completes,
  the finalized English message is translated **once** to Korean. Default view shows
  **Korean**, with a per-session "show original" toggle to reveal English.
- **Output timing**: translate **after turn completion**, never per chunk. English
  streams fully, then Korean is computed and the bubble content is swapped. A
  "translating…" indicator is shown while the English stays visible.
- **Model selection**: input and output translation each have their own
  **provider + model** (fully independent of the coding session and of each other).
  e.g. code with Opus while translating with a fast/cheap model.
- **Default**: disabled (opt-in). Zero cost/behavior change for everyone else.

## Reference pattern

Auto-title generation is the template: on turn completion it spawns the user's
configured CLI headless/read-only (stdin prompt → stdout JSON), parses the result,
appends to the session JSONL, and pushes to the UI over WebSocket.

- Core: `src/lib/session/ai-title-generator.ts`
- Auto trigger: `src/lib/cli/protocol-adapter-turn-lifecycle.ts:155-156` (gated `if (!result.isError)`)
- Manual route: `src/app/api/sessions/[id]/generate-title/route.ts`
- Per-provider impl: `CliProvider.generateTitle` (`provider-contract.ts:151`)
- Binary resolution: `resolveProviderCliCommand` (`provider-command.ts:18`) reading
  `settings.cliCommandOverrides[providerId][environment]`
- Spawn util: `spawnCli` (`spawn-cli.ts`)

## Data model

`src/lib/session-replay-types.ts`
- Add `messageId?: string` to the `assistant_message` event (stable id for attach).
- Add new append-only event:
  ```ts
  { v: number; type: 'message_translation'; timestamp: string;
    targetMessageId: string; content: string; sourceLang: string; targetLang: string }
  ```

`src/types/chat.ts` (`TextMessage`, line 27) — all optional, existing readers untouched:
```ts
translatedContent?: string;
translationStatus?: 'pending' | 'completed' | 'error';
translationLang?: string;
sentContent?: string;   // English actually sent to the agent (user messages)
```

`src/lib/cli/providers/session-types.ts` — `TranslatedText { text: string }` (mirrors `GeneratedTitle`).

No DB schema change — translations live in the JSONL source of truth.

## Settings

`src/lib/settings/types.ts`
```ts
translate: {
  enabled: boolean;
  sourceLanguage: Language;
  targetLanguage: Language;
  input:  { provider: string; model?: string };   // KO→EN ('' model = provider default)
  output: { provider: string; model?: string };   // EN→KO
}
```
`src/lib/settings/provider-defaults.ts`
- Default: `{ enabled:false, sourceLanguage:'ko', targetLanguage:'en',
  input:{provider:'claude-code',model:''}, output:{provider:'claude-code',model:''} }`.
- Explicit deep-merge of `translate` including nested `input`/`output` (mirror
  `notifications` merge ~line 621) so partial saves don't clobber sub-fields.

## CLI invocation (mirror auto-title)

`provider-contract.ts:151` — add sibling:
```ts
translateText(text: string, sourceLang: string, targetLang: string,
              userId?: string, model?: string): Promise<TranslatedText | null>
```
Per-provider impl copies `generateTitle`/`_callCli`, injecting the caller model:
- **claude-code** (`adapter.ts:347`): `spawnCli(cmd, ['-p', ...(model?['--model',model]:[]),
  '--output-format','json','--no-session-persistence','--effort','low'])`, strip
  `CLAUDECODE`/`CLAUDE_CODE_*`, cwd `/tmp`, 120s timeout, prompt via stdin, regex-parse `"translation"`.
- **codex** (`adapter.ts:1190`): `codex exec --json --skip-git-repo-check --sandbox read-only
  -c model_reasoning_effort="low"` plus `-c model="<model>"` when model set.
- **opencode** (`adapter.ts:513`): one-shot `opencode run --format json` **cannot inject a
  model** (model only via JSON-RPC `session/set_model` after handshake). Model is ignored
  (CLI default) and disabled in the UI when opencode is the translate provider.
- Prompt (fixed, like `ai-title-generator` `buildPrompt`): translate from src→tgt, output
  ONLY `{"translation":"..."}`, preserve markdown/code blocks verbatim, do not translate code.
  Language labels from `LANGUAGE_NAMES` (`skill-analysis-service.ts:50`).
- Failure → `try/catch` returns `null` (like `generateTitle`).

## Translation core

`src/lib/session/message-translator.ts` (new, mirrors `ai-title-generator.ts`)
- Takes a direction config (`translate.input` or `translate.output`); resolves the
  **configured** provider (NOT the session provider):
  `cliProviderRegistry.getProvider(cfg.provider)` +
  `resolveProviderCliCommand(cfg.provider, DEFAULT, agentEnv, userId)` → `translateText(..., cfg.model)`.
- Exactly-once triple guard: per-process `Set` (like `autoTitleTriggered`) +
  in-flight `generatingSet` + **durable**: check presence of the `message_translation`
  event in the JSONL before spawning.

## Input hook (KO→EN)

`src/lib/ws/server-session-actions.ts` — between `recordUserMessage(displayContent):272`
and `processManager.sendMessage(content):276`:
- If `translate.enabled && src!==tgt`: translate the plain-text portion of `content`
  (string, or `TextContentBlock.text` parts of `ContentBlock[]`; leave image/skill/file
  blocks untouched) via the core using `translate.input`. Forward English to `sendMessage`.
- `recordUserMessage` stays Korean (bubble stays Korean). Record `sentContent` (English)
  on the `user_message` event for the transparency affordance.
- Skill command branch (`/skill ...`, lines 280-303): translate only `skillText`.
  `/fast`, `/goal` are client-side control commands and never reach here.
- **Fail-open**: on null/error, forward the original Korean unchanged + `logger.warn`.

## Output hook (EN→KO) + stable id

`src/lib/cli/protocol-adapter-turn-lifecycle.ts:156` — next to `maybeAutoGenerateTitle`,
same `if (!result.isError)` gate: `maybeTranslateAssistantMessage(sessionId, userId)`
(fire-and-forget). It reads the finalized assistant text (`flushSession` + `readEvents`
with the same 3×/5s retry as `ai-title-generator` for JSONL write-lag), gates on
`translate.enabled`, translates via the core using `translate.output`, appends a
`message_translation` event (never rewrites the original line), and broadcasts it over WS.

Stable id: `src/lib/session/session-history.ts` `flushAssistant` (~line 427) generates a
`messageId` (uuid) written into the `assistant_message` event; `message_translation.targetMessageId`
references it.

## Live-attach fix (critical — re-key on finalize)

During streaming the chat-store message has a `uuidv4()` id (`apply-session-replay-events.ts:173`).
The finalized `assistant_message` does NOT re-key it, so a translation keyed by the stable
id won't attach live (Korean would only appear after reload). Fix:
1. Live path `apply-session-replay-events.ts:148` `assistant_message` case: re-key the last
   streaming assistant text message to `event.messageId` via a new chat-store action
   `finalizeAssistantMessageId(sessionId, messageId)`.
2. Reload path `session-replay-reducer.ts:350`: use `event.messageId` instead of
   `hist-assistant-${length}`.
3. Both reducers handle `message_translation` via upsert-by-id (the `tool_call` pattern at
   `session-replay-reducer.ts:101-128`), attaching `translatedContent`.

## Client — store, reducers, render, toggle

`src/stores/chat-store.ts` (mirror `updateToolCall`, line 173)
- `attachMessageTranslation(sessionId, targetMessageId, { translatedContent, translationStatus, translationLang })`
- `finalizeAssistantMessageId(sessionId, messageId)`

Reducers — add `message_translation` case in both `session-replay-reducer.ts` and
`apply-session-replay-events.ts`.

Render `src/components/chat/message-bubble-content.tsx:385` (`AssistantTextBody`, shared by
standalone `AssistantMessage` and grouped `AgentSubGroupView`):
- Toggle on + translation exists → render `translatedContent`, else `content` (English),
  same `MarkdownContent`.
- `translationStatus==='pending'` → inline "translating…" (English stays visible).
  `'error'` → silent fallback to English.

Toggle (per-session) — `message-input.tsx:1091` `SkillQuickAccessBar.trailingContent`
(translate/original pill, `ComposerSessionControls` pattern). State persisted in chat-store
to survive virtualization remounts.

Memo — `message-bubble.tsx:56` `text` case must also compare `translatedContent` +
`translationStatus`, and the toggle is passed as a memo-busting prop, or late translations
silently don't render.

Input transparency — user bubble shows a collapsible "show sent English" when `sentContent` exists.

Optional manual re-translate — button in the existing copy/fork action row →
`POST /api/sessions/[id]/translate` (mirrors `generate-title/route.ts`).

## Settings UI

`src/components/settings/translate-settings.tsx` (new, mirrors `notification-settings.tsx` /
`appearance-settings.tsx` select pattern); registered as a `<SettingsCard>` in
`settings-panel.tsx`.
- Enable toggle + source/target language selects.
- Two blocks ("Input translation" / "Output translation"), each = provider `<select>` +
  model `<select>`. Model options from `useProviderSessionOptions(cfg.provider).modelOptions`
  plus a "default" empty option. opencode → model select disabled + note.
- Warn when a chosen translate provider has no `cliCommandOverrides` binary configured.
- i18n: add `settings.translate.*` and `chat.showOriginal/showTranslation/translating` keys
  to `lib/i18n/types.ts` AND all four locales (en/ko/ja/zh) or the build breaks.

## Robustness

- Concurrency: one-shot spawns bypass `MAX_PROCESSES`; add a small per-user/session serial
  queue (backpressure) to avoid stacking CLI processes.
- Code preservation: prompt preserves code fences; consider skipping code-only messages.
  "Show original" is the safety net.
- Exactly-once: triple guard (above) prevents re-translation on re-render/reconnect/replay.
- Provider availability: if a chosen translate provider's binary is unavailable or fails,
  fail-open (input forwards Korean, output keeps English) + `logger.warn`.

## Tests (`tests/`)

Exactly-once (no duplicate spawn), input/output fail-open fallback, translation survives
reload, live-attach (re-key) works, settings deep-merge, memo re-render.

## Work order (~6 days)

1. Data model (types/events) — 0.5d
2. `translateText` on 3 providers + translation core — 1d
3. Input hook (+ `sentContent`) — 0.5d
4. Output hook + stable `messageId` + WS — 1d
5. Live-attach fix (re-key) — 1d
6. Client store/reducer/render/toggle/memo — 1d
7. Settings (input/output provider+model) + i18n + backpressure — 1d
8. Tests — 0.5d

## Open items / caveats

- No backfill: `messageId` only on new messages → past messages aren't attached (acceptable).
- opencode can't take a model in one-shot translation (uses default).
- Latency: a cold CLI start per direction (≤120s timeout). Choosing a light model per
  direction mitigates this; a dedicated lightweight translate provider is a future option.
