'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, CircleCheck, Copy, Puzzle, RefreshCw, TerminalSquare, Trash2 } from 'lucide-react';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import { TabIdContext } from '@/stores/panel-store';
import { useBoardStore } from '@/stores/board-store';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import { pasteInputToRunningTerminal } from '@/lib/terminal/terminal-surface-registry';
import { wsClient } from '@/lib/ws/client';
import {
  inspectTesseraCliSkill,
  removeTesseraCliSkill,
} from '@/lib/cli/tessera-cli-skill-client';
import type { TesseraCliSkillStatus } from '@/lib/cli/tessera-cli-skill';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProviderSkillOnboardingStore } from '@/stores/provider-skill-onboarding-store';

const COMPLETION_PREFIX = 'tessera-skill-done:';

function createSkillTerminalId(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `tessera-skill-setup-${suffix}`;
}

async function copySkillCommand(command: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    return false;
  }
}

export function consumeTesseraCliCompletion(
  buffered: string,
  chunk: string,
): { buffered: string; exitCode?: number } {
  const combined = `${buffered}${chunk}`;
  const match = combined.match(/tessera-skill-done:(\d+)/);
  return match
    ? { buffered: '', exitCode: Number(match[1]) }
    : { buffered: combined.slice(-128) };
}

const SKILL_STATE_LABEL: Record<TesseraCliSkillStatus['state'], string> = {
  'not-installed': 'Not installed',
  installed: 'Installed',
  'update-available': 'Update available',
  'setup-failed': 'Setup failed',
  conflict: 'Conflict',
};

export function TesseraCliSkillStatusBadge({
  state,
  pending = false,
}: {
  state: TesseraCliSkillStatus['state'];
  pending?: boolean;
}) {
  const ready = state === 'installed';
  return (
    <span
      data-testid="tessera-cli-skill-status"
      data-state={state}
      className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium', ready ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/12 text-amber-800 dark:text-amber-300')}
    >
      {ready ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
      {pending ? 'Checking' : SKILL_STATE_LABEL[state]}
    </span>
  );
}

function executionCommand(command: string, windowsNative: boolean): string {
  return windowsNative
    ? `${command}; $tesseraCode=$LASTEXITCODE; [Console]::Write(([char]27)+"]9;${COMPLETION_PREFIX}$tesseraCode"+([char]7))`
    : `(${command}); tessera_code=$?; printf '\\033]9;${COMPLETION_PREFIX}%s\\007' "$tessera_code"`;
}

