# Claude Code Fast Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fast mode to the claude-code provider — a composer toggle and `/fast` command that enable Claude's high-speed serving via the CLI `fastMode` setting, at runtime (no restart) and at spawn.

**Architecture:** A dedicated `fastMode: boolean | null` runtime control. UI toggles persist to the session store and, when the session is running, send a `set_fast_mode` WebSocket message → `ProcessManager.sendSetFastMode` → `apply_flag_settings` control_request on the CLI's stdin (reusing the existing `writeControlRequest` fallback that `set_model`/`set_permission_mode` use). At spawn, `fastMode:true` is merged into the single `--settings` JSON alongside ultracode. Codex's existing `serviceTier` fast mode is untouched except a shared shortcut rename.

**Tech Stack:** TypeScript, Next.js, Zustand store, WebSocket control protocol, node:test via `npx tsx --test` (run in WSL with Node 22 on PATH).

**Spec:** `docs/superpowers/specs/2026-06-13-claude-fast-mode-design.md`

**Test command (WSL, repo root):** `npx tsx --test tests/<file>` · **Typecheck:** `npx tsc --noEmit`

---

## File Structure

**New files:**
- `src/lib/chat/claude-fast-command.ts` — Claude `/fast` command constants + skill predicate.
- `tests/claude-code-fast-mode-args.test.ts` — getCliArgs `--settings` merge behavior.
- `tests/claude-fast-mode-contract.test.mjs` — wiring contract across all layers.

**Modified (by layer):**
- Types: `src/lib/session/session-control-types.ts`, `src/types/chat.ts`, `src/lib/cli/process-types.ts`, `src/lib/cli/provider-session-option-types.ts`, `src/lib/settings/provider-defaults.ts`.
- Model metadata: `src/lib/cli/provider-session-option-definitions.ts`.
- Adapter / PM: `src/lib/cli/providers/claude-code/adapter.ts`, `src/lib/cli/process-manager.ts`.
- Transport: `src/lib/ws/message-types.ts`, `src/lib/ws/client.ts`, `src/hooks/use-websocket.ts`, `src/lib/ws/server-message-routing.ts`.
- UI: `src/components/chat/composer-session-controls.tsx`, `src/components/chat/message-input.tsx`, `src/hooks/use-skill-picker.ts`.
- Store: `src/stores/session-store.ts`, `src/hooks/use-session-crud.ts`.
- Spawn threading: `src/lib/ws/server-session-actions.ts`, `src/lib/session/session-orchestrator-lifecycle.ts`.
- Shortcut rename: `src/lib/keyboard/registry.ts`, `src/lib/i18n/types.ts`, `src/lib/i18n/{en,ko,ja,zh}.ts`, `tests/codex-fast-mode-contract.test.mjs`.

---

## Task 1: Core `fastMode` type fields + `supportsFastMode` model metadata

**Files:**
- Modify: `src/lib/session/session-control-types.ts:21-28`
- Modify: `src/types/chat.ts` (UnifiedSession, near `serviceTier`)
- Modify: `src/lib/cli/process-types.ts` (ProcessInfo, near `serviceTier`)
- Modify: `src/lib/cli/provider-session-option-types.ts` (ProviderModelOption)
- Modify: `src/lib/settings/provider-defaults.ts` (ProviderSessionRuntimeConfig interface)
- Modify: `src/lib/cli/provider-session-option-definitions.ts` (CLAUDE_MODELS)

- [ ] **Step 1: Add `fastMode` to `ProviderRuntimeControls`**

In `src/lib/session/session-control-types.ts`, add the field after `serviceTier`:

```ts
export interface ProviderRuntimeControls {
  sessionMode?: ProviderSessionMode;
  accessMode?: ProviderSessionAccessMode;
  collaborationMode?: CodexCollaborationMode;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
  serviceTier?: string | null;
  /** Claude Code high-speed serving toggle. null/false = off. */
  fastMode?: boolean | null;
}
```

- [ ] **Step 2: Add `fastMode` to `UnifiedSession`**

In `src/types/chat.ts`, locate `serviceTier?: string | null;` in `UnifiedSession` and add directly after it:

```ts
  fastMode?: boolean | null;
```

- [ ] **Step 3: Add `fastMode` to `ProcessInfo`**

In `src/lib/cli/process-types.ts`, locate `serviceTier?: string | null;` in `ProcessInfo` and add directly after it:

```ts
  fastMode?: boolean | null;
```

- [ ] **Step 4: Add `supportsFastMode` to `ProviderModelOption`**

In `src/lib/cli/provider-session-option-types.ts`, add to `ProviderModelOption` after `serviceTiers?`:

```ts
  /** Claude models that support the fast-mode (high-speed) toggle. */
  supportsFastMode?: boolean;
```

- [ ] **Step 5: Add `fastMode` to `ProviderSessionRuntimeConfig`**

