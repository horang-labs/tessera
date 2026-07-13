/**
 * 미지원 슬래시 명령 fallback으로 터미널을 열 때, 최초 생성 1회에만 적용할
 * client-safe launch intent를 terminalId별로 잠깐 보관하는 ephemeral 맵.
 *
 * 패널 영속 메타(panel-store)에 넣지 않는 이유: 패널 재마운트/세션 리플레이 시
 * launch/prefill이 재실행되는 것을 방지하기 위함. terminal-panel이 마운트하며
 * take()로 소비하면 즉시 삭제된다.
 */

import type { TerminalLaunchIntent } from './types';

export interface PendingTerminalLaunch {
  intent: TerminalLaunchIntent;
  sourceSessionId?: string;
  locksSourceSession?: boolean;
}

const pendingLaunches = new Map<string, PendingTerminalLaunch>();
const pendingLaunchTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 마운트가 끝내 일어나지 않으면(예: 패널 생성 직후 탭 전환) take되지 않은 엔트리가
// 영구 잔류할 수 있으므로 일정 시간 후 자동 정리한다.
const PENDING_LAUNCH_TTL_MS = 60_000;

export function setPendingTerminalLaunch(
  terminalId: string,
  launch: PendingTerminalLaunch,
): void {
  const existingTimer = pendingLaunchTimers.get(terminalId);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  pendingLaunches.set(terminalId, launch);
  const timer = setTimeout(() => {
    if (pendingLaunchTimers.get(terminalId) !== timer) return;
    pendingLaunchTimers.delete(terminalId);
    pendingLaunches.delete(terminalId);
  }, PENDING_LAUNCH_TTL_MS);
  pendingLaunchTimers.set(terminalId, timer);
}

/** terminalId의 pending launch를 조회하고 즉시 제거한다(1회성 소비). */
export function takePendingTerminalLaunch(
  terminalId: string,
): PendingTerminalLaunch | undefined {
  const launch = pendingLaunches.get(terminalId);
  if (launch) {
    pendingLaunches.delete(terminalId);
    const timer = pendingLaunchTimers.get(terminalId);
    if (timer !== undefined) clearTimeout(timer);
    pendingLaunchTimers.delete(terminalId);
  }
  return launch;
}
