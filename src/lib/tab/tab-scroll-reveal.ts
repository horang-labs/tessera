/**
 * 탭 스트립의 스크롤 화살표는 스크롤 영역 위에 겹쳐 그려진다. 활성 탭이 그
 * 아래에 깔리면 닫기 버튼을 누를 수 없으므로(BR-UI-024), 활성 탭을 드러낼
 * 스크롤 위치는 양 끝 `gutter`를 "화살표가 덮는 영역"으로 빼고 계산한다.
 */

/** 스크롤 화살표가 덮는 폭 — 탭 스트립의 `scroll-px-8`과 같은 값. */
export const TAB_SCROLL_GUTTER = 32;

/** 스크롤 좌표 비교에 쓰는 허용 오차(서브픽셀 반올림 흡수). */
export const TAB_SCROLL_EDGE_EPSILON = 1;

export interface TabScrollRevealInput {
  /** 스크롤 콘텐츠 좌표계에서 탭의 왼쪽 끝. */
  tabStart: number;
  /** 스크롤 콘텐츠 좌표계에서 탭의 오른쪽 끝. */
  tabEnd: number;
  /** 현재 스크롤 위치. */
  scrollLeft: number;
  /** 스크롤 뷰포트 폭(`clientWidth`). */
  viewportWidth: number;
  /** 도달 가능한 최대 스크롤 위치(`scrollWidth - clientWidth`). */
  maxScrollLeft: number;
  /** 화살표가 덮는 폭. */
  gutter?: number;
}

export interface TabScrollRevealResult {
  /** 적용할 스크롤 위치. */
  scrollLeft: number;
  /**
   * 이 위치에서 탭이 실제로 보이는 화살표에 가려지지 않으면 true.
   */
  settled: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 활성 탭을 좌우 화살표 밖으로 드러내는 스크롤 위치를 계산한다.
 *
 * 탭이 뷰포트보다 넓어 양끝을 동시에 만족할 수 없으면 왼쪽 정렬을 택한다 —
 * 제목 앞부분이 잘리는 편보다 낫다.
 */
export function resolveTabScrollReveal({
  tabStart,
  tabEnd,
  scrollLeft,
  viewportWidth,
  maxScrollLeft,
  gutter = TAB_SCROLL_GUTTER,
}: TabScrollRevealInput): TabScrollRevealResult {
  let target = scrollLeft;

  // 오른쪽이 덮이면 그만큼 더 스크롤하고, 그다음 왼쪽을 확인한다.
  const minForRightEdge = tabEnd + gutter - viewportWidth;
  if (target < minForRightEdge) target = minForRightEdge;
  const maxForLeftEdge = tabStart - gutter;
  if (target > maxForLeftEdge) target = maxForLeftEdge;

  const next = clamp(target, 0, maxScrollLeft);

  // 스크롤 끝에서는 오른쪽 화살표 자체가 사라지므로 탭이 뷰포트 끝에 붙어도
  // 가려지지 않는다. 별도 끝 여백을 두지 않아야 "+"도 마지막 탭에 바로 붙는다.
  const atRightEdge = next >= maxScrollLeft - TAB_SCROLL_EDGE_EPSILON;
  const coveredOnRight =
    !atRightEdge && tabEnd > next + viewportWidth - gutter + TAB_SCROLL_EDGE_EPSILON;
  // 왼쪽은 반대다. 스크롤 0이면 왼쪽 화살표 자체가 없으므로 탭이 끝에 붙어도
  // 가려지지 않고, 더 되돌릴 여유도 없다.
  const coveredOnLeft =
    next > TAB_SCROLL_EDGE_EPSILON && tabStart < next + gutter - TAB_SCROLL_EDGE_EPSILON;

  return { scrollLeft: next, settled: !coveredOnRight && !coveredOnLeft };
}