In `src/lib/settings/provider-defaults.ts`, add to the `ProviderSessionRuntimeConfig` interface after `serviceTier?`:

```ts
  fastMode?: boolean | null;
```

- [ ] **Step 6: Mark Opus 4.8/4.7/4.6 as supporting fast mode**

In `src/lib/cli/provider-session-option-definitions.ts`, add `supportsFastMode: true` to each of these `CLAUDE_MODELS` entries: `claude-opus-4-8`, `claude-opus-4-8[1m]`, `claude-opus-4-7`, `claude-opus-4-7[1m]`, `claude-opus-4-6`, `claude-opus-4-6[1m]`. Example for the first two:

```ts
  {
    value: 'claude-opus-4-8',
    label: 'claude-opus-4-8',
    isDefault: false,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_ULTRACODE,
    supportsFastMode: true,
  },
  {
    value: 'claude-opus-4-8[1m]',
    label: 'claude-opus-4-8[1m]',
    isDefault: true,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_ULTRACODE,
    supportsFastMode: true,
  },
```

Do NOT add it to Sonnet or Haiku entries.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing errors, if any, unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/lib/session/session-control-types.ts src/types/chat.ts src/lib/cli/process-types.ts src/lib/cli/provider-session-option-types.ts src/lib/settings/provider-defaults.ts src/lib/cli/provider-session-option-definitions.ts
git commit -m "feat(fast-mode): add fastMode runtime-control field + supportsFastMode model metadata"
```

---

## Task 2: getCliArgs merges `fastMode` into a single `--settings` (spawn-time)

**Files:**
- Test: `tests/claude-code-fast-mode-args.test.ts` (create)
- Modify: `src/lib/cli/providers/claude-code/adapter.ts:168-208`

- [ ] **Step 1: Write the failing test**

Create `tests/claude-code-fast-mode-args.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeAdapter } from '../src/lib/cli/providers/claude-code/adapter';

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

test('fastMode alone emits a single --settings {"fastMode":true}', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '11111111-1111-1111-1111-111111111111',
    model: 'claude-opus-4-8',
    fastMode: true,
  });
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1, `expected one --settings; got: ${args.join(' ')}`);
  assert.equal(JSON.parse(settings[0]).fastMode, true);
});

test('fastMode + ultracode merge into ONE --settings object', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '22222222-2222-2222-2222-222222222222',
    model: 'claude-opus-4-8',
    reasoningEffort: 'ultracode',
    fastMode: true,
  });
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1, `expected one merged --settings; got: ${args.join(' ')}`);
  const parsed = JSON.parse(settings[0]);
  assert.equal(parsed.ultracode, true);
  assert.equal(parsed.fastMode, true);
  assert.ok(!valuesOf(args, '--effort').includes('ultracode'));
});

test('fastMode + plain effort: --effort flag AND --settings fastMode', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '33333333-3333-3333-3333-333333333333',
    model: 'claude-opus-4-8',
    reasoningEffort: 'high',
    fastMode: true,
  });
  assert.deepEqual(valuesOf(args, '--effort'), ['high']);
  const settings = valuesOf(args, '--settings');
  assert.equal(settings.length, 1);
  assert.equal(JSON.parse(settings[0]).fastMode, true);
  assert.equal(JSON.parse(settings[0]).ultracode, undefined);
});

