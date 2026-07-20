/**
 * Claude 터미널 세션의 subagent/teammate 명단(roster)과 그 조작.
 *
 * hook은 fire-and-forget curl이라 SubagentStart/SubagentStop이 유실·재정렬될 수
 * 있다. 이벤트 델타만 누적하면(Set 카운터) 드리프트가 나 스피너가 갇힌다. 그래서
 * lead Stop payload의 `background_tasks` 스냅샷을 명단에 fold해 실제 상태로 교정한다.
 *
 * 이 명단은 UI로 나가지 않는다 — "working child가 하나라도 있는가"를 판정하는
 * 서버 내부 구조다. (Orca의 out/shared/claude-subagent-roster.js를 판정 목적에
 * 맞게 축약 이식: agentType/description 등 UI 표시 필드는 생략.)
 */

export type SubagentState = 'working' | 'idle';

export interface TrackedSubagent {
  state: SubagentState;
  /**
   * 이 id를 background_tasks가 authoritative하게 관리하는지. lifecycle(SubagentStart)로
   * 들어온 항목은 background_tasks에 안 나타날 수 있어(특히 teammate) 부재로 강등하면
   * 안 된다. fold가 스스로 만든 항목만 표시해, 다음 fold에서 리스트에 빠지면 idle로
   * 강등하는 대상으로 삼는다.
   */
  backgroundTasksAuthoritative?: boolean;
}

export type SubagentRoster = Map<string, TrackedSubagent>;

/** wire 정규화의 id 상한과 동일. 상한 초과 id가 명단만 'working'으로 잡는 걸 막는다. */
const SUBAGENT_ID_MAX_LENGTH = 64;
/** pane당 명단 상한. runaway spawner 방어. */
const MAX_SUBAGENTS = 32;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** id를 working으로 upsert. 상한 초과 시 가장 오래된 idle을 쫓아내고 자리 확보. */
export function upsertWorkingSubagent(roster: SubagentRoster, id: string): void {
  if (id.length === 0 || id.length > SUBAGENT_ID_MAX_LENGTH) return;
  const existing = roster.get(id);
  if (existing) {
    existing.state = 'working';
    // 라이브 활동은 lifecycle 스트림이 이 id를 다시 소유한다는 증거다.
    // background_tasks 부재로 인한 강등을 멈춘다(fold가 필요 시 재표시한다).
    existing.backgroundTasksAuthoritative = undefined;
    return;
  }
  if (roster.size >= MAX_SUBAGENTS && !evictOldestIdle(roster)) return;
  roster.set(id, { state: 'working' });
}

/** 삽입 순서상 가장 오래된 idle 항목을 제거. 없으면 false. */
function evictOldestIdle(roster: SubagentRoster): boolean {
  for (const [id, tracked] of roster) {
    if (tracked.state === 'idle') {
      roster.delete(id);
      return true;
    }
  }
  return false;
}

export function markSubagentIdle(roster: SubagentRoster, id: string): void {
  const existing = roster.get(id);
  if (existing) existing.state = 'idle';
}

export function rosterHasWorkingSubagent(roster: SubagentRoster): boolean {
  for (const tracked of roster.values()) {
    if (tracked.state === 'working') return true;
  }
  return false;
}

export interface BackgroundAgentTask {
  id: string;
  running: boolean;
  teammate: boolean;
}

/**
 * hook payload의 `background_tasks` 중 에이전트 작업(subagent/teammate)만 읽는다.
 * dev 서버·워처 같은 셸 작업이나 예약 cron은 "연산 중"이 아니므로 제외한다.
 * `present: false`는 필드 자체가 없음/malformed(older Claude builds) — 호출자는
 * 명단을 비우지 말고 lifecycle로 추적한 기존 명단을 유지해야 한다.
 */
export function readBackgroundAgentTasks(
  payload: Record<string, unknown>,
): { present: boolean; tasks: BackgroundAgentTask[] } {
  const raw = payload['background_tasks'];
  if (!Array.isArray(raw)) return { present: false, tasks: [] };
  const tasks: BackgroundAgentTask[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== 'subagent' && obj.type !== 'teammate') continue;
    const id = readString(obj.id).trim();
    if (id.length === 0) continue;
    tasks.push({
      id,
      running: obj.status === 'running',
      teammate: obj.type === 'teammate',
    });
    if (tasks.length >= MAX_SUBAGENTS) break;
  }
  return { present: true, tasks };
}

/**
 * lead Stop의 background_tasks를 lifecycle 추적 명단에 fold한다. replace가 아니다:
 * teammate는 살아있는 동안 idle이어도 `status: running`으로 보고하고 그 task id가
 * SubagentStart/Stop의 agent_id와 다르므로, 리스트만으로 teammate working 여부를
 * 결정하거나 lifecycle 항목에 매핑할 수 없다. 명확한 신호만 취한다:
 *  - 빈 리스트는 살아있는 게 없다는 증거 → 명단 clear
 *  - id-exact 매치(one-shot subagent는 agent_id를 task id로 재사용) → 신뢰, run 상태 반영
 *  - 매치 안 되는 RUNNING non-teammate → 시작을 못 본 one-shot subagent(재시작 등)
 *    → 재생성해 pane이 child 살아있는데 done으로 읽는 걸 막음
 *  - task id로 알려진(authoritative) 항목이 리스트에 없으면 끝난 것 → idle로 강등
 */
export function foldBackgroundTasksIntoRoster(
  roster: SubagentRoster,
  tasks: BackgroundAgentTask[],
): void {
  if (tasks.length === 0) {
    roster.clear();
    return;
  }
  const listedIds = new Set<string>();
  for (const task of tasks) {
    listedIds.add(task.id);
    const existing = roster.get(task.id);
    if (existing) {
      existing.state = task.running ? 'working' : 'idle';
      continue;
    }
    if (task.teammate || !task.running) continue;
    upsertWorkingSubagent(roster, task.id);
    const created = roster.get(task.id);
    if (created) created.backgroundTasksAuthoritative = true;
  }
  for (const [id, tracked] of roster) {
    if (tracked.backgroundTasksAuthoritative && tracked.state === 'working' && !listedIds.has(id)) {
      tracked.state = 'idle';
    }
  }
}

/**
 * lifecycle agent id가 이름붙은 teammate에 속하는지. teammate id는 이름을
 * `a<name>-<hex>`로 임베드한다. 하이픈 없는 suffix를 요구해 teammate "rev"가
 * "rev-two"의 id(`arev-two-<hex>`)에 잘못 매치되는 걸 막는다.
 */
export function teammateIdMatchesName(id: string, name: string): boolean {
  const prefix = `a${name}-`;
  return id.startsWith(prefix) && !id.slice(prefix.length).includes('-');
}

/**
 * TeammateIdle(이름 기반)로 해당 teammate의 명단 항목을 idle로 표시한다.
 * 이름붙은 teammate는 `agent_id`에 이름을 임베드하므로 그 id 매칭만 쓴다.
 */
export function markTeammateIdleByName(roster: SubagentRoster, name: string): void {
  for (const [id, tracked] of roster) {
    if (teammateIdMatchesName(id, name)) tracked.state = 'idle';
  }
}
