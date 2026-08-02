/**
 * 슬래시 피커에 노출하지 않는 명령 — CLI가 headless로 지원한다고 보고(`initialize.commands`)
 * 하더라도 Tessera GUI에서는 의미가 성립하지 않는 것들.
 *
 * `/clear` (claude-code): 터미널에서 이 명령은 "화면과 컨텍스트를 함께 비우고 새 대화로
 * 갈아타기"다. Tessera에는 비울 화면이 없다 — 컨텍스트만 초기화되고 지난 대화 기록은
 * 화면에 그대로 남아, 모델이 더는 기억하지 못하는 내용을 사용자는 여전히 눈으로 보게 된다.
 * 게다가 CLI는 리셋과 함께 새 세션 ID로 갈아타므로(`conversation_reset` → 새 `system/init`)
 * Tessera가 아는 세션 ID는 초기화 이전 대화를 가리키게 된다. GUI에서 같은 목적은 새 세션
 * 생성이 담당한다.
 *
 * 이 목록은 `tui-only-commands.ts`와 반대 방향이다. 그쪽은 "헤드리스에서 못 하니 터미널로
 * 보낼 명령", 이쪽은 "헤드리스에서 되지만 GUI에 내보내지 않을 명령"이다.
 */
import { extractSlashCommandName } from '@/lib/terminal/tui-only-commands';

const HIDDEN_SLASH_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'claude-code': new Set(['clear']),
};

/** 해당 프로바이더에서 피커에 노출하지 않는 명령인지 판정한다. */
export function isHiddenSlashCommandName(
  name: string,
  providerId?: string | null,
): boolean {
  if (!providerId) return false;
  return HIDDEN_SLASH_COMMANDS[providerId]?.has(name.trim().toLowerCase()) ?? false;
}

/**
 * 입력 문자열이 숨긴 명령의 실행인지 판정한다 — 피커를 거치지 않고 직접 타이핑한 경로를
 * 막는 데 쓴다. 목록에서 감추기만 하면 `/clear`를 손으로 쳐서 CLI까지 보낼 수 있고,
 * 그러면 숨긴 이유였던 문제가 그대로 발생한다.
 *
 * 인자가 붙어도(`/clear foo`) 같은 명령이므로 함께 막는다. 반대로 `/clearance` 같은
 * 다른 이름은 걸리지 않는다 — 판정은 이름 완전 일치다.
 */
export function isHiddenSlashCommandInput(
  input: string,
  providerId?: string | null,
): boolean {
  const name = extractSlashCommandName(input);
  return name !== null && isHiddenSlashCommandName(name, providerId);
}
