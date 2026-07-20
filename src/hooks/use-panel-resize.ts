// src/hooks/use-panel-resize.ts
'use client';

import { useState, useRef, useEffect } from 'react';
import type React from 'react';

// 로컬 인터페이스 (export 없음)
interface UsePanelResizeOptions {
  direction: 'horizontal' | 'vertical';
  initialRatio: number;           // 현재 비율 (0.0~1.0)
  minRatio?: number;              // 기본값: 0.15
  maxRatio?: number;              // 기본값: 0.85
  onRatioChange: (ratio: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface UsePanelResizeResult {
  isDragging: boolean;            // useState -- PanelDivider 시각 스타일용
  handlePointerDown: (e: React.PointerEvent) => void;
}

export function usePanelResize({
  direction,
  initialRatio,
  minRatio = 0.15,
  maxRatio = 0.85,
  onRatioChange,
  containerRef,
}: UsePanelResizeOptions): UsePanelResizeResult {
  // BR-RESIZE-007: isDragging ref (빠른 이벤트 처리용)
  const isDraggingRef = useRef<boolean>(false);
  // BR-DIVIDER-002: isDragging state (시각 스타일용)
  const [isDragging, setIsDragging] = useState(false);

  // stale closure 방지 -- onRatioChange ref
  const onRatioChangeRef = useRef(onRatioChange);
  useEffect(() => {
    onRatioChangeRef.current = onRatioChange;
  }); // 의존성 배열 없음 -- 매 렌더마다 동기화

  // 이벤트 핸들러를 ref로 보관하여 cleanup 시 동일 참조 사용
  const handlePointerMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const handlePointerUpRef = useRef<(() => void) | null>(null);
  const handlePointerCancelRef = useRef<(() => void) | null>(null);
  const handleWindowBlurRef = useRef<(() => void) | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();   // BR-DIVIDER-005: 이벤트 전파 차단
    if (isDraggingRef.current) return;

    isDraggingRef.current = true;
    setIsDragging(true);

    // BR-RESIZE-006: 텍스트 선택 방지
    document.body.style.userSelect = 'none';
    // BR-DIVIDER-003: 전역 커서 설정
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!isDraggingRef.current) return;

      const container = containerRef.current;
      if (!container) return;  // BR-RESIZE-004

      const rect = container.getBoundingClientRect();

      let newRatio: number;
      if (direction === 'horizontal') {
        if (rect.width === 0) return;  // BR-RESIZE-004: 0 나눗셈 방지
        newRatio = (moveEvent.clientX - rect.left) / rect.width;  // BR-RESIZE-002
      } else {
        if (rect.height === 0) return; // BR-RESIZE-004
        newRatio = (moveEvent.clientY - rect.top) / rect.height;  // BR-RESIZE-002
      }

      // BR-RESIZE-003: 클램핑
      const clampedRatio = Math.max(minRatio, Math.min(maxRatio, newRatio));
      onRatioChangeRef.current(clampedRatio);
    };

    const stopDragging = () => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;
      setIsDragging(false);

      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);

      // BR-RESIZE-006: 복원
      document.body.style.userSelect = '';
      // BR-DIVIDER-003: 커서 복원
      document.body.style.cursor = '';
    };

    const handlePointerUp = () => stopDragging();
    const handlePointerCancel = () => {
      onRatioChangeRef.current(initialRatio);
      stopDragging();
    };
    const handleWindowBlur = () => stopDragging();

    handlePointerMoveRef.current = handlePointerMove;
    handlePointerUpRef.current = handlePointerUp;
    handlePointerCancelRef.current = handlePointerCancel;
    handleWindowBlurRef.current = handleWindowBlur;

    // BR-RESIZE-001: document 전역 등록 (구분선 이탈해도 드래그 유지)
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
  };

  // BR-RESIZE-005: 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (handlePointerMoveRef.current) {
        document.removeEventListener('pointermove', handlePointerMoveRef.current);
      }
      if (handlePointerUpRef.current) {
        document.removeEventListener('pointerup', handlePointerUpRef.current);
      }
      if (handlePointerCancelRef.current) {
        document.removeEventListener('pointercancel', handlePointerCancelRef.current);
      }
      if (handleWindowBlurRef.current) {
        window.removeEventListener('blur', handleWindowBlurRef.current);
      }
      if (isDraggingRef.current) {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };
  }, []); // 마운트/언마운트 시 한 번만

  return { isDragging, handlePointerDown };
}
