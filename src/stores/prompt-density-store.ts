import type { CSSProperties } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Display density for interactive prompt panels (AskUserQuestion 등).
 *
 * 이 패널들은 채팅 본문 위에 떠서 화면을 크게 가리기 때문에, 사용자가
 * 직접 크기를 줄일 수 있어야 한다. 기본값은 가장 좁은 'compact'.
 */
export type PromptDensity = 'compact' | 'normal' | 'relaxed';

export const PROMPT_DENSITY_ORDER: PromptDensity[] = ['compact', 'normal', 'relaxed'];

/** CSS 변수로 흘려보낼 밀도별 치수. 값 하나만 바꾸면 패널 전체가 따라 움직인다. */
export interface PromptDensityMetrics {
  /** 헤더·푸터 가로 패딩 */
  barPadX: string;
  /** 헤더·푸터 세로 패딩 */
  barPadY: string;
  /** 본문(질문 목록) 패딩 */
  bodyPad: string;
  /** 질문 블록 사이 간격 */
  blockGap: string;
  /** 질문 블록 내부 패딩 */
  blockPad: string;
  /** 옵션 버튼 세로/가로 패딩 */
  optPadY: string;
  optPadX: string;
  /** 옵션 버튼 내부 요소 간격 */
  optGap: string;
  /** 옵션 사이 간격 */
  optSpace: string;
  /** 질문 문장 폰트 */
  questionFont: string;
  /** 옵션 라벨 폰트 */
  labelFont: string;
  /** 옵션 설명 폰트 */
  descFont: string;
  /** 선택 인디케이터 한 변 */
  ctrlSize: string;
  /** 패널 최대 높이 */
  maxHeight: string;
  /** 마크다운 미리보기 최대 높이 */
  previewMaxHeight: string;
}

export const PROMPT_DENSITY_METRICS: Record<PromptDensity, PromptDensityMetrics> = {
  compact: {
    barPadX: '10px',
    barPadY: '4px',
    bodyPad: '8px',
    blockGap: '8px',
    blockPad: '8px',
    optPadY: '4px',
    optPadX: '8px',
    optGap: '8px',
    optSpace: '3px',
    questionFont: '12px',
    labelFont: '12px',
    descFont: '11px',
    ctrlSize: '16px',
    maxHeight: '32vh',
    previewMaxHeight: '180px',
  },
  normal: {
    barPadX: '12px',
    barPadY: '7px',
    bodyPad: '12px',
    blockGap: '12px',
    blockPad: '10px',
    optPadY: '7px',
    optPadX: '10px',
    optGap: '10px',
    optSpace: '5px',
    questionFont: '13px',
    labelFont: '13px',
    descFont: '12px',
    ctrlSize: '18px',
    maxHeight: '45vh',
    previewMaxHeight: '260px',
  },
  relaxed: {
    barPadX: '16px',
    barPadY: '10px',
    bodyPad: '16px',
    blockGap: '16px',
    blockPad: '12px',
    optPadY: '10px',
    optPadX: '12px',
    optGap: '12px',
    optSpace: '6px',
    questionFont: '14px',
    labelFont: '14px',
    descFont: '12px',
    ctrlSize: '20px',
    maxHeight: '60vh',
    previewMaxHeight: '320px',
  },
};

/** 밀도 메트릭을 컨테이너에 걸 CSS 변수 맵으로 변환한다. */
export function promptDensityVars(density: PromptDensity): CSSProperties {
  const m = PROMPT_DENSITY_METRICS[density];
  return {
    '--aqp-bar-px': m.barPadX,
    '--aqp-bar-py': m.barPadY,
    '--aqp-body-pad': m.bodyPad,
    '--aqp-block-gap': m.blockGap,
    '--aqp-block-pad': m.blockPad,
    '--aqp-opt-py': m.optPadY,
    '--aqp-opt-px': m.optPadX,
    '--aqp-opt-gap': m.optGap,
    '--aqp-opt-space': m.optSpace,
    '--aqp-question-font': m.questionFont,
    '--aqp-label-font': m.labelFont,
    '--aqp-desc-font': m.descFont,
    '--aqp-ctrl': m.ctrlSize,
    '--aqp-max-h': m.maxHeight,
    '--aqp-preview-max-h': m.previewMaxHeight,
  } as CSSProperties;
}

interface PromptDensityState {
  density: PromptDensity;
  setDensity: (density: PromptDensity) => void;
  /** 한 단계 좁히거나(-1) 넓힌다(+1). 양 끝에서는 더 움직이지 않는다. */
  stepDensity: (delta: 1 | -1) => void;
}

export const usePromptDensityStore = create<PromptDensityState>()(
  persist(
    (set) => ({
      density: 'compact',
      setDensity: (density) => set({ density }),
      stepDensity: (delta) =>
        set((state) => {
          const idx = PROMPT_DENSITY_ORDER.indexOf(state.density);
          const next = Math.min(
            PROMPT_DENSITY_ORDER.length - 1,
            Math.max(0, (idx === -1 ? 0 : idx) + delta),
          );
          return { density: PROMPT_DENSITY_ORDER[next] };
        }),
    }),
    { name: 'tessera:prompt-density' },
  ),
);
