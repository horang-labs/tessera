export type ClaudeHookLifecycleStatus = 'running' | 'completed' | 'idle';

interface ClaudeTerminalLifecycle {
  activeSubagentIds: Set<string>;
  leadStoppedWithBackground: boolean;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hasTaskRegistry(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.background_tasks) || Array.isArray(payload.session_crons);
}

function registryHasPendingWork(payload: Record<string, unknown>): boolean {
  return (Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0)
    || (Array.isArray(payload.session_crons) && payload.session_crons.length > 0);
}

/**
 * Claude can emit the lead Stop while background children are still alive.
 * Keep the terminal turn running until the task registry or child lifecycle
 * confirms that the pending work has drained.
 */
export class ClaudeHookLifecycleTracker {
  private readonly terminals = new Map<string, ClaudeTerminalLifecycle>();

  apply(
    terminalId: string,
    event: string,
    payload: Record<string, unknown>,
  ): { status: ClaudeHookLifecycleStatus } | null {
    if (event === 'SessionStart') {
      this.terminals.delete(terminalId);
      return { status: 'idle' };
    }

    if (event === 'UserPromptSubmit') {
      const state = this.terminals.get(terminalId);
      if (state) state.leadStoppedWithBackground = false;
      return { status: 'running' };
    }

    if (event === 'SubagentStart') {
      const state = this.getOrCreate(terminalId);
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) state.activeSubagentIds.add(agentId);
      return { status: 'running' };
    }

    if (event === 'TeammateIdle') {
      if (!this.terminals.has(terminalId)) return null;
      return { status: 'running' };
    }

    if (event === 'Stop') {
      const state = this.getOrCreate(terminalId);
      // A reachable Stop task registry is authoritative. This lets a later empty
      // Stop heal a missed SubagentStop; older Claude versions fall back to IDs.
      const hasPendingWork = hasTaskRegistry(payload)
        ? registryHasPendingWork(payload)
        : state.activeSubagentIds.size > 0;
      if (hasPendingWork) {
        state.leadStoppedWithBackground = true;
        return { status: 'running' };
      }
      this.terminals.delete(terminalId);
      return { status: 'completed' };
    }

    if (event === 'SubagentStop') {
      const state = this.getOrCreate(terminalId);
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) state.activeSubagentIds.delete(agentId);

      const hasPendingWork = registryHasPendingWork(payload) || state.activeSubagentIds.size > 0;
      if (state.leadStoppedWithBackground && !hasPendingWork) {
        this.terminals.delete(terminalId);
        return { status: 'completed' };
      }
      return { status: 'running' };
    }

    return null;
  }

  private getOrCreate(terminalId: string): ClaudeTerminalLifecycle {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    const created: ClaudeTerminalLifecycle = {
      activeSubagentIds: new Set(),
      leadStoppedWithBackground: false,
    };
    this.terminals.set(terminalId, created);
    return created;
  }
}

const terminalHookLifecycle = new ClaudeHookLifecycleTracker();

/** Process-lifetime Claude hook adapter used by the shared HTTP receiver. */
export function mapClaudeHookLifecycle(
  terminalId: string,
  event: string,
  payload: Record<string, unknown>,
): { status: ClaudeHookLifecycleStatus } | null {
  return terminalHookLifecycle.apply(terminalId, event, payload);
}