test('no fastMode and no ultracode: no --settings injected', () => {
  const args = claudeCodeAdapter.getCliArgs({
    sessionId: '44444444-4444-4444-4444-444444444444',
    model: 'claude-opus-4-8',
    reasoningEffort: 'auto',
  });
  assert.equal(valuesOf(args, '--settings').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/claude-code-fast-mode-args.test.ts`
Expected: FAIL (current code injects `--settings` only for ultracode; fastMode ignored).

- [ ] **Step 3: Implement the merge in getCliArgs**

In `src/lib/cli/providers/claude-code/adapter.ts`, change the destructure (line ~169) to include `fastMode`:

```ts
    const { sessionId, resume, permissionMode, model, reasoningEffort, fastMode } = options;
```

Replace the current ultracode/effort block (lines ~196-205) with:

```ts
    // Settings booleans (ultracode, fastMode) are session-scoped and merged into a
    // SINGLE --settings object — never pass --settings twice. ultracode is not an
    // --effort value (the CLI rejects `--effort ultracode`); fastMode is orthogonal
    // to effort and enables Claude's high-speed serving on supported models.
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

- [ ] **Step 4: Run new test + existing ultracode args test**

Run: `npx tsx --test tests/claude-code-fast-mode-args.test.ts tests/claude-code-ultracode-args.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add tests/claude-code-fast-mode-args.test.ts src/lib/cli/providers/claude-code/adapter.ts
git commit -m "feat(fast-mode): merge fastMode into single --settings in claude getCliArgs"
```

---

## Task 3: Runtime control — `ProcessManager.sendSetFastMode` + ProcessInfo wiring

**Files:**
- Test: `tests/claude-fast-mode-contract.test.mjs` (create)
- Modify: `src/lib/cli/process-manager.ts` (ProcessInfo init ~line 66, `tryUpdateProviderSessionConfig` ~line 144, add `sendSetFastMode` after `sendSetServiceTier` ~line 420)

- [ ] **Step 1: Write the failing contract test (process-manager block)**

Create `tests/claude-fast-mode-contract.test.mjs`:

```mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const processManagerSource = read('src/lib/cli/process-manager.ts');

test('ProcessManager.sendSetFastMode sends apply_flag_settings control_request', () => {
  assert.match(processManagerSource, /sendSetFastMode\(sessionId: string, fastMode: boolean \| null\): boolean/);
  assert.match(processManagerSource, /subtype: 'apply_flag_settings', settings: \{ fastMode: fastMode === true \? true : null \}/);
  assert.match(processManagerSource, /info\.fastMode = fastMode/);
  assert.match(processManagerSource, /if \(patch\.fastMode !== undefined\) \{\s*info\.fastMode = patch\.fastMode;/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs`
Expected: FAIL (symbols absent).

- [ ] **Step 3: Initialize `ProcessInfo.fastMode` at process creation**

In `src/lib/cli/process-manager.ts`, where `ProcessInfo` is created (the object literal with `serviceTier: spawnOptions.serviceTier`, ~line 66), add directly after that line:

```ts
      fastMode: spawnOptions.fastMode,
```

- [ ] **Step 4: Sync `info.fastMode` in `tryUpdateProviderSessionConfig`**

In the success branch of `tryUpdateProviderSessionConfig` (where it sets `info.serviceTier = patch.serviceTier`, ~line 167), add after the serviceTier sync:

```ts
        if (patch.fastMode !== undefined) {
          info.fastMode = patch.fastMode;
        }
```

- [ ] **Step 5: Add `sendSetFastMode` after `sendSetServiceTier`**

In `src/lib/cli/process-manager.ts`, immediately after the `sendSetServiceTier` method (~line 420), add:

```ts
  /**
   * Toggle Claude Code fast mode at runtime. Providers implementing
   * updateSessionConfig (Codex) receive the patch; Claude Code falls through to
   * an apply_flag_settings control_request on stdin (no restart). Disable = null.
   */
  sendSetFastMode(sessionId: string, fastMode: boolean | null): boolean {
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
      if (info) {
        info.fastMode = fastMode;
      }
      logger.info({ sessionId, fastMode }, 'apply_flag_settings (fastMode) sent to CLI');
    }
    return sent;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/claude-fast-mode-contract.test.mjs src/lib/cli/process-manager.ts
git commit -m "feat(fast-mode): ProcessManager.sendSetFastMode via apply_flag_settings control_request"
```

---

## Task 4: WebSocket transport (`set_fast_mode`)

**Files:**
- Modify: `src/lib/ws/message-types.ts:81`
- Modify: `src/lib/ws/client.ts:284`
- Modify: `src/hooks/use-websocket.ts:99`
- Modify: `src/lib/ws/server-message-routing.ts:283`
- Modify (add block): `tests/claude-fast-mode-contract.test.mjs`

- [ ] **Step 1: Add the transport contract block (failing)**

Append to `tests/claude-fast-mode-contract.test.mjs`:

```mjs
test('set_fast_mode has websocket + routing paths', () => {
  const wsMessageTypesSource = read('src/lib/ws/message-types.ts');
  const wsClientSource = read('src/lib/ws/client.ts');
  const wsHookSource = read('src/hooks/use-websocket.ts');
  const routingSource = read('src/lib/ws/server-message-routing.ts');

  assert.match(wsMessageTypesSource, /type: 'set_fast_mode'/);
  assert.match(wsClientSource, /setFastMode\(sessionId: string, fastMode: boolean \| null\)/);
  assert.match(wsClientSource, /this\.sendRequest\('set_fast_mode', \{ sessionId, fastMode \}\)/);
  assert.match(wsHookSource, /setFastMode/);
  assert.match(routingSource, /case 'set_fast_mode':/);
  assert.match(routingSource, /processManager\.sendSetFastMode\(sessionId, message\.fastMode\)/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "websocket"`
Expected: FAIL.

- [ ] **Step 3: Add the message type**

In `src/lib/ws/message-types.ts`, in the `ClientMessage` union next to the `set_service_tier` variant, add:

```ts
  | { type: 'set_fast_mode'; requestId: string; sessionId: string; fastMode: boolean | null }
```

- [ ] **Step 4: Add the client method**

In `src/lib/ws/client.ts`, after `setServiceTier` (~line 284):

```ts
  setFastMode(sessionId: string, fastMode: boolean | null) {
    this.sendRequest('set_fast_mode', { sessionId, fastMode });
  }
```

- [ ] **Step 5: Expose via the hook**

In `src/hooks/use-websocket.ts`, mirror the `setServiceTier` callback (~line 99) and add `setFastMode` to the returned object:

```ts
  const setFastMode = useCallback((sessionId: string, fastMode: boolean | null) => {
    wsClient.setFastMode(sessionId, fastMode);
  }, []);
```

Add `setFastMode` to the hook's return value next to `setServiceTier`.

- [ ] **Step 6: Route on the server**

In `src/lib/ws/server-message-routing.ts`, after the `case 'set_service_tier':` block (~line 283), add:

```ts
    case 'set_fast_mode':
      runProcessManagerControlAction({
        userId,
        sendToUser,
        sessionId: message.sessionId,
        action: (sessionId) =>
          processManager.sendSetFastMode(sessionId, message.fastMode),
        errorCode: 'set_fast_mode_failed',
        errorMessage: 'Failed to set fast mode',
        logMessage: 'Set fast mode requested',
        logMetadata: { fastMode: message.fastMode },
      });
      break;
```

(If the surrounding `case` blocks do not use `break` because each `return`s, match the local style instead.)

- [ ] **Step 7: Run to verify it passes + typecheck**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "websocket"`
Then: `npx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ws/message-types.ts src/lib/ws/client.ts src/hooks/use-websocket.ts src/lib/ws/server-message-routing.ts tests/claude-fast-mode-contract.test.mjs
git commit -m "feat(fast-mode): set_fast_mode websocket message + server routing"
```

---

## Task 5: UI — toggle + `/fast` for claude-code

**Files:**
- Create: `src/lib/chat/claude-fast-command.ts`
- Modify: `src/hooks/use-skill-picker.ts:54`
- Modify: `src/components/chat/message-input.tsx` (executeClaudeFastCommand + 3 interception points ~735, ~846, ~1006)
- Modify: `src/components/chat/composer-session-controls.tsx` (helpers ~411/467, handler ~574, state ~699-701, button ~783)
- Modify (add block): `tests/claude-fast-mode-contract.test.mjs`

- [ ] **Step 1: Add the UI contract block (failing)**

Append to `tests/claude-fast-mode-contract.test.mjs`:

```mjs
test('claude-code fast mode toggle + /fast are wired', () => {
  const composer = read('src/components/chat/composer-session-controls.tsx');
  const messageInput = read('src/components/chat/message-input.tsx');
  const skillPicker = read('src/hooks/use-skill-picker.ts');
  const claudeFastCmd = read('src/lib/chat/claude-fast-command.ts');

  // toggle branches for claude-code on a fastMode boolean
  assert.match(composer, /session\.fastMode === true/);
  assert.match(composer, /isClaudeCodeProvider/);
  assert.match(composer, /setFastMode\(sessionId/);
  assert.match(composer, /updateSessionRuntimeConfig\(sessionId, \{ fastMode/);

  // /fast command for claude-code
  assert.match(claudeFastCmd, /CLAUDE_FAST_BUILTIN_COMMAND = 'claude-fast'/);
  assert.match(skillPicker, /providerId === 'claude-code'/);
  assert.match(messageInput, /executeClaudeFastCommand/);
  assert.match(messageInput, /isClaudeFastCommandSkill/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "claude-code fast"`
Expected: FAIL.

- [ ] **Step 3: Create the Claude fast-command module**

Create `src/lib/chat/claude-fast-command.ts` (reuses the shared `/fast` literal from the Codex module so the command text stays identical; only the builtin id discriminates):

```ts
import { CODEX_FAST_COMMAND, CODEX_FAST_COMMAND_NAME } from './codex-fast-command';

/** The `/fast` command is shared text; provider is disambiguated by builtinCommand id. */
export const CLAUDE_FAST_COMMAND = CODEX_FAST_COMMAND;
export const CLAUDE_FAST_COMMAND_NAME = CODEX_FAST_COMMAND_NAME;
export const CLAUDE_FAST_COMMAND_DESCRIPTION = 'Toggle Claude fast mode (high-speed) for this session';
export const CLAUDE_FAST_BUILTIN_COMMAND = 'claude-fast';

interface ClaudeFastCommandLike {
  builtinCommand?: string;
}

export function isClaudeFastCommandSkill(skill: ClaudeFastCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CLAUDE_FAST_BUILTIN_COMMAND;
}
```

> First read `src/lib/chat/codex-fast-command.ts` to confirm the exact exported names (`CODEX_FAST_COMMAND`, `CODEX_FAST_COMMAND_NAME`). If `CODEX_FAST_COMMAND_NAME` is not exported, export it there (additive, keeps Codex test green).

- [ ] **Step 4: Offer `/fast` in the skill picker for claude-code**

In `src/hooks/use-skill-picker.ts` (~line 54), the `builtInCommands` memo currently returns the Codex commands only when `providerId === 'codex'`. Extend it to also return a `/fast` entry for claude-code. Read the current memo, then add a branch:

```ts
      providerId === 'claude-code'
        ? [{
            name: CLAUDE_FAST_COMMAND_NAME,
            description: CLAUDE_FAST_COMMAND_DESCRIPTION,
            builtinCommand: CLAUDE_FAST_BUILTIN_COMMAND,
          }]
        : []
```

Add the import: `import { CLAUDE_FAST_COMMAND_NAME, CLAUDE_FAST_COMMAND_DESCRIPTION, CLAUDE_FAST_BUILTIN_COMMAND } from '@/lib/chat/claude-fast-command';` and include `providerId` in the memo deps. Match the existing `SkillInfo` shape (mirror the Codex entry's fields exactly).

- [ ] **Step 5: Add `executeClaudeFastCommand` + interception in message-input**

In `src/components/chat/message-input.tsx`:

1. Import: `import { CLAUDE_FAST_COMMAND, isClaudeFastCommandSkill } from '@/lib/chat/claude-fast-command';` and pull `setFastMode` from the websocket hook (next to the existing `setServiceTier`).
2. Add a handler mirroring `executeCodexFastCommand` (read it first, ~line 634) but for claude-code + fastMode:

```ts
  const executeClaudeFastCommand = useCallback((): boolean => {
    if (session?.provider?.trim() !== 'claude-code') {
      return false;
    }
    const next = !(session.fastMode === true);
    updateSessionRuntimeConfig(sessionId, { fastMode: next });
    if (sessionIsRunning) {
      setFastMode(sessionId, next);
    }
    clearInput();
    clearAttachments();
    clearSessionRefs();
    skillPicker.clearSkill();
    toast.info(next ? 'Claude fast mode enabled' : 'Claude fast mode disabled');
    return true;
  }, [session, sessionId, sessionIsRunning, setFastMode, clearInput, clearAttachments, clearSessionRefs, skillPicker]);
```

3. At the three Codex `/fast` interception points, add a claude-code branch right after the Codex one:
   - `handleSend` (~735): after the Codex `if (... CODEX_FAST_COMMAND ...) { if (executeCodexFastCommand()) return; }`, add a parallel check using `isClaudeFastCommandSkill(confirmedSkill)` / `trimmed === CLAUDE_FAST_COMMAND` that calls `if (executeClaudeFastCommand()) return;`.
   - `handleSkillSelect` (~846): after `if (isCodexFastCommandSkill(skill)) {...}`, add `if (isClaudeFastCommandSkill(skill)) { executeClaudeFastCommand(); textareaRef.current?.focus(); return; }`.
   - `handleKeyDown` Enter (~1006): extend the `inputValue.trim() === CODEX_FAST_COMMAND` guard to also fire `executeClaudeFastCommand()` for claude-code sessions (the command text is identical, so branch on `session?.provider`).

   Read each block first and mirror its exact structure; `CLAUDE_FAST_COMMAND === CODEX_FAST_COMMAND` (same `/fast` text), so where the text check already matches, only the execution target differs by provider.

- [ ] **Step 6: Generalize the composer toggle for claude-code**

In `src/components/chat/composer-session-controls.tsx` (read the relevant sections first):

1. Add a provider helper near `isCodexProvider` (~line 411):

```ts
function isClaudeCodeProvider(providerId: string): boolean {
  return providerId === 'claude-code';
}
```

2. Compute current-model fast support (near where `sessionOptions`/current model is resolved). Use the resolved model option's `supportsFastMode`:

```ts
  const currentModelSupportsFastMode = Boolean(
    sessionOptions?.modelOptions?.find((m) => m.value === session.model)?.supportsFastMode,
  );
```

(Match how the file already looks up the current model option; reuse that lookup if one exists.)

3. Replace `isFastModeEnabled` / `canToggleFastMode` (~699-701):

```ts
  const isFastModeEnabled =
    (isCodexProvider(providerIdForSticky) && session.serviceTier === CODEX_FAST_SERVICE_TIER) ||
    (isClaudeCodeProvider(providerIdForSticky) && session.fastMode === true);
  const canToggleFastMode =
    isCodexProvider(providerIdForSticky) ||
    (isClaudeCodeProvider(providerIdForSticky) && currentModelSupportsFastMode);
```

4. Replace `handleFastModeToggle` (~574) to branch by provider:

```ts
  const handleFastModeToggle = useCallback(() => {
    if (isCodexProvider(providerIdForSticky)) {
      const nextServiceTier = session.serviceTier === CODEX_FAST_SERVICE_TIER
        ? null
        : CODEX_FAST_SERVICE_TIER;
      updateSessionRuntimeConfig(sessionId, { serviceTier: nextServiceTier });
      if (session.isRunning) {
        wsClient.setServiceTier(sessionId, nextServiceTier);
      }
      focusSessionInput(sessionId);
      return;
    }
    if (isClaudeCodeProvider(providerIdForSticky) && currentModelSupportsFastMode) {
      const next = !(session.fastMode === true);
      updateSessionRuntimeConfig(sessionId, { fastMode: next });
      if (session.isRunning) {
        wsClient.setFastMode(sessionId, next);
      }
      focusSessionInput(sessionId);
    }
  }, [providerIdForSticky, session.serviceTier, session.fastMode, session.isRunning, sessionId, currentModelSupportsFastMode]);
```

(Match the existing deps/imports; `focusSessionInput`, `updateSessionRuntimeConfig`, `wsClient` are already in scope for the Codex version.)

5. `resolveFastModeToggleTitle` (~467): make it provider-aware, e.g. accept the provider id and return "Claude fast mode is on/off" vs "Codex fast mode is on/off". Update the call site accordingly. The `ComposerToggleButton` (~783) already reads `isFastModeEnabled` / `handleFastModeToggle` / `canToggleFastMode`; no structural change needed there besides the shortcut id (Task 6).

- [ ] **Step 7: Run the UI contract block + typecheck**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "claude-code fast"`
Then: `npx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/chat/claude-fast-command.ts src/hooks/use-skill-picker.ts src/components/chat/message-input.tsx src/components/chat/composer-session-controls.tsx tests/claude-fast-mode-contract.test.mjs
git commit -m "feat(fast-mode): claude-code composer toggle + /fast command"
```

---

## Task 6: Rename shortcut `toggle-codex-fast-mode` → `toggle-fast-mode`

**Files:**
- Modify: `src/lib/keyboard/registry.ts:27`
- Modify: `src/lib/i18n/types.ts` (`toggleCodexFastMode` → `toggleFastMode`)
- Modify: `src/lib/i18n/en.ts`, `ko.ts`, `ja.ts`, `zh.ts`
- Modify: `src/components/chat/composer-session-controls.tsx` (shortcut usage)
- Modify: `tests/codex-fast-mode-contract.test.mjs` (shortcut assertions)

- [ ] **Step 1: Rename the registry entry**

In `src/lib/keyboard/registry.ts:27`, rename the key and its `descKey`:

```ts
  'toggle-fast-mode': { default: '$mod+Alt+f', category: 'input', descKey: 'shortcut.toggleFastMode' },
```

- [ ] **Step 2: Rename the i18n type key**

In `src/lib/i18n/types.ts`, change `toggleCodexFastMode: string;` → `toggleFastMode: string;`.

- [ ] **Step 3: Rename in all 4 locale files**

In each of `src/lib/i18n/en.ts`, `ko.ts`, `ja.ts`, `zh.ts`, rename the `toggleCodexFastMode` key under `shortcut` to `toggleFastMode`. Update the label copy to be provider-neutral (e.g. EN: `'Toggle fast mode'`; keep each language's existing translation, dropping "Codex").

- [ ] **Step 4: Update the composer usages**

In `src/components/chat/composer-session-controls.tsx`, replace `useEffectiveShortcut('toggle-codex-fast-mode')` → `useEffectiveShortcut('toggle-fast-mode')`, `shortcutId="toggle-codex-fast-mode"` → `shortcutId="toggle-fast-mode"`, and `t('shortcut.toggleCodexFastMode')` → `t('shortcut.toggleFastMode')`.

- [ ] **Step 5: Update the Codex contract test assertions**

In `tests/codex-fast-mode-contract.test.mjs`, update the shortcut test to the new names:

```mjs
  assert.match(keyboardRegistrySource, /'toggle-fast-mode':\s*\{ default: '\$mod\+Alt\+f'/);
  assert.match(keyboardRegistrySource, /descKey: 'shortcut\.toggleFastMode'/);
  assert.match(i18nTypesSource, /toggleFastMode: string;/);
  assert.match(composerSessionControlsSource, /const fastModeShortcut = useEffectiveShortcut\('toggle-fast-mode'\);/);
  assert.match(composerSessionControlsSource, /shortcutId="toggle-fast-mode"/);
```

(Keep the other assertions; the `descKey: 'shortcut.toggleCodexFastMode'` line is the one that changes.)

- [ ] **Step 6: Run both contract tests + typecheck**

Run: `npx tsx --test tests/codex-fast-mode-contract.test.mjs tests/claude-fast-mode-contract.test.mjs`
Then: `npx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/keyboard/registry.ts src/lib/i18n/types.ts src/lib/i18n/en.ts src/lib/i18n/ko.ts src/lib/i18n/ja.ts src/lib/i18n/zh.ts src/components/chat/composer-session-controls.tsx tests/codex-fast-mode-contract.test.mjs
git commit -m "refactor(fast-mode): rename toggle-codex-fast-mode -> toggle-fast-mode (shared shortcut)"
```

---

## Task 7: Persistence — store wiring + claude-code default OFF

**Files:**
- Modify: `src/stores/session-store.ts` (Picks ~43/48, spread ~795, map ~124)
- Modify: `src/hooks/use-session-crud.ts` (~203)
- Modify: `src/lib/settings/provider-defaults.ts` (getProviderSessionRuntimeConfig ~293, normalizeUserSettings claude-code ~519)
- Modify (add block): `tests/claude-fast-mode-contract.test.mjs`

- [ ] **Step 1: Add the persistence contract block (failing)**

Append to `tests/claude-fast-mode-contract.test.mjs`:

```mjs
test('session store + claude-code defaults persist fastMode', () => {
  const sessionStore = read('src/stores/session-store.ts');
  const providerDefaults = read('src/lib/settings/provider-defaults.ts');

  assert.match(sessionStore, /'fastMode'/);
  assert.match(sessionStore, /runtimeConfig\.fastMode !== undefined/);
  assert.match(sessionStore, /fastMode: runtimeConfig\.fastMode/);
  assert.match(sessionStore, /fastMode: 'fastMode' in s \? s\.fastMode : undefined/);
  assert.match(providerDefaults, /fastMode/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "persist fastMode"`
Expected: FAIL.

- [ ] **Step 3: Add `'fastMode'` to both store Pick types**

In `src/stores/session-store.ts`, add `'fastMode'` to the `Pick<UnifiedSession, ...>` unions at line ~43 and ~48:

```ts
runtimeConfig?: Pick<UnifiedSession, 'model' | 'reasoningEffort' | 'serviceTier' | 'fastMode' | 'sessionMode' | 'accessMode'>,
```
```ts
runtimeConfig: Partial<Pick<UnifiedSession, 'model' | 'reasoningEffort' | 'serviceTier' | 'fastMode' | 'sessionMode' | 'accessMode'>>,
```

- [ ] **Step 4: Spread `fastMode` in `updateSessionRuntimeConfig`**

In `src/stores/session-store.ts`, next to the `serviceTier` spread (~line 795), add for BOTH spread sites (markSessionRunning ~762 and updateSessionRuntimeConfig ~807):

```ts
                ...(runtimeConfig.fastMode !== undefined && {
                  fastMode: runtimeConfig.fastMode,
                }),
```

- [ ] **Step 5: Map `fastMode` from API session**

In `mapApiSessionToUnified` (~line 124), next to the `serviceTier` mapping, add:

```ts
    fastMode: 'fastMode' in s ? s.fastMode : undefined,
```

- [ ] **Step 6: Carry `fastMode` through createSession result**

In `src/hooks/use-session-crud.ts`, next to `serviceTier: result.serviceTier` (~line 203), add:

```ts
          fastMode: result.fastMode,
```

- [ ] **Step 7: Return + default fastMode in provider-defaults**

In `src/lib/settings/provider-defaults.ts`:
- In `getProviderSessionRuntimeConfig` (~293), ensure the returned object includes `fastMode` for claude-code. Mirror how `serviceTier` is resolved (via `resolveProviderRuntimeControls`), or add `fastMode` to the returned literal.
- In `normalizeUserSettings`, the `'claude-code'` defaults block (~519): add `fastMode: false` (default OFF).

```ts
'claude-code': { model, reasoningEffort, sessionMode, accessMode, fastMode: false },
```

- [ ] **Step 8: Run persistence block + typecheck**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "persist fastMode"`
Then: `npx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 9: Commit**

```bash
git add src/stores/session-store.ts src/hooks/use-session-crud.ts src/lib/settings/provider-defaults.ts tests/claude-fast-mode-contract.test.mjs
git commit -m "feat(fast-mode): persist fastMode in session store; claude-code default off"
```

---

## Task 8: Spawn-time threading (server → orchestrator → SpawnOptions)

**Files:**
- Modify: `src/lib/ws/server-session-actions.ts` (mirror every `serviceTier` site: ~126, ~150, ~177, ~475, ~506-508, ~518, ~535, ~550)
- Modify: `src/lib/session/session-orchestrator-lifecycle.ts` (3 spawn-option objects ~229/259/286 + running-state ~299)
- Modify (add block): `tests/claude-fast-mode-contract.test.mjs`

- [ ] **Step 1: Add the spawn-threading contract block (failing)**

Append to `tests/claude-fast-mode-contract.test.mjs`:

```mjs
test('fastMode is threaded through spawn options', () => {
  const serverActions = read('src/lib/ws/server-session-actions.ts');
  const orchestrator = read('src/lib/session/session-orchestrator-lifecycle.ts');

  assert.match(serverActions, /fastMode/);
  assert.match(orchestrator, /fastMode: options\.fastMode/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "threaded through spawn"`
Expected: FAIL.

- [ ] **Step 3: Thread `fastMode` in server-session-actions**

In `src/lib/ws/server-session-actions.ts`, read the file and mirror `serviceTier` at every site with `fastMode`:
- The destructures (~124-128, ~533-535): add `fastMode,`.
- The forwarded option objects (~148-152, ~543-551): add `fastMode,`.
- The conditional spreads (~177): add `...(fastMode !== undefined && { fastMode }),`.
- The started-config read (~473-475): add `fastMode: spawnConfig?.fastMode,`.
- The started-value resolve + response spread (~506-518): add
  `const startedFastMode = result.fastMode !== undefined ? result.fastMode : spawnConfig?.fastMode;`
  and `...(startedFastMode !== undefined && { fastMode: startedFastMode }),`.

Confirm the `spawnConfig` / message type carries `fastMode` (it does once `ProviderRuntimeControls` includes it from Task 1; if a local interface re-declares the fields, add `fastMode?: boolean | null` there).

- [ ] **Step 4: Thread `fastMode` in the orchestrator**

In `src/lib/session/session-orchestrator-lifecycle.ts`, add `fastMode: options.fastMode,` to each of the three spawn-option objects that currently set `serviceTier: options.serviceTier,` (~229, ~259, ~286), and add `fastMode: options.fastMode,` to the `status: 'running'` state object next to `serviceTier: options.serviceTier,` (~299).

Verify the spawn helper's options-bag parameter type includes `fastMode` (it inherits from `ProviderRuntimeControls`; if it uses an explicit inline type, add `fastMode?: boolean | null`).

- [ ] **Step 5: Run spawn block + typecheck**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs --test-name-pattern "threaded through spawn"`
Then: `npx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ws/server-session-actions.ts src/lib/session/session-orchestrator-lifecycle.ts tests/claude-fast-mode-contract.test.mjs
git commit -m "feat(fast-mode): thread fastMode through spawn options (server + orchestrator)"
```

---

## Task 9: Full verification

**Files:** none (verification only) unless fixups are needed.

- [ ] **Step 1: Run the full contract + args suites**

Run: `npx tsx --test tests/claude-fast-mode-contract.test.mjs tests/codex-fast-mode-contract.test.mjs tests/claude-code-fast-mode-args.test.ts tests/claude-code-ultracode-args.test.ts`
Expected: all PASS. Codex contract must stay green (only the shortcut names changed).

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no new errors vs. baseline.

- [ ] **Step 3: Lint the touched files (if the repo lints in CI)**

Run: `npx eslint src/lib/cli/process-manager.ts src/lib/cli/providers/claude-code/adapter.ts src/components/chat/composer-session-controls.tsx src/components/chat/message-input.tsx`
Expected: no new errors.

- [ ] **Step 4: Manual end-to-end verification**

Use the `verifier-tessera-web` skill (launches the Next.js dev server + drives the browser). Verify, for an Opus 4.8 claude-code session:
1. The "Fast" toggle is visible (and hidden when the model is switched to Sonnet/Haiku).
2. Clicking it flips the pressed state; on a running session the CLI receives an `apply_flag_settings` control_request with `settings.fastMode === true` (check the raw CLI log / stdin sink). Toggling off sends `fastMode: null`.
3. Typing `/fast` toggles it identically and shows the toast.
4. `$mod+Alt+f` toggles it.
5. A session started with fast mode on spawns with `--settings` containing `"fastMode":true` (check spawn args log).
6. Codex `/fast` and its toggle still work unchanged.

- [ ] **Step 5: Final commit (if fixups were made)**

```bash
git add -A
git commit -m "test(fast-mode): full-suite verification + fixups"
```

---

## Notes & gotchas (carry into execution)

- **Disable = `null`** in the control_request `settings`, never `false` (matches CLI binary behavior).
- **One `--settings` only** — ultracode + fastMode merge into a single object.
- **Model gate**: the toggle and `/fast` should only act for claude-code models with `supportsFastMode`; the CLI also silently ignores `fastMode` on unsupported models as a backstop.
- **Codex is untouched** behaviorally: `serviceTier`, `codex-fast-command.ts`, and Codex `/fast` keep working; only the shortcut id/i18n key were generalized.
- **No DB column** for `fastMode` (mirrors Codex `serviceTier`): the persisted client store re-sends it via spawn options. Server-side DB persistence is out of scope for v1.
- If any `assert.match` regex in the contract test does not match your final code spelling, adjust the regex to the real code (the test asserts intent, not a frozen string) — but keep the asserted behavior.
