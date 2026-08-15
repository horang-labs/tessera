import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAB_SCROLL_GUTTER,
  resolveTabScrollReveal,
} from '@/lib/tab/tab-scroll-reveal';

/**
 * 재현 기준 치수 — 폭 900 스트립에서 탭 6개(각 160)가 처음 넘칠 때의 값이다.
 * 오른쪽 화살표는 스크롤 영역 위 32px(`TAB_SCROLL_GUTTER`)을 덮는다.
 */
const VIEWPORT_WIDTH = 860;
const TAB_WIDTH = 160;
const LAST_TAB_START = TAB_WIDTH * 5;
const LAST_TAB_END = TAB_WIDTH * 6;

test('마지막 탭을 열면 별도 끝 여백 없이 스크롤 끝까지 이동한다', () => {
  const contentWidth = LAST_TAB_END;
  const result = resolveTabScrollReveal({
    tabStart: LAST_TAB_START,
    tabEnd: LAST_TAB_END,
    scrollLeft: 0,
    viewportWidth: VIEWPORT_WIDTH,
    maxScrollLeft: contentWidth - VIEWPORT_WIDTH,
  });

  assert.equal(result.settled, true);
  assert.equal(result.scrollLeft, LAST_TAB_END - VIEWPORT_WIDTH);
  // 스크롤 끝에서는 오른쪽 화살표가 사라지므로 탭이 끝에 붙어도 가려지지 않는다.
  assert.equal(result.scrollLeft, contentWidth - VIEWPORT_WIDTH);
});

test('오른쪽에 탭이 더 있으면 활성 탭을 화살표 여백 밖까지 이동한다', () => {
  const contentWidth = LAST_TAB_END + TAB_WIDTH;
  const result = resolveTabScrollReveal({
    tabStart: LAST_TAB_START,
    tabEnd: LAST_TAB_END,
    scrollLeft: 0,
    viewportWidth: VIEWPORT_WIDTH,
    maxScrollLeft: contentWidth - VIEWPORT_WIDTH,
  });

  assert.equal(result.scrollLeft, LAST_TAB_END + TAB_SCROLL_GUTTER - VIEWPORT_WIDTH);
  assert.equal(result.settled, true);
});

test('왼쪽 화살표에 가린 탭은 오른쪽으로 되돌려 드러낸다', () => {
  const contentWidth = TAB_WIDTH * 10;
  const result = resolveTabScrollReveal({
    tabStart: TAB_WIDTH * 3,
    tabEnd: TAB_WIDTH * 4,
    scrollLeft: TAB_WIDTH * 3 + 10, // 탭 왼쪽이 화살표 아래로 들어간 상태
    viewportWidth: VIEWPORT_WIDTH,
    maxScrollLeft: contentWidth - VIEWPORT_WIDTH,
  });

  assert.equal(result.settled, true);
  assert.equal(result.scrollLeft, TAB_WIDTH * 3 - TAB_SCROLL_GUTTER);
});

test('첫 탭은 스크롤 0에서 왼쪽 화살표가 없으므로 그대로 둔다', () => {
  const contentWidth = TAB_WIDTH * 10;
  const result = resolveTabScrollReveal({
    tabStart: 0,
    tabEnd: TAB_WIDTH,
    scrollLeft: 0,
    viewportWidth: VIEWPORT_WIDTH,
    maxScrollLeft: contentWidth - VIEWPORT_WIDTH,
  });

  assert.equal(result.scrollLeft, 0);
  assert.equal(result.settled, true);
});

test('이미 양쪽 여백 안에 보이는 탭은 스크롤을 건드리지 않는다', () => {
  const contentWidth = TAB_WIDTH * 10;
  const result = resolveTabScrollReveal({
    tabStart: TAB_WIDTH * 2,
    tabEnd: TAB_WIDTH * 3,
    scrollLeft: TAB_WIDTH,
    viewportWidth: VIEWPORT_WIDTH,
    maxScrollLeft: contentWidth - VIEWPORT_WIDTH,
  });

  assert.equal(result.scrollLeft, TAB_WIDTH);
  assert.equal(result.settled, true);
});

test('뷰포트보다 넓은 탭은 왼쪽을 드러내는 쪽을 택한다', () => {
  const narrowViewport = 200;
  const contentWidth = 1000;
  const result = resolveTabScrollReveal({
    tabStart: 400,
    tabEnd: 700,
    scrollLeft: 0,
    viewportWidth: narrowViewport,
    maxScrollLeft: contentWidth - narrowViewport,
  });

  // 양끝을 동시에 만족할 수 없으므로 제목이 보이는 왼쪽 정렬을 택한다.
  assert.equal(result.scrollLeft, 400 - TAB_SCROLL_GUTTER);
});
