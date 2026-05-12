"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import type { AgentTimelineItem } from "@/lib/agent-context-summary";
import { buildAgentContextSummary } from "@/lib/agent-context-summary";
import { useChatStore } from "@/stores/chat-store";
import type { EnhancedMessage } from "@/types/chat";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const EMPTY_MESSAGES: EnhancedMessage[] = [];

type LogFilterKey =
  | "cmd"
  | "read"
  | "search"
  | "edit"
  | "issue"
  | "task"
  | "todo"
  | "web";

interface FilterOption {
  key: LogFilterKey;
  label: string;
}

const FILTER_OPTIONS: FilterOption[] = [
  { key: "cmd", label: "CMD" },
  { key: "read", label: "READ" },
  { key: "search", label: "SEARCH" },
  { key: "edit", label: "EDIT" },
  { key: "issue", label: "ISSUE" },
  { key: "task", label: "TASK" },
  { key: "todo", label: "TODO" },
  { key: "web", label: "WEB" },
];

const EMPTY_FILTER_COUNTS: Record<LogFilterKey, number> = {
  cmd: 0,
  read: 0,
  search: 0,
  edit: 0,
  issue: 0,
  task: 0,
  todo: 0,
  web: 0,
};

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatShortTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getFilterKey(item: AgentTimelineItem): LogFilterKey {
  return item.kind;
}

function getKindLabel(item: AgentTimelineItem): string {
  const key = getFilterKey(item);
  switch (key) {
    case "read":
      return "READ";
    case "search":
      return "SEARCH";
    case "cmd":
      return "CMD";
    case "edit":
      return "EDIT";
    case "issue":
      return "ISSUE";
    case "task":
      return "TASK";
    case "todo":
      return "TODO";
    case "web":
      return "WEB";
  }
}

function getKindClass(item: AgentTimelineItem): string {
  const key = getFilterKey(item);
  switch (key) {
    case "read":
      return "text-(--accent)";
    case "search":
      return "text-(--status-info-text)";
    case "cmd":
      return "text-(--text-secondary)";
    case "edit":
      return "text-(--status-success-text)";
    case "issue":
      return "text-(--status-error-text)";
    case "task":
      return "text-(--status-info-text)";
    case "todo":
      return "text-(--warning)";
    case "web":
      return "text-(--status-info-text)";
  }
}

function getEventText(item: AgentTimelineItem): string {
  return item.command || item.path || item.title;
}

function getRowDetailParts(item: AgentTimelineItem): string[] {
  const parts = [item.detail];
  if (item.kind !== "cmd" && !(item.kind === "read" && item.command)) {
    parts.push(item.meta);
  }
  return parts.filter((part): part is string => Boolean(part));
}

