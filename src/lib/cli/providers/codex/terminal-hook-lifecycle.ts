import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';

export type CodexHookOrigin = 'lead' | 'subagent' | 'unknown';
export type CodexHookLifecycleStatus = 'running' | 'completed' | 'input_required' | 'idle';

interface CodexTerminalLifecycle {
  turnEnded: boolean;
}

const ROLLOUT_HEADER_MAX_BYTES = 64 * 1024;
const ORIGIN_CACHE_MAX_ENTRIES = 512;
const rolloutOriginByPath = new Map<string, Exclude<CodexHookOrigin, 'unknown'>>();

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Codex collaboration children inherit the lead's session_id, so that field
 * cannot identify hook ownership. Their own rollout header is authoritative:
 * session_meta.payload.thread_source is `subagent` while the lead is `user`.
 */
export async function classifyCodexHookOrigin(
  payload: Record<string, unknown>,
  environment: AgentEnvironment,
): Promise<CodexHookOrigin> {
  if (readString(payload.agent_id) || readString(payload.agentId)) return 'subagent';

  const reportedPath = readString(payload.transcript_path ?? payload.transcriptPath);
  if (!reportedPath) return 'unknown';

  try {
    const transcriptPath = await resolveAgentReportedPath(reportedPath, environment);
    if (path.extname(transcriptPath).toLowerCase() !== '.jsonl') return 'unknown';
    const cached = rolloutOriginByPath.get(transcriptPath);
    if (cached) return cached;
    const descriptor = await fs.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(ROLLOUT_HEADER_MAX_BYTES);
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
      if (!firstLine) return 'unknown';
      const record = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: Record<string, unknown>;
      };
      if (record.type !== 'session_meta') return 'unknown';
      const threadSource = readString(record.payload?.thread_source);
      const legacySource = readString(record.payload?.source);
      if (threadSource !== 'user' && threadSource !== 'subagent' && !legacySource) {
        return 'unknown';
      }
      // Codex <=0.146 lead rollouts predate thread_source and identify their
      // creator through source (for example `vscode`). Collaboration rollouts
      // carry the authoritative subagent thread_source in newer releases.
      const origin = threadSource === 'subagent' ? 'subagent' : 'lead';
      rolloutOriginByPath.set(transcriptPath, origin);
      if (rolloutOriginByPath.size > ORIGIN_CACHE_MAX_ENTRIES) {
        const oldestPath = rolloutOriginByPath.keys().next().value;
        if (oldestPath) rolloutOriginByPath.delete(oldestPath);
      }
      return origin;
    } finally {
      await descriptor.close();
    }
  } catch {
    // Keep ownership unknown so an unreadable child rollout cannot replace the
    // lead identity or revive a completed turn. Later hooks retry the read.
    return 'unknown';
  }
}

/**
 * Keeps the foreground Codex turn separate from collaboration-child traffic.
 * A completed lead leaves a tombstone so delayed fire-and-forget child hooks
 * cannot recreate a running turn that has no later Stop to close it.
 */
export class CodexHookLifecycleTracker {
  private readonly terminals = new Map<string, CodexTerminalLifecycle>();

  apply(
    terminalId: string,
    event: string,
    origin: CodexHookOrigin,
  ): { status: CodexHookLifecycleStatus } | null {
    if (origin === 'unknown') {
      // Ownership-sensitive status cannot be inferred safely. In particular,
      // an unreadable child rollout must not open, close, or reset the lead.
      return null;
    }

    if (origin === 'subagent') {
      // Child hooks never own foreground state. The lead remains running until
      // its own Stop, and a child must not overwrite a lead permission prompt.
      return null;
    }

    if (event === 'SessionStart') {
      this.terminals.delete(terminalId);
      return { status: 'idle' };
    }

    if (event === 'UserPromptSubmit') {
      this.terminals.set(terminalId, { turnEnded: false });
      return { status: 'running' };
    }

    if (event === 'PermissionRequest') return { status: 'input_required' };

    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const state = this.terminals.get(terminalId);
      // Codex emits UserPromptSubmit as the explicit next-turn boundary. No
      // tool delivery after Stop may clear the tombstone, regardless of delay.
      if (state?.turnEnded) return null;
      if (!state) {
        this.terminals.set(terminalId, { turnEnded: false });
      }
      return { status: 'running' };
    }

    if (event === 'Stop') {
      this.terminals.set(terminalId, { turnEnded: true });
      return { status: 'completed' };
    }

    return null;
  }
}

const terminalHookLifecycle = new CodexHookLifecycleTracker();

export const CODEX_LIFECYCLE_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
]);

export function mapCodexHookLifecycle(
  terminalId: string,
  event: string,
  origin: CodexHookOrigin,
): { status: CodexHookLifecycleStatus } | null {
  return terminalHookLifecycle.apply(terminalId, event, origin);
}
