"use client";

import {
  AlertCircle,
  BookOpen,
  BookText,
  Brain,
  FileText,
  Folder,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { WorkspaceFileContextMenu } from "@/components/workspace/workspace-file-context-menu";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { useI18n } from "@/lib/i18n";
import {
  openMemoryFileTab,
  previewMemoryFileTab,
} from "@/lib/workspace-tabs/open-workspace-tab";
import { toast } from "@/stores/notification-store";
import {
  type MemoryEntryType,
  type MemoryFileSummary,
  type MemoryGuidelineSummary,
  type MemoryListData,
  type MemoryTargetKind,
} from "@/types/memory";
import { cn } from "@/lib/utils";

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface MemoryPanelState {
  loading: boolean;
  error: string | null;
  data: MemoryListData | null;
}

interface MemoryContextMenuState {
  absolutePath: string;
  canOpenFile: boolean;
  position: { x: number; y: number };
}

interface MemoryRowItem {
  key: string;
  kind: MemoryTargetKind;
  fileName: string;
  relativePath: string;
  icon: ReactNode;
  path: string;
  description: string;
  statusLabel?: string;
  shadowed?: boolean;
  type: MemoryEntryType | null;
  emphasis: boolean;
  deletable: boolean;
  summary?: MemoryFileSummary;
}

interface MemorySection {
  key: string;
  title: string;
  description: string;
  folderPath: string;
  icon: ReactNode;
  rows: MemoryRowItem[];
  emptyLabel?: string;
}

type VisibleMemoryEntryType = Exclude<MemoryEntryType, "feedback">;

function joinDisplayPath(dir: string, name: string): string {
  const usesBackslash = dir.includes("\\") && !dir.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function getDisplayDir(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash < 0) return filePath;
  return lastSlash === 0 ? filePath.slice(0, 1) : filePath.slice(0, lastSlash);
}

const TYPE_LABEL_CLASS: Record<VisibleMemoryEntryType, string> = {
  user: "text-(--status-info-text)",
  project: "text-(--status-success-text)",
  reference: "text-(--text-muted)",
};

function getVisibleMemoryType(type: MemoryEntryType | null): VisibleMemoryEntryType | null {
  return type === "feedback" ? null : type;
}

function getMemoryTypeLabel(type: VisibleMemoryEntryType, t: Translate): string {
  switch (type) {
    case "user":
      return t("memoryPanel.rows.typeUser");
    case "project":
      return t("memoryPanel.rows.typeProject");
    case "reference":
      return t("memoryPanel.rows.typeReference");
  }
}

function getGuidelineStatusLabel(guideline: MemoryGuidelineSummary, t: Translate): string {
  switch (guideline.statusReason) {
    case "fallback-active":
      return t("memoryPanel.rows.fallbackActive");
    case "custom-instructions":
      return t("memoryPanel.rows.configured");
    case "shadowed-by-override":
      return t("memoryPanel.rows.shadowedByOverride");
    case "shadowed-by-agents":
      return t("memoryPanel.rows.shadowedByAgents");
    case "shadowed-by-opencode-global":
      return t("memoryPanel.rows.shadowedByOpenCodeGlobal");
    case "disabled-by-env":
      return t("memoryPanel.rows.disabledByEnv");
    case "active":
      return t("memoryPanel.rows.active");
    default:
      return guideline.status === "shadowed"
        ? t("memoryPanel.rows.shadowedByOverride")
        : t("memoryPanel.rows.active");
  }
}

function getMemoryFileDescription(provider: MemoryListData["provider"], file: MemoryFileSummary, t: Translate): string {
  if (provider !== "codex") return file.description;
  if (file.relativePath === "memory_summary.md") return t("memoryPanel.fileDescriptions.globalSummary");
  if (file.relativePath === "MEMORY.md") return t("memoryPanel.fileDescriptions.globalRegistry");
  switch (file.section) {
    case "rollout-summaries":
      return t("memoryPanel.fileDescriptions.rolloutSummary");
    case "ad-hoc-notes":
      return t("memoryPanel.fileDescriptions.adHocNote");
    case "memory-skills":
      return t("memoryPanel.fileDescriptions.memorySkill");
    default:
      return file.description;
  }
}

const NEW_MEMORY_TEMPLATE = (slug: string) => `---
name: ${slug}
description:
metadata:
  type: project
---

`;

function toMemoryFileSlug(rawName: string): string {
  return rawName
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function EmptyState({
  title,
  body,
  icon = "memory",
  action,
}: {
  title: string;
  body: string;
  icon?: "memory" | "error";
  action?: ReactNode;
}) {
  const Icon = icon === "error" ? AlertCircle : Brain;
  return (
    <div className="flex h-full items-center justify-center p-5">
      <div className="max-w-[240px] text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-(--divider) bg-(--sidebar-hover)">
          <Icon className="h-5 w-5 text-(--text-muted)" />
        </div>
        <p className="text-sm font-medium text-(--text-primary)">{title}</p>
        <p className="mt-1 break-all text-xs leading-5 text-(--text-muted)">{body}</p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function MemoryPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<MemoryPanelState>(() => ({
    loading: Boolean(sessionId),
    error: null,
    data: null,
  }));
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryFileSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<MemoryContextMenuState | null>(null);
  const requestSeqRef = useRef(0);

  const loadMemories = useCallback(async (options?: { signal?: AbortSignal }) => {
    if (!sessionId) return;

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sessionId)}/memory`,
        { signal: options?.signal, retries: 1 },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null) {
        throw new Error(extractGitPanelErrorMessage(payload, t("memoryPanel.errors.loadFailed")));
      }
      if (requestSeqRef.current !== requestSeq) return;
      setState({ loading: false, error: null, data: payload as MemoryListData });
    } catch (error) {
      if (options?.signal?.aborted || requestSeqRef.current !== requestSeq) return;
      setState({
        loading: false,
        error: isTimeoutError(error)
          ? t("memoryPanel.errors.listTimedOut")
          : error instanceof Error ? error.message : t("memoryPanel.errors.loadFailed"),
        data: null,
      });
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!sessionId) return;
    const abortController = new AbortController();
    void loadMemories({ signal: abortController.signal });
    return () => abortController.abort();
  }, [loadMemories, sessionId]);

  const sections = useMemo((): MemorySection[] => {
    const data = state.data;
    if (!data) return [];

    const guidelines: MemoryRowItem[] = data.guidelines.map((guideline) => {
      const statusLabel = getGuidelineStatusLabel(guideline, t);
      return {
        key: `${guideline.kind}:${guideline.fileName}`,
        kind: guideline.kind,
        fileName: guideline.fileName,
        relativePath: guideline.fileName,
        icon: <BookText className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />,
        path: guideline.path,
        description: statusLabel,
        statusLabel,
        shadowed: guideline.status === "shadowed",
        type: null,
        emphasis: false,
        deletable: false,
      };
    });

    const rowsForFiles = (files: MemoryFileSummary[]): MemoryRowItem[] => files.map((file) => ({
      key: `memory:${file.relativePath}`,
      kind: "memory",
      fileName: file.fileName,
      relativePath: file.relativePath,
      icon: file.isIndex || file.relativePath === "memory_summary.md"
        ? <BookOpen className="h-3.5 w-3.5 shrink-0 text-(--accent)" />
        : <FileText className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />,
      path: joinDisplayPath(data.memoryDir, file.relativePath),
      description: getMemoryFileDescription(data.provider, file, t),
      type: file.type,
      emphasis: file.isIndex || file.relativePath === "memory_summary.md",
      deletable: !file.readOnly && data.provider === "claude-code",
      summary: file,
    }));

    const memoryFiles = data.exists ? data.files : [];
    const globalGuidelines = guidelines.filter((row) => row.kind === "global-guideline");
    const projectGuidelines = guidelines.filter((row) => row.kind === "project-guideline");
    const projectMemoryRows = rowsForFiles(memoryFiles.filter((file) => file.section === "project-memory"));
    const globalMemoryRows = rowsForFiles(memoryFiles.filter((file) => file.section === "global-memory"));
    const rolloutRows = rowsForFiles(memoryFiles.filter((file) => file.section === "rollout-summaries"));
    const adHocRows = rowsForFiles(memoryFiles.filter((file) => file.section === "ad-hoc-notes"));
    const skillRows = rowsForFiles(memoryFiles.filter((file) => file.section === "memory-skills"));

    if (data.provider === "codex") {
      return [
        {
          key: "user-scope",
          title: t("memoryPanel.sections.userScopeTitle"),
          description: t("memoryPanel.sections.codexUserScopeDescription"),
          folderPath: globalGuidelines[0] ? getDisplayDir(globalGuidelines[0].path) : data.instructionRoots.user,
          icon: <User className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: globalGuidelines,
          emptyLabel: t("memoryPanel.empty.noUserInstructions"),
        },
        {
          key: "project-scope",
          title: t("memoryPanel.sections.projectScopeTitle"),
          description: t("memoryPanel.sections.codexProjectScopeDescription"),
          folderPath: projectGuidelines[0] ? getDisplayDir(projectGuidelines[0].path) : data.instructionRoots.project ?? "",
          icon: <Folder className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: projectGuidelines,
          emptyLabel: t("memoryPanel.empty.noProjectInstructions"),
        },
        {
          key: "user-global-memory",
          title: t("memoryPanel.sections.codexGlobalMemoryTitle"),
          description: t("memoryPanel.sections.codexGlobalMemoryDescription"),
          folderPath: data.memoryDir,
          icon: <Brain className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: globalMemoryRows,
        },
        {
          key: "rollout-summaries",
          title: t("memoryPanel.sections.rolloutSummariesTitle"),
          description: t("memoryPanel.sections.rolloutSummariesDescription"),
          folderPath: joinDisplayPath(data.memoryDir, "rollout_summaries"),
          icon: <FileText className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: rolloutRows,
        },
        {
          key: "ad-hoc-notes",
          title: t("memoryPanel.sections.adHocNotesTitle"),
          description: t("memoryPanel.sections.adHocNotesDescription"),
          folderPath: joinDisplayPath(data.memoryDir, "extensions/ad_hoc/notes"),
          icon: <BookText className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: adHocRows,
        },
        {
          key: "memory-skills",
          title: t("memoryPanel.sections.memorySkillsTitle"),
          description: t("memoryPanel.sections.memorySkillsDescription"),
          folderPath: joinDisplayPath(data.memoryDir, "skills"),
          icon: <BookOpen className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: skillRows,
        },
      ].filter((section) =>
        section.key === "user-scope"
        || section.key === "project-scope"
        || section.rows.length > 0
      );
    }

    if (data.provider === "opencode") {
      return [
        {
          key: "user-scope",
          title: t("memoryPanel.sections.userScopeTitle"),
          description: t("memoryPanel.sections.opencodeUserScopeDescription"),
          folderPath: data.instructionRoots.user,
          icon: <User className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: globalGuidelines,
          emptyLabel: t("memoryPanel.empty.noUserInstructions"),
        },
        {
          key: "project-scope",
          title: t("memoryPanel.sections.projectScopeTitle"),
          description: t("memoryPanel.sections.opencodeProjectScopeDescription"),
          folderPath: data.instructionRoots.project ?? "",
          icon: <Folder className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: projectGuidelines,
          emptyLabel: t("memoryPanel.empty.noProjectInstructions"),
        },
      ];
    }

    return [
        {
          key: "user-scope",
          title: t("memoryPanel.sections.userScopeTitle"),
          description: t("memoryPanel.sections.claudeUserScopeDescription"),
          folderPath: globalGuidelines[0] ? getDisplayDir(globalGuidelines[0].path) : data.instructionRoots.user,
          icon: <User className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: globalGuidelines,
          emptyLabel: t("memoryPanel.empty.noUserInstructions"),
        },
        {
          key: "project-scope",
          title: t("memoryPanel.sections.projectScopeTitle"),
          description: t("memoryPanel.sections.claudeProjectScopeDescription"),
          folderPath: projectGuidelines[0] ? getDisplayDir(projectGuidelines[0].path) : data.instructionRoots.project ?? "",
          icon: <Folder className="h-3.5 w-3.5 text-(--text-muted)" />,
          rows: projectGuidelines,
          emptyLabel: t("memoryPanel.empty.noProjectInstructions"),
        },
      {
        key: "project-memory",
        title: t("memoryPanel.sections.claudeProjectMemoryTitle"),
        description: t("memoryPanel.sections.claudeProjectMemoryDescription"),
        folderPath: data.memoryDir,
        icon: <Brain className="h-3.5 w-3.5 text-(--text-muted)" />,
        rows: projectMemoryRows,
        emptyLabel: t("memoryPanel.empty.noMemoryFiles"),
      },
    ].filter((section) =>
      section.key === "user-scope"
      || section.key === "project-scope"
      || section.key === "project-memory"
      || section.rows.length > 0
    );
  }, [state.data, t]);

  const hasVisibleRows = sections.length > 0;
  const canCreateProjectMemory = state.data?.provider === "claude-code";

  const openRow = useCallback((row: MemoryRowItem, pin: boolean) => {
    if (!sessionId) return;
    if (pin) openMemoryFileTab(sessionId, row.kind, row.relativePath);
    else previewMemoryFileTab(sessionId, row.kind, row.relativePath);
  }, [sessionId]);

  const handleCreate = useCallback(async () => {
    if (!sessionId || creating || state.data?.provider !== "claude-code") return;
    const slug = toMemoryFileSlug(createName);
    if (!slug) {
      setCreateError(t("memoryPanel.errors.createNameRequired"));
      return;
    }
    const fileName = `${slug}.md`;

    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sessionId)}/memory/file`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "memory",
            name: fileName,
            content: NEW_MEMORY_TEMPLATE(slug),
            root: state.data.root,
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, t("memoryPanel.errors.createFailed")));
      }

      setCreateOpen(false);
      setCreateName("");
      openMemoryFileTab(sessionId, "memory", fileName);
      void loadMemories();
      toast.success(t("memoryPanel.toast.created", { fileName }));
    } catch (error) {
      setCreateError(
        isTimeoutError(error)
          ? t("memoryPanel.errors.createTimedOut")
          : error instanceof Error ? error.message : t("memoryPanel.errors.createFailed"),
      );
    } finally {
      setCreating(false);
    }
  }, [createName, creating, loadMemories, sessionId, state.data, t]);

  const handleDelete = useCallback(async () => {
    if (!sessionId || !deleteTarget || deleting) return;

    setDeleting(true);
    try {
      const rootParam = state.data ? `&root=${encodeURIComponent(state.data.root)}` : "";
      const response = await fetchWithTimeout(
        `/api/sessions/${encodeURIComponent(sessionId)}/memory/file?kind=memory&name=${encodeURIComponent(deleteTarget.relativePath)}${rootParam}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(extractGitPanelErrorMessage(payload, t("memoryPanel.errors.deleteFailed")));
      }

      setDeleteTarget(null);
      void loadMemories();
      toast.success(t("memoryPanel.toast.deleted", { fileName: deleteTarget.fileName }));
    } catch (error) {
      toast.error(
        isTimeoutError(error)
          ? t("memoryPanel.errors.deleteTimedOut")
          : error instanceof Error ? error.message : t("memoryPanel.errors.deleteFailed"),
      );
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, loadMemories, sessionId, state.data, t]);

  function renderRow(row: MemoryRowItem) {
    const visibleType = getVisibleMemoryType(row.type);

    return (
      <div
        key={row.key}
        className="group relative border-l-2 border-l-transparent transition-colors hover:bg-(--sidebar-hover)"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            absolutePath: row.path,
            canOpenFile: true,
            position: { x: event.clientX, y: event.clientY },
          });
        }}
      >
        <button
          type="button"
          onClick={() => openRow(row, false)}
          onDoubleClick={() => openRow(row, true)}
          className="flex w-full min-w-0 items-start gap-2 py-1.5 pl-8 pr-8 text-left"
          title={row.path}
          data-testid={`memory-row-${row.kind}-${row.relativePath}`}
        >
          <span className="mt-0.5">{row.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[11px]",
                  row.emphasis ? "font-semibold text-(--text-primary)" : "text-(--text-secondary)",
                  row.shadowed && "text-(--text-muted)",
                )}
              >
                {row.fileName}
              </span>
              {row.statusLabel ? (
                <span
                  className={cn(
                    "shrink-0 text-[10px] font-medium",
                    row.shadowed ? "text-(--text-muted)" : "text-(--status-success-text)",
                  )}
                >
                  {row.statusLabel}
                </span>
              ) : null}
              {visibleType ? (
                <span className={cn("shrink-0 text-[10px] font-medium", TYPE_LABEL_CLASS[visibleType])}>
                  {getMemoryTypeLabel(visibleType, t)}
                </span>
              ) : null}
            </span>
            {row.description && !row.statusLabel ? (
              <span className="mt-0.5 block truncate text-[10px] leading-4 text-(--text-muted)">
                {row.description}
              </span>
            ) : null}
          </span>
        </button>
        {row.deletable && row.summary ? (
          <div className="pointer-events-none absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <Tooltip content={t("memoryPanel.rows.deleteMemory")}>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(row.summary ?? null);
                }}
                className="inline-flex rounded-md p-1 text-(--text-muted) hover:bg-(--chat-bg) hover:text-(--status-error-text)"
                aria-label={t("memoryPanel.rows.deleteFile", { fileName: row.fileName })}
                data-testid={`memory-delete-${row.fileName}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    );
  }

  function renderSection(section: MemorySection) {
    return (
      <section key={section.key} className="py-2" data-testid={`memory-section-${section.key}`}>
        <div className="px-3 pb-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 shrink-0">{section.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="truncate text-[11px] font-semibold uppercase text-(--text-secondary)">
                  {section.title}
                </p>
                <span className="shrink-0 font-mono text-[10px] text-(--text-muted) tabular-nums">
                  {section.rows.length}
                </span>
              </div>
              <p className="truncate text-[10px] leading-4 text-(--text-muted)">
                {section.description}
              </p>
              <p className="truncate font-mono text-[10px] leading-4 text-(--text-muted)" title={section.folderPath}>
                {section.folderPath}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col">
          {section.rows.length > 0 ? section.rows.map((row) => renderRow(row)) : (
            <div className="py-1.5 pl-8 pr-3 font-mono text-[10px] text-(--text-muted)">
              {section.emptyLabel ?? t("memoryPanel.empty.noFilesYet")}
            </div>
          )}
        </div>
      </section>
    );
  }

  if (!sessionId) {
    return (
      <EmptyState
        title={t("memoryPanel.empty.noSessionTitle")}
        body={t("memoryPanel.empty.noSessionBody")}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {state.loading && !state.data ? (
        <div className="flex h-full items-center justify-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : state.error ? (
        <EmptyState
          title={t("memoryPanel.empty.unavailableTitle")}
          body={state.error}
          icon="error"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void loadMemories()}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t("memoryPanel.actions.retry")}</span>
            </Button>
          }
        />
      ) : !hasVisibleRows ? (
        <EmptyState
          title={t("memoryPanel.empty.noFilesTitle")}
          body={t("memoryPanel.empty.noFilesBody", {
            path: state.data?.memoryDir ?? t("memoryPanel.empty.providerMemoryFolder"),
          })}
          action={canCreateProjectMemory ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t("memoryPanel.actions.newMemory")}</span>
            </Button>
          ) : null}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col divide-y divide-(--divider)">
            {sections.map((section) => renderSection(section))}
          </div>
        </ScrollArea>
      )}

      {contextMenu ? (
        <WorkspaceFileContextMenu
          absolutePath={contextMenu.absolutePath}
          canOpenFile={contextMenu.canOpenFile}
          onClose={() => setContextMenu(null)}
          position={contextMenu.position}
        />
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader onClose={() => setCreateOpen(false)}>
            <DialogTitle>{t("memoryPanel.dialog.newMemoryTitle")}</DialogTitle>
          </DialogHeader>
          <p className="mb-2 text-xs text-(--text-muted)">
            {t("memoryPanel.dialog.newMemoryDescription")}
          </p>
          <input
            autoFocus
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate();
            }}
            placeholder={t("memoryPanel.dialog.newMemoryPlaceholder")}
            className="h-9 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 text-sm text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent)"
            data-testid="memory-create-name-input"
          />
          {toMemoryFileSlug(createName) ? (
            <p className="mt-1.5 font-mono text-[11px] text-(--text-muted)">
              {toMemoryFileSlug(createName)}.md
            </p>
          ) : null}
          {createError ? (
            <p className="mt-1.5 text-xs text-(--status-error-text)">{createError}</p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleCreate()}
              disabled={creating || !toMemoryFileSlug(createName)}
              data-testid="memory-create-confirm"
            >
              {creating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              <span>{t("memoryPanel.actions.create")}</span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader onClose={() => setDeleteTarget(null)}>
            <DialogTitle>{t("memoryPanel.dialog.deleteMemoryTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-(--text-secondary)">
            {deleteTarget ? t("memoryPanel.dialog.deleteMemoryDescription", { fileName: deleteTarget.fileName }) : null}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={deleting}
              data-testid="memory-delete-confirm"
            >
              {deleting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              <span>{t("memoryPanel.actions.delete")}</span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
