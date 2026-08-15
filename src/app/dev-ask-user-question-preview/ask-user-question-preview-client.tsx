'use client';

/**
 * AskUserQuestion 패널 시각 확인용 하네스 (development 전용).
 *
 * 실제 패널은 CLI가 AskUserQuestion 툴을 호출해야 뜨기 때문에, 밀도/여백 같은
 * 순수 표시 변경을 확인하려면 매번 세션을 태워야 한다. 이 페이지는 같은 컴포넌트를
 * 고정된 질문 데이터로 렌더해서 채팅 본문이 얼마나 남는지 바로 보게 한다.
 */

import { AskUserQuestionFloatingPanel } from '@/components/chat/ask-user-question-floating-panel';
import { useSessionStore } from '@/stores/session-store';
import { usePromptDensityStore } from '@/stores/prompt-density-store';
import type { AskUserQuestionItem } from '@/types/cli-jsonl-schemas';

const SESSION_ID = 'preview-session';

const QUESTIONS: AskUserQuestionItem[] = [
  {
    header: '동작 형태',
    question: '/handoff를 쳤을 때 어떻게 동작해야 하나요?',
    multiSelect: false,
    options: [
      {
        label: '인자 없으면 시트, 있으면 즉시 (추천)',
        description:
          '/handoff → 기존 QuickCreate 시트를 열어 provider·컬렉션·실행모드를 고름. /handoff codex 프롬프트 → 시트 없이 바로 생성+주입. Codex의 /plan이 쓰는 방식과 같습니다(args 있으면 입력창 설정, 없으면 UI 오픈).',
      },
      {
        label: '항상 즉시 실행',
        description:
          '/handoff codex ... 처럼 provider를 반드시 적어야 하고, 시트는 안 열림. 빠르지만 컬렉션·워크트리 같은 옵션은 기본값 고정.',
      },
      {
        label: '항상 시트만 열기',
        description:
          '슬래시는 버튼의 키보드 단축 통로 역할만. 프롬프트 인자는 안 받음. 구현이 가장 작지만 지금 없는 기능(임의 프롬프트)도 안 생깁니다.',
      },
    ],
  },
  {
    header: '프롬프트 취급',
    question: '뒤에 적은 프롬프트를 export 참조와 어떻게 조합할까요?',
    multiSelect: false,
    options: [
      {
        label: '참조 + 읽기 지침 + 내 지시 (추천)',
        description:
          'export 경로와 "끝에서부터 읽어라" 지침은 그대로 두고, 그 아래에 사용자 지시를 덧붙임. 새 세션이 맥락을 파악한 뒤 지시를 수행. 맥락 유실 위험이 가장 낮습니다.',
      },
      {
        label: '참조 + 내 지시만',
        description:
          '"이어서 진행하라" 문구를 사용자 지시로 대체. 프롬프트가 짧고 의도가 선명하지만, 긴 export를 어떻게 읽어야 하는지 안내가 사라져 앞부분만 읽고 최신 요청을 놓칠 수 있습니다.',
      },
    ],
  },
  {
    header: '스킬 배치',
    question: '이 스킬을 어디에 두어야 하나요?',
    multiSelect: false,
    options: [
      {
        label: '프로젝트 .claude/skills (추천)',
        description: 'Tessera 레포에 커밋되어 팀 전체가 같은 정의를 씁니다.',
      },
      {
        label: '글로벌 ~/.claude/skills',
        description: '내 모든 프로젝트에서 쓰이지만 레포에는 안 남습니다.',
      },
    ],
  },
];

const DUMMY_LINES = [
  '슬래시로 부르기 — 인자 파싱은 이미 있습니다(parseForSend, classifyCodexSlashCommand 가 /foo bar baz 에서 args를 뜯음). Tessera가 클라이언트에서 가로채는 명령도 이미 여럿(/fork, /new, /diff, /copy ...)이라 패턴이 확립돼 있습니다.',
  '임의 프롬프트 주입 — 현재는 고정된 "이어서 진행하라" 문구만 갑니다. 여기가 실제로 없는 부분입니다.',
  '참고로 Orca는 orca worktree create --agent codex --prompt "<브리프>" 가 전부이고, 컨텍스트 자동 요약이 없습니다 — 넘길 내용을 사람이 프롬프트에 직접 다 써야 합니다(skill-guides/orca-cli.md:63-89). Tessera의 export+참조 방식이 오히려 앞서 있습니다. Herdr에는 대응 기능이 아예 없고, 거기 live_handoff 는 서버 무중단 재시작이라 무관합니다.',
  '이 상태에서 결정할 게 세 가지입니다.',
];

// 헤더에 provider 브랜드가 뜨도록 최소 세션만 심는다. 렌더 전에 끝나야 첫 페인트부터
// 실제 모습이 나오므로 모듈 로드 시점에 한 번만 넣는다.
useSessionStore.setState({
  projects: [
    {
      projectDir: '/preview',
      projectName: 'preview',
      sessions: [{ id: SESSION_ID, provider: 'claude' }],
    },
  ],
} as unknown as Partial<ReturnType<typeof useSessionStore.getState>>);

export function AskUserQuestionPreviewClient() {
  const density = usePromptDensityStore((s) => s.density);
  const setDensity = usePromptDensityStore((s) => s.setDensity);

  return (
    <div className="h-screen flex flex-col bg-(--chat-bg) text-(--text-primary)">
      {/* 밀도 선택 (하네스 전용 — 실제 UI에는 없음) */}
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-(--divider) bg-(--sidebar-bg)">
        <span className="text-(--text-muted)">preview density:</span>
        {(['compact', 'normal', 'relaxed'] as const).map((d) => (
          <button
            key={d}
            data-testid={`density-${d}`}
            onClick={() => setDensity(d)}
            className={
              d === density
                ? 'px-2 py-0.5 rounded bg-(--accent) text-white'
                : 'px-2 py-0.5 rounded bg-(--sidebar-hover) text-(--text-secondary)'
            }
          >
            {d}
          </button>
        ))}
      </div>

      {/* 채팅 본문 (더미) */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 text-sm leading-relaxed">
        {DUMMY_LINES.map((line, i) => (
          <p key={i} className="text-(--text-secondary)">
            • {line}
          </p>
        ))}
        <div className="rounded-lg border border-(--divider) px-3 py-2 text-xs text-(--text-muted)">
          AskUserQuestion · 3 questions
        </div>
      </div>

      {/* 패널 */}
      <div className="px-4 pb-2">
        <AskUserQuestionFloatingPanel
          questions={QUESTIONS}
          toolUseId="preview-tool-use"
          sessionId={SESSION_ID}
        />
      </div>

      {/* 입력창 (더미) */}
      <div className="px-4 pb-3">
        <div className="rounded-xl border border-(--input-border) bg-(--input-bg) px-4 py-3 text-sm text-(--input-placeholder)">
          Waiting for response... (↑↓: Navigate, Space: Select, Enter: Submit)
        </div>
      </div>
    </div>
  );
}