function getEventTitle(item: AgentTimelineItem): string {
  const parts = [
    formatTime(item.timestamp),
    getKindLabel(item),
    getEventText(item),
    item.detail,
    item.meta,
    item.status,
  ].filter(Boolean);
  return parts.join(" | ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstRecordString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function getToolResultErrorText(result: unknown): string | undefined {
  if (typeof result === "string") return nonEmptyString(result);
  if (!isRecord(result)) return undefined;

  const direct = firstRecordString(result, [
    "stderr",
    "error",
    "message",
    "output",
    "stdout",
    "content",
    "responseText",
  ]);
  if (direct) return direct;

  const task = isRecord(result.task) ? result.task : undefined;
  return firstRecordString(task, ["output", "result", "message"]);
}

function useIssueDetail(item: AgentTimelineItem): {
  detail: string;
  isLoading: boolean;
} {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cachedOutput = useChatStore((state) =>
    item.toolUseId ? state.toolOutputCache.get(item.toolUseId) : undefined,
  );
  const shouldLoadSavedOutput = Boolean(
    !item.errorDetail && item.hasOutput && item.sessionId && item.toolUseId && !cachedOutput,
  );

  useEffect(() => {
    if (!shouldLoadSavedOutput) return;

    let isCancelled = false;
    async function fetchIssueOutput(): Promise<void> {
      setIsLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams({ toolUseId: item.toolUseId! });
        const response = await fetch(`/api/sessions/${item.sessionId}/tool-output?${params}`);
        if (!response.ok) {
          throw new Error(response.status === 404 ? "No saved tool output found" : `Failed to load tool output (${response.status})`);
        }

        const data = await response.json();
        if (isCancelled) return;
        useChatStore.getState().setToolOutput(item.sessionId!, item.toolUseId!, {
          output: data.output,
          toolUseResult: data.toolUseResult,
          isError: data.isError,
        });
      } catch (error) {
        if (!isCancelled) {
          setLoadError((error as Error).message);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchIssueOutput();

    return () => {
      isCancelled = true;
    };
  }, [item.sessionId, item.toolUseId, shouldLoadSavedOutput]);

  const cachedDetail = getToolResultErrorText(cachedOutput?.toolUseResult)
    || nonEmptyString(cachedOutput?.output);
  const detail = item.errorDetail
    || cachedDetail
    || loadError
    || (shouldLoadSavedOutput || isLoading ? "Loading saved tool output..." : "No error output captured for this failed tool call.");

  return { detail, isLoading };
}

function IssueEventCell({ item }: { item: AgentTimelineItem }) {
  const { detail, isLoading } = useIssueDetail(item);

  return (
    <span
      title={[formatTime(item.timestamp), getKindLabel(item), getEventText(item), detail].filter(Boolean).join(" | ")}
      className="line-clamp-4 min-w-0 overflow-hidden whitespace-normal text-(--text-secondary) [overflow-wrap:anywhere]"
    >
      {getEventText(item)}
      <span className={cn("text-(--text-muted)", isLoading && "italic")}> · {detail}</span>
    </span>
  );
}

function buildFilterCounts(timeline: AgentTimelineItem[]): Record<LogFilterKey, number> {
  const counts = { ...EMPTY_FILTER_COUNTS };
  for (const item of timeline) {
    counts[getFilterKey(item)] += 1;
  }
  return counts;
}

function itemMatchesFilters(item: AgentTimelineItem, filters: Set<LogFilterKey>): boolean {
  return filters.size === 0 || filters.has(getFilterKey(item));
}

function TimelineRow({ item }: { item: AgentTimelineItem }) {
  const eventText = getEventText(item);
  const detailParts = getRowDetailParts(item);
  const eventCell = (
    <span className="line-clamp-3 min-w-0 overflow-hidden whitespace-normal text-(--text-secondary) [overflow-wrap:anywhere]">
      {eventText}
      {detailParts.length > 0 ? (
        <span className="text-(--text-muted)"> · {detailParts.join(" · ")}</span>
      ) : null}
    </span>
  );

  return (
    <li
      title={item.kind === "issue" ? undefined : getEventTitle(item)}
      className="grid min-h-[22px] grid-cols-[44px_46px_minmax(0,1fr)] items-start gap-x-2 border-b border-(--chat-header-border) px-1.5 py-0.5 font-mono text-[10.5px] leading-[1.32] transition-colors hover:bg-(--sidebar-hover)"
    >
      <time className="truncate pt-px tabular-nums text-(--text-muted)" dateTime={item.timestamp}>
        {formatShortTime(item.timestamp)}
      </time>
      <span className={cn("truncate pt-px text-[10px] font-semibold", getKindClass(item))}>
        {getKindLabel(item)}
      </span>
      {item.kind === "issue" ? <IssueEventCell item={item} /> : eventCell}
    </li>
  );
}

function FilterBar({
  activeFilters,
  counts,
  totalCount,
  onClear,
  onToggle,
}: {
  activeFilters: Set<LogFilterKey>;
  counts: Record<LogFilterKey, number>;
  totalCount: number;
  onClear: () => void;
  onToggle: (key: LogFilterKey) => void;
}) {
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
      <button
        type="button"
        aria-pressed={activeFilters.size === 0}
        onClick={onClear}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1 border px-1.5 font-mono text-[10px] leading-none transition-colors",
          activeFilters.size === 0
            ? "border-(--accent) bg-(--accent)/10 text-(--accent)"
            : "border-(--divider) text-(--text-muted) hover:text-(--text-primary)",
        )}
      >
        ALL
        <span className="tabular-nums">{totalCount}</span>
      </button>
      {FILTER_OPTIONS.map((filter) => {
        const isActive = activeFilters.has(filter.key);
        const count = counts[filter.key];
        return (
          <button
            key={filter.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(filter.key)}
            className={cn(
              "flex h-5 shrink-0 items-center gap-1 border px-1.5 font-mono text-[10px] leading-none transition-colors",
              isActive
                ? "border-(--accent) bg-(--accent)/10 text-(--accent)"
                : count > 0
                  ? "border-(--divider) text-(--text-muted) hover:text-(--text-primary)"
                  : "border-(--divider) text-(--text-muted)/55",
            )}
          >
            {filter.label}
            <span className="tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export const AgentContextPanel = memo(function AgentContextPanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const [activeFilterKeys, setActiveFilterKeys] = useState<LogFilterKey[]>([]);
  const messages = useChatStore((state) =>
    sessionId ? state.messages.get(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );

  const summary = useMemo(
    () => buildAgentContextSummary(messages),
    [messages],
  );
  const activeFilters = useMemo(() => new Set(activeFilterKeys), [activeFilterKeys]);
  const filterCounts = useMemo(() => buildFilterCounts(summary.timeline), [summary.timeline]);
  const filteredTimeline = useMemo(
    () => summary.timeline.filter((item) => itemMatchesFilters(item, activeFilters)),
    [activeFilters, summary.timeline],
  );

  const hasAnyContext = summary.timeline.length > 0;
  const isLive = summary.timeline.some((item) =>
    item.status === "running" || item.status === "active" || item.status === "pending" || item.status === "in_progress",
  );
  const lastTimelineItem = filteredTimeline[filteredTimeline.length - 1];
  const streamFollowKey = lastTimelineItem
    ? `${filteredTimeline.length}:${lastTimelineItem.id}:${lastTimelineItem.status || ""}:${activeFilterKeys.join(",")}`
    : `empty:${activeFilterKeys.join(",")}:${summary.timeline.length}`;

  const scrollToBottom = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    stream.scrollTop = stream.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollToBottom();
  }, [scrollToBottom, streamFollowKey]);

  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        scrollToBottom();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", scrollToBottom);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", scrollToBottom);
    };
  }, [scrollToBottom]);

  function toggleFilter(key: LogFilterKey): void {
    setActiveFilterKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <FileSearch className="mx-auto h-5 w-5 text-(--text-muted)" />
          <h3 className="mt-2 text-sm font-medium text-(--text-primary)">No session selected</h3>
          <p className="mt-1 text-xs leading-5 text-(--text-muted)">
            Select a session to track agent context.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden">
      <div className="shrink-0 border-b border-(--chat-header-border) px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold text-(--text-primary)">Agent context</h2>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1.5 border px-1.5 font-mono text-[10px] uppercase",
              isLive
                ? "border-(--accent)/40 text-(--accent)"
                : "border-(--divider) text-(--text-muted)",
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-(--accent) motion-safe:animate-pulse" : "bg-(--text-muted)")} />
            {isLive ? "Live" : "Idle"}
          </span>
        </div>
        <FilterBar
          activeFilters={activeFilters}
          counts={filterCounts}
          totalCount={summary.timeline.length}
          onClear={() => setActiveFilterKeys([])}
          onToggle={toggleFilter}
        />
      </div>

      {!hasAnyContext ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div>
            <FileSearch className="mx-auto h-5 w-5 text-(--text-muted)" />
            <h3 className="mt-2 text-sm font-medium text-(--text-primary)">No agent context yet</h3>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              Tool calls, tasks, and todos will appear as the session runs.
            </p>
          </div>
        </div>
      ) : (
        <ScrollArea ref={streamRef} className="scrollbar-none min-h-0 flex-1 overflow-x-hidden">
          <div className="sticky top-0 z-10 grid h-5 grid-cols-[44px_46px_minmax(0,1fr)] items-center gap-x-2 border-b border-(--divider) bg-(--sidebar-bg) px-1.5 font-mono text-[9.5px] uppercase leading-none text-(--text-muted)">
            <span>T</span>
            <span>Kind</span>
            <span>Event</span>
          </div>
          {filteredTimeline.length > 0 ? (
            <ol className="pb-8">
              {filteredTimeline.map((item) => (
                <TimelineRow key={item.id} item={item} />
              ))}
            </ol>
          ) : (
            <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-(--text-muted)">
              No matching events.
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
});
