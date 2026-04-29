import { useCallback, useEffect, useRef, useState } from 'react';

interface UseResizeOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
  /** Which side the resize handle is on. 'right' = handle on right of panel (default), 'left' = handle on left of panel */
  direction?: 'right' | 'left';
}

export function useResize(options: UseResizeOptions) {
  const { defaultWidth, minWidth, maxWidth, onWidthChange, direction = 'right' } = options;
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      setIsDragging(true);
      startXRef.current = e.clientX;

      const sibling =
        direction === 'right'
          ? (e.currentTarget.previousElementSibling as HTMLElement)
          : (e.currentTarget.nextElementSibling as HTMLElement);
      startWidthRef.current = sibling?.offsetWidth ?? defaultWidth;

      document.body.style.userSelect = 'none';
    },
    [defaultWidth, direction]
  );

  const handleDoubleClick = useCallback(() => {
    onWidthChange(defaultWidth);
  }, [defaultWidth, onWidthChange]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const deltaX = e.clientX - startXRef.current;
      const newWidth =
        direction === 'right'
          ? startWidthRef.current + deltaX
          : startWidthRef.current - deltaX;

      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      onWidthChange(clampedWidth);
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
    };
  }, [minWidth, maxWidth, onWidthChange, direction]);

  return {
    isDragging,
    handleMouseDown,
    handleDoubleClick,
  };
}
