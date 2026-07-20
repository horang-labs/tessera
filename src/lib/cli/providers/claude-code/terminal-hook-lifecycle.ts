import {
  type SubagentRoster,
  upsertWorkingSubagent,
  markSubagentIdle,
  markTeammateIdleByName,
  rosterHasWorkingSubagent,
  readBackgroundAgentTasks,
  foldBackgroundTasksIntoRoster,
} from './claude-subagent-roster';

export type ClaudeHookLifecycleStatus = 'running' | 'completed' | 'idle';

interface ClaudeTerminalLifecycle {
  /**
   * subagent/teammate 명단. Set 카운터가 아니라 상태 있는 Map이라, lead Stop의
   * background_tasks 스냅샷을 fold해 이벤트 유실로 어긋난 상태를 교정할 수 있다.
   */
  subagents: SubagentRoster;
  /** lead가 Stop을 냈지만 child가 남아 아직 완료로 못 넘긴 상태. */
  leadStopped: boolean;
  /**
   * 마지막 턴이 completed로 닫힌 뒤인지. hook은 fire-and-forget curl이라 턴 종료 후에도
   * 후처리 워커의 SubagentStart/Stop이 늦게 도착할 수 있고, 상태를 지워버리면 그 이벤트가
   * getOrCreate로 턴을 되살려 다음 입력까지 running에 갇힌다. 묘비로 남겨 선별적으로 무시한다.
   */
  turnEnded: boolean;
  /** 턴이 completed로 닫힌 시각(ms). 재기동 턴 판정의 유예 기준. */
  turnEndedAt: number;
}

/**
 * 턴 종료 직후 이 유예 안에 도착한 PreToolUse는 그 턴의 마지막 도구가 늦게 배달된
 * curl(-m 2 타임아웃)일 수 있어 무시한다. 유예를 넘긴 PreToolUse는 백그라운드 작업
 * 완료로 Claude가 자동으로 깨어난 재기동 턴이다 — UserPromptSubmit 없이 시작되므로
 * 도구 이벤트가 유일한 활동 신호다.
 */
const REVIVED_TURN_GRACE_MS = 5_000;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Claude can emit the lead Stop while background children are still alive.
 * Keep the terminal turn running until the roster (reconciled against the Stop
 * payload's background_tasks) confirms the pending work has drained.
 */
export class ClaudeHookLifecycleTracker {
  private readonly terminals = new Map<string, ClaudeTerminalLifecycle>();

  apply(
    terminalId: string,
    event: string,
    payload: Record<string, unknown>,
    now = Date.now(),
  ): { status: ClaudeHookLifecycleStatus } | null {
    if (event === 'SessionStart') {
      this.terminals.delete(terminalId);
      return { status: 'idle' };
    }

    if (event === 'UserPromptSubmit') {
      const state = this.getOrCreate(terminalId);
      state.subagents.clear();
      state.leadStopped = false;
      state.turnEnded = false;
      return { status: 'running' };
    }

    if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const state = this.getOrCreate(terminalId);
      if (state.turnEnded) {
        // 재기동 턴 감지는 PreToolUse만 신뢰한다. PostToolUse는 턴 마지막 도구의
        // 완료 직후 Stop이 따라붙어 curl 역전 가능성이 크다.
        if (event !== 'PreToolUse' || now - state.turnEndedAt < REVIVED_TURN_GRACE_MS) {
          return null;
        }
        state.subagents.clear();
        state.leadStopped = false;
        state.turnEnded = false;
        return { status: 'running' };
      }
      // 진행 중 턴의 도구 활동. subagent 발 이벤트면 그 child가 살아있다는 증거다.
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) upsertWorkingSubagent(state.subagents, agentId);
      return { status: 'running' };
    }

    if (event === 'SubagentStart') {
      const state = this.getOrCreate(terminalId);
      // 턴 종료 후의 후처리 워커(요약 생성 등)는 사용자 관점의 연산이 아니다.
      if (state.turnEnded) return null;
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) upsertWorkingSubagent(state.subagents, agentId);
      return { status: 'running' };
    }

    if (event === 'SubagentStop') {
      const state = this.terminals.get(terminalId);
      // 모르는 터미널이나 종료된 턴의 SubagentStop은 끝낼 작업이 없다.
      if (!state || state.turnEnded) return null;
      const agentId = readString(payload.agent_id) || readString(payload.agentId);
      if (agentId) markSubagentIdle(state.subagents, agentId);
      return this.resolveAfterChildDrain(state, now);
    }

    if (event === 'TeammateIdle') {
      const state = this.terminals.get(terminalId);
      if (!state || state.turnEnded) return null;
      const teammateName = readString(payload.teammate_name) || readString(payload.teammateName);
      // idle 표시만 한다. TeammateIdle 자체는 완료 트리거가 아니다(살아있는 teammate가
      // 곧 다시 활동할 수 있다) — 이후 SubagentStop이나 다음 Stop의 reconcile이 완료를
      // 판정하며, 이 idle 표시가 그 판정에서 이 teammate를 빼 준다.
      if (teammateName) markTeammateIdleByName(state.subagents, teammateName);
      return { status: 'running' };
    }

    if (event === 'Stop' || event === 'StopFailure') {
      const state = this.getOrCreate(terminalId);
      // background_tasks가 있으면(present) 명단을 그 스냅샷으로 reconcile한다. 없으면
      // (older Claude builds) lifecycle로 증분 추적한 명단을 그대로 신뢰한다.
      const background = readBackgroundAgentTasks(payload);
      if (background.present) {
        foldBackgroundTasksIntoRoster(state.subagents, background.tasks);
      }
      if (rosterHasWorkingSubagent(state.subagents)) {
        state.leadStopped = true;
        return { status: 'running' };
      }
      this.markTurnEnded(state, now);
      return { status: 'completed' };
    }

    return null;
  }

  /** lead가 이미 Stop했고 명단에 working이 없으면 턴 완료. 아니면 계속 running. */
  private resolveAfterChildDrain(
    state: ClaudeTerminalLifecycle,
    now: number,
  ): { status: ClaudeHookLifecycleStatus } {
    if (state.leadStopped && !rosterHasWorkingSubagent(state.subagents)) {
      this.markTurnEnded(state, now);
      return { status: 'completed' };
    }
    return { status: 'running' };
  }

  private markTurnEnded(state: ClaudeTerminalLifecycle, now: number): void {
    state.subagents.clear();
    state.leadStopped = false;
    state.turnEnded = true;
    state.turnEndedAt = now;
  }

  private getOrCreate(terminalId: string): ClaudeTerminalLifecycle {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    const created: ClaudeTerminalLifecycle = {
      subagents: new Map(),
      leadStopped: false,
      turnEnded: false,
      turnEndedAt: 0,
    };
    this.terminals.set(terminalId, created);
    return created;
  }
}

const terminalHookLifecycle = new ClaudeHookLifecycleTracker();

/** apply()가 소유하는 이벤트 — 이들이 null을 반환하면 "의도적 무시"이므로
 *  hook-receiver의 범용 폴백(mapEventToStatus)으로 되살리면 안 된다. */
export const CLAUDE_LIFECYCLE_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'Stop',
  'StopFailure',
]);

/** Process-lifetime Claude hook adapter used by the shared HTTP receiver. */
export function mapClaudeHookLifecycle(
  terminalId: string,
  event: string,
  payload: Record<string, unknown>,
): { status: ClaudeHookLifecycleStatus } | null {
  return terminalHookLifecycle.apply(terminalId, event, payload);
}
