"use client";

import { useCallback, useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChangedFileRow } from "@/lib/git/changed-file-tree";

/** Keep large Git trees from competing with terminal rendering on the UI thread. */
export function GitChangedFileList({
  rows,
  scrollable,
  activeIndex,
  treeProps,
  children,
}: {
  rows: ChangedFileRow[];
  scrollable: boolean;
  /** The keyboard lead row, kept in view as it moves. */
  activeIndex?: number | null;
  /** Props for the focusable tree element that receives keyboard navigation. */
  treeProps?: HTMLAttributes<HTMLDivElement> & { "data-testid"?: string };
  children: (row: ChangedFileRow) => ReactNode;
}) {
  // The virtualizer is mutable; the React Compiler must not cache its getters.
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const flatRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((index: number) => `${rows[index].kind}:${rows[index].path}`, [rows]);
  // eslint-disable-next-line react-hooks/incompatible-library -- This component explicitly opts out of compiler memoization above.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 28,
    overscan: 5,
    enabled: scrollable,
  });

  useEffect(() => {
    if (activeIndex == null || activeIndex < 0 || activeIndex >= rows.length) return;
    if (scrollable) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    } else {
      flatRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, rows.length, scrollable, virtualizer]);

  // Phone layouts share one outer scroller with the summary and commit history.
  if (!scrollable) {
    return <div ref={flatRef} {...treeProps} className="flex select-none flex-col outline-none">{rows.map(children)}</div>;
  }

  return (
    <ScrollArea ref={scrollRef} className="min-h-0 flex-1" data-testid="git-changed-file-scroll">
      <div {...treeProps} className="relative w-full select-none outline-none" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {children(rows[item.index])}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