export function TesseraCliSkillSetupPanel() {
  const environment = useSettingsStore((state) => state.settings.agentEnvironment);
  const windowsServer = useSettingsStore((state) => state.serverHostInfo?.platform === 'win32');
  const terminalCwd = useBoardStore((state) => state.selectedProjectDir);
  const terminalId = useRef(createSkillTerminalId()).current;
  const [status, setStatus] = useState<TesseraCliSkillStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completionBuffer = useRef('');

  const refresh = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setStatus(await inspectTesseraCliSkill());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [environment, refresh]);

  const command = status?.command
    ?? 'npx skills add https://github.com/horang-labs/tessera --skill tessera-cli --global';
  const preloadedCommand = useMemo(
    () => executionCommand(command, Boolean(windowsServer && environment === 'native')),
    [command, environment, windowsServer],
  );

  useEffect(() => {
    if (!terminalOpen) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (pasteInputToRunningTerminal(terminalId, preloadedCommand) || attempts >= 300) {
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [preloadedCommand, terminalId, terminalOpen]);

  useEffect(() => {
    if (!terminalOpen) return;
    return wsClient.subscribeServerMessages((message) => {
      if (message.type !== 'terminal_output' || message.terminalId !== terminalId) return;
      const completion = consumeTesseraCliCompletion(completionBuffer.current, message.data);
      completionBuffer.current = completion.buffered;
      if (completion.exitCode === undefined) return;
      if (completion.exitCode !== 0) setError(`Skill setup exited with code ${completion.exitCode}.`);
      void refresh();
    });
  }, [refresh, terminalId, terminalOpen]);

  const setup = useCallback(() => {
    setError(null);
    completionBuffer.current = '';
    setTerminalOpen(false);
    window.setTimeout(() => setTerminalOpen(true), 0);
  }, []);

  const remove = useCallback(async () => {
    if (!status) return;
    setPending(true);
    setError(null);
    try {
      setStatus(await removeTesseraCliSkill(status.agentEnvironment));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [status]);

  const state = status?.state ?? 'setup-failed';
  const ready = state === 'installed';
  const actionable = state === 'not-installed' || state === 'update-available' || state === 'setup-failed';
  const handleCopy = useCallback(async () => {
    const didCopy = await copySkillCommand(command);
    if (!didCopy) {
      setError('Clipboard access is unavailable. Select and copy the command manually.');
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [command]);

  return (
    <section data-testid="tessera-cli-skill-setup" data-state={state}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Puzzle className="h-4 w-4 text-(--text-secondary)" />
            <h3 className="font-medium text-(--text-primary)">tessera-cli skill</h3>
            <TesseraCliSkillStatusBadge state={state} pending={pending} />
          </div>
          <p className="mt-1 text-sm leading-6 text-(--text-secondary)">
            Optional Tessera controls for the agents you choose in the standard Skills CLI picker.
          </p>
          <p className="mt-1 text-xs text-(--text-muted)">
            Setup runs in {environment === 'wsl' ? 'WSL' : 'Native'} only. It never installs into the opposite environment.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={pending} aria-label="Re-check skill" className="rounded-lg p-2 hover:bg-(--sidebar-hover) disabled:opacity-50">
          <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-(--divider) bg-(--chat-bg)/70 p-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 text-xs">{command}</code>
        <button type="button" onClick={() => void handleCopy()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-(--divider) px-2.5 py-1.5 text-xs">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {status?.agents.length ? <p className="mt-2 text-xs text-(--text-muted)">Targets: {status.agents.join(', ')}</p> : null}
      {ready ? <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">The installed skill is up to date.</p> : null}
      {status?.message ? <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-300">{status.message}</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-(--error)">{error}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {actionable ? (
          <button type="button" onClick={setup} disabled={!terminalCwd} className="inline-flex items-center gap-2 rounded-xl bg-(--accent) px-3 py-2 text-xs font-semibold text-white disabled:opacity-45">
            <TerminalSquare className="h-3.5 w-3.5" />
            {terminalOpen ? 'Retry setup' : state === 'update-available' ? 'Update' : state === 'setup-failed' ? 'Retry' : 'Set up'}
          </button>
        ) : null}
        {(ready || state === 'update-available') ? (
          <button type="button" onClick={() => void remove()} disabled={pending} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-(--error) hover:bg-(--sidebar-hover)">
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        ) : null}
      </div>
      {!terminalCwd && actionable ? <p className="mt-2 text-xs text-(--warning)">Open a project before running setup.</p> : null}

      {terminalOpen && terminalCwd ? (
        <div className="mt-4" data-testid="tessera-cli-skill-terminal">
          <p className="mb-2 text-xs text-(--text-muted)">Press Enter to run this command in the selected Agent Environment.</p>
          <div className="h-72 overflow-hidden rounded-xl border border-(--divider)">
            <TabIdContext.Provider value="tessera-cli-skill-setup">
              <TerminalPanel panelId="tessera-cli-skill-terminal" terminalId={terminalId} terminalSessionId={null} terminalCwd={terminalCwd} runtimeOwnership="standalone" surfaceActive showHeader={false} />
            </TabIdContext.Provider>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function ProviderSkillSettings() {
  return <TesseraCliSkillSetupPanel />;
}

export function TesseraCliSkillOnboardingDialog() {
  const provider = useProviderSkillOnboardingStore((state) => state.provider);
  const environment = useProviderSkillOnboardingStore((state) => state.environment);
  const close = useProviderSkillOnboardingStore((state) => state.close);

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="tessera-cli-skill-onboarding">
        <DialogHeader onClose={close}>
          <DialogTitle>Set up tessera-cli for {provider}</DialogTitle>
        </DialogHeader>
        <p className="mb-4 text-sm text-(--text-secondary)">
          {provider} is running in {environment === 'wsl' ? 'WSL' : 'Native'}. The optional skill does not affect this Session.
        </p>
        <TesseraCliSkillSetupPanel />
      </DialogContent>
    </Dialog>
  );
}
