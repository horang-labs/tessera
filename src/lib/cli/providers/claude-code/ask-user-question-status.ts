/**
 * AskUserQuestion 도구의 hook 이벤트를 터미널 세션 상태로 분류한다.
 *
 * AskUserQuestion은 auto-allow 도구라 PermissionRequest를 내지 않고, Notification도
 * 발생하지 않는다(실측). 유일한 신호는 PreToolUse(tool_name="AskUserQuestion")이며,
 * 질문 카드가 뜬 동안 스피너 대신 "입력 대기"로 보여주기 위해 input_required로
 * 매핑한다. 답변이 제출되면 PostToolUse가 와서 running으로 복귀한다.
 *
 * hook 등록은 matcher "AskUserQuestion"으로 좁혀져 있지만, 사용자 전역 설정의
 * 광역 matcher와 병합될 수 있으므로 tool_name을 방어적으로 재검사한다.
 */

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** payload.tool_input.questions[0].question — 알림 preview용 질문 본문. */
function firstQuestionPreview(payload: Record<string, unknown>): string | undefined {
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null) return undefined;
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const question = readString((first as Record<string, unknown>).question);
  return question || undefined;
}

export function classifyAskUserQuestionEvent(
  event: string,
  payload: Record<string, unknown>,
): { status: 'input_required' | 'running'; preview?: string } | null {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return null;
  if (readString(payload.tool_name) !== ASK_USER_QUESTION_TOOL) return null;
  if (event === 'PreToolUse') {
    return { status: 'input_required', preview: firstQuestionPreview(payload) };
  }
  return { status: 'running' };
}
