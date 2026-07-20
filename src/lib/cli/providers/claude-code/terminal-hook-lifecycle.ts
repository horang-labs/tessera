export type ClaudeHookLifecycleStatus = 'running' | 'completed' | 'idle';

interface ClaudeTerminalLifecycle {
  activeSubagentIds: Set<string>;
  leadStoppedWithBackground: boolean;
  /**
   * 마지막 턴이 completed로 닫힌 뒤인지. hook은 fire-and-forget curl이라 턴 종료 후에도
   * 후처리 워커의 SubagentStart/Stop이 늦게 도착할 수 있고, 상태를 지워버리면 그 이벤트가
   * getOrCreate로 턴을 되살려 다음 입력까지 running에 갇힌다. 묘비로 남겨 선별적으로 무시한다.
   */
  turnEnded: boolean;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hasTaskRegistry(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.background_tasks) || Array.isArray(payload.session_crons);
}

/**
 * 스피너를 잡아야 하는 registry 항목은 에이전트 작업(subagent/teammate)뿐이다.
 * 백그라운드 셸 작업(dev 서버·워처 등 장수 프로세스)과 session_crons(예약된 미래 작업)는
 * "연산 중"이 아니므로 잡지 않는다 — 잡으면 프로세스가 사는 동안 스피너가 영원히 돈다.
 * 알 수 없는 type도 잡지 않는다: 이르게 초록이 되는 쪽이 영원히 도는 쪽보다 덜 해롭다.
 */
function isAgentWorkEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const type = readString((value as Record<string, unknown>).type);
  return type === 'subagent' || type === 'teammate';
}

function registryHasPendingWork(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.background_tasks)
    && payload.background_tasks.some(isAgentWorkEntry);
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
      const state = this.getOrCreate(terminalId);
      state.leadStoppedWithBackground = false;
      state.turnEnded = false;
      return { status: 'running' };
    }

    if (event === 'SubagentStart') {
      const state = this.getOrCreate(terminalId);
      // 턴 종료 후의 후처리 워커(요약 생성 등)는 사용자 관점의 연산이 아니다.
      if (state.turnEnded) return null;
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) state.activeSubagentIds.add(agentId);
      return { status: 'running' };
    }

    if (event === 'TeammateIdle') {
      const state = this.terminals.get(terminalId);
      if (!state || state.turnEnded) return null;
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
      this.markTurnEnded(state);
      return { status: 'completed' };
    }

    if (event === 'SubagentStop') {
      const state = this.terminals.get(terminalId);
      // 모르는 터미널의 SubagentStop은 끝낼 작업이 없다 — 턴을 시작시키면 안 된다.
      if (!state || state.turnEnded) return null;
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) state.activeSubagentIds.delete(agentId);

      const hasPendingWork = registryHasPendingWork(payload) || state.activeSubagentIds.size > 0;
      if (state.leadStoppedWithBackground && !hasPendingWork) {
        this.markTurnEnded(state);
        return { status: 'completed' };
      }
      return { status: 'running' };
    }

    return null;
  }

  private markTurnEnded(state: ClaudeTerminalLifecycle): void {
    state.activeSubagentIds.clear();
    state.leadStoppedWithBackground = false;
    state.turnEnded = true;
  }

  private getOrCreate(terminalId: string): ClaudeTerminalLifecycle {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    const created: ClaudeTerminalLifecycle = {
      activeSubagentIds: new Set(),
      leadStoppedWithBackground: false,
      turnEnded: false,
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
