import * as fs from "fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import logger from "@/lib/logger";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import type { ServerTransportMessage } from "@/lib/ws/message-types";
import {
  applyMaxFiles,
  isIgnoredWorkspacePath,
  normalizeWorkspaceRelativePath,
  type WorkspaceFileWalkResult,
  walkWorkspaceFiles,
} from "./workspace-file-scan";

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;

type WatchStatus = "starting" | "active" | "fallback";
type WatchEventName = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

interface WorkspaceFileSubscriber {
  connectionId: string;
  sendToUser: WsSendToUser;
  sessionId: string;
  subscriberId: string;
  userId: string;
}

interface PendingWatchEvent {
  eventName: WatchEventName;
  relativePath: string;
}

interface WatchEventStats {
  isDirectory(): boolean;
  isFile(): boolean;
}

interface WorkspaceWatchEntry {
  debounceTimer: NodeJS.Timeout | null;
  files: Set<string>;
  pendingAddedPaths: Set<string>;
  pendingChangedPaths: Set<string>;
  pendingDeletedPaths: Set<string>;
  pendingEventsBeforeReady: PendingWatchEvent[];
  pendingHasMoreChangedPaths: boolean;
  pendingTreeChanged: boolean;
  ready: boolean;
  readyPromise: Promise<void>;
  root: string;
  status: WatchStatus;
  subscribers: Map<string, WorkspaceFileSubscriber>;
  truncated: boolean;
  version: number;
  watcher: FSWatcher | null;
}

const CHANGE_DEBOUNCE_MS = 300;
const MAX_CHANGED_PATHS_PER_EVENT = 200;

function subscriberKey(connectionId: string, sessionId: string, subscriberId: string): string {
  return `${connectionId}:${sessionId}:${subscriberId}`;
}

async function resolveCanonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return root;
  }
}

function uniqueSessionIds(subscribers: Iterable<WorkspaceFileSubscriber>): string[] {
  return Array.from(new Set(Array.from(subscribers, (subscriber) => subscriber.sessionId)));
}

function toWorkspaceRelativePath(root: string, filePath: string): string {
  const pathModule = getFilesystemPathModule(root);
  const relativePath = pathModule.isAbsolute(filePath)
    ? pathModule.relative(root, filePath)
    : filePath;
  return normalizeWorkspaceRelativePath(relativePath);
}

class WorkspaceFileWatchManager {
  private readonly canceledSubscriberKeys = new Set<string>();
  private readonly closedConnectionIds = new Set<string>();
  private readonly closedConnectionCleanupTimers = new Map<string, NodeJS.Timeout>();
  private readonly entriesByRoot = new Map<string, WorkspaceWatchEntry>();
  private readonly rootBySessionId = new Map<string, string>();

  async subscribe(options: {
    connectionId: string;
    sendToUser: WsSendToUser;
    sessionId: string;
    subscriberId: string;
    userId: string;
  }): Promise<void> {
    const key = subscriberKey(options.connectionId, options.sessionId, options.subscriberId);
    if (this.closedConnectionIds.has(options.connectionId)) {
      return;
    }

    const root = await this.resolveRootForSession(options.sessionId);
    if (this.closedConnectionIds.has(options.connectionId) || this.canceledSubscriberKeys.delete(key)) {
      return;
    }
    if (!root) {
      options.sendToUser(options.userId, {
        type: "workspace_file_watch_status",
        sessionId: options.sessionId,
        subscriberId: options.subscriberId,
        status: "fallback",
        reason: "missing_work_dir",
      });
      return;
    }

    const entry = this.getOrCreateEntry(root);
    entry.subscribers.set(key, options);

    options.sendToUser(options.userId, {
      type: "workspace_file_watch_status",
      sessionId: options.sessionId,
      subscriberId: options.subscriberId,
      workDir: entry.root,
      status: entry.status === "active" ? "active" : "starting",
      version: entry.version,
    });

    void entry.readyPromise.then(() => {
      const current = entry.subscribers.get(
        key,
      );
      if (!current) return;
      current.sendToUser(current.userId, {
        type: "workspace_file_watch_status",
        sessionId: current.sessionId,
        subscriberId: current.subscriberId,
        workDir: entry.root,
        status: entry.status === "active" ? "active" : "fallback",
        version: entry.version,
      });
    }).catch((error) => {
      logger.warn({ error, root: entry.root }, "Workspace file watch bootstrap failed");
    });
  }

  unsubscribe(options: {
    connectionId: string;
    sessionId: string;
    subscriberId: string;
  }): void {
    const key = subscriberKey(options.connectionId, options.sessionId, options.subscriberId);
    const root = this.rootBySessionId.get(options.sessionId);
    if (!root) {
      this.canceledSubscriberKeys.add(key);
      return;
    }

    const entry = this.entriesByRoot.get(root);
    if (!entry) {
      this.canceledSubscriberKeys.add(key);
      return;
    }

    const removed = entry.subscribers.delete(key);
    if (!removed) {
      this.canceledSubscriberKeys.add(key);
    }
    this.closeEntryIfUnused(entry);
  }

  unsubscribeConnection(connectionId: string): void {
    this.rememberClosedConnection(connectionId);
    for (const key of Array.from(this.canceledSubscriberKeys)) {
      if (key.startsWith(`${connectionId}:`)) {
        this.canceledSubscriberKeys.delete(key);
      }
    }
    for (const entry of Array.from(this.entriesByRoot.values())) {
      for (const [key, subscriber] of Array.from(entry.subscribers.entries())) {
        if (subscriber.connectionId === connectionId) {
          entry.subscribers.delete(key);
        }
      }
      this.closeEntryIfUnused(entry);
    }
  }

  private rememberClosedConnection(connectionId: string): void {
    this.closedConnectionIds.add(connectionId);
    const existingTimer = this.closedConnectionCleanupTimers.get(connectionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.closedConnectionIds.delete(connectionId);
      this.closedConnectionCleanupTimers.delete(connectionId);
    }, 60_000);
    timer.unref?.();
    this.closedConnectionCleanupTimers.set(connectionId, timer);
  }

  async getIndexedSnapshotForRoot(root: string): Promise<WorkspaceFileWalkResult | null> {
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    const entry = this.entriesByRoot.get(canonicalRoot);
    if (!entry || entry.status !== "active" || entry.truncated) return null;

    await entry.readyPromise;
    if (entry.status !== "active" || entry.truncated) return null;
    return applyMaxFiles(entry.files);
  }

  private async resolveRootForSession(sessionId: string): Promise<string | null> {
    const root = await resolveSessionWorkspaceFilesystemRoot(sessionId);
    if (!root) return null;
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    this.rootBySessionId.set(sessionId, canonicalRoot);
    return canonicalRoot;
  }

  private getOrCreateEntry(root: string): WorkspaceWatchEntry {
    const existing = this.entriesByRoot.get(root);
    if (existing) return existing;

    const entry: WorkspaceWatchEntry = {
      debounceTimer: null,
      files: new Set(),
      pendingAddedPaths: new Set(),
      pendingChangedPaths: new Set(),
      pendingDeletedPaths: new Set(),
      pendingEventsBeforeReady: [],
      pendingHasMoreChangedPaths: false,
      pendingTreeChanged: false,
      ready: false,
      readyPromise: Promise.resolve(),
      root,
      status: "starting",
      subscribers: new Map(),
      truncated: false,
      version: 0,
      watcher: null,
    };
    this.entriesByRoot.set(root, entry);
    this.startWatcher(entry);
    entry.readyPromise = this.bootstrapEntry(entry);
    return entry;
  }

  private async bootstrapEntry(entry: WorkspaceWatchEntry): Promise<void> {
    try {
      const snapshot = await walkWorkspaceFiles(entry.root);
      entry.files = new Set(snapshot.files);
      entry.truncated = snapshot.truncated;
      entry.ready = true;

      const pending = entry.pendingEventsBeforeReady.splice(0);
      for (const event of pending) {
        this.applyWatchEvent(entry, event.eventName, event.relativePath);
      }

      if (entry.status !== "fallback") {
        entry.status = "active";
      }
      logger.info({
        root: entry.root,
        files: entry.files.size,
        truncated: entry.truncated,
      }, "Workspace file watch index ready");
    } catch (error) {
      entry.status = "fallback";
      logger.warn({ error, root: entry.root }, "Failed to bootstrap workspace file index");
    }
  }

  private startWatcher(entry: WorkspaceWatchEntry): void {
    try {
      const watcher = chokidar.watch(entry.root, {
        atomic: true,
        awaitWriteFinish: false,
        cwd: entry.root,
        followSymlinks: false,
        ignoreInitial: true,
        ignored: (filePath, stats) => (
          isIgnoredWorkspacePath(toWorkspaceRelativePath(entry.root, String(filePath)), stats)
        ),
        persistent: true,
      });

      watcher.on("all", (eventName, filePath, stats?: WatchEventStats) => {
        if (!this.isWatchEventName(eventName)) return;
        if (!this.isWatchEventShape(eventName, stats)) return;
        const relativePath = toWorkspaceRelativePath(entry.root, String(filePath));
        if (!relativePath || isIgnoredWorkspacePath(relativePath)) return;
        if (!entry.ready) {
          entry.pendingEventsBeforeReady.push({ eventName, relativePath });
          return;
        }
        this.applyWatchEvent(entry, eventName, relativePath);
      });

      watcher.on("error", (error) => {
        entry.status = "fallback";
        logger.warn({ error, root: entry.root }, "Workspace file watcher failed; falling back to visible polling");
        this.emitWatchStatus(entry, "fallback", "watch_error");
      });

      entry.watcher = watcher;
    } catch (error) {
      entry.status = "fallback";
      logger.warn({ error, root: entry.root }, "Failed to start workspace file watcher");
      this.emitWatchStatus(entry, "fallback", "watch_start_failed");
    }
  }

  private isWatchEventName(eventName: string): eventName is WatchEventName {
    return eventName === "add"
      || eventName === "addDir"
      || eventName === "change"
      || eventName === "unlink"
      || eventName === "unlinkDir";
  }

  private isWatchEventShape(eventName: WatchEventName, stats?: WatchEventStats): boolean {
    if (!stats) return true;
    if (eventName === "add" || eventName === "change") return stats.isFile();
    if (eventName === "addDir") return stats.isDirectory();
    return true;
  }

  private applyWatchEvent(
    entry: WorkspaceWatchEntry,
    eventName: WatchEventName,
    relativePath: string,
  ): void {
    switch (eventName) {
      case "add":
        entry.files.add(relativePath);
        this.scheduleChange(entry, relativePath, {
          added: true,
          treeChanged: true,
        });
        return;
      case "unlink":
        entry.files.delete(relativePath);
        this.scheduleChange(entry, relativePath, {
          deleted: true,
          treeChanged: true,
        });
        return;
      case "unlinkDir": {
        const prefix = `${relativePath}/`;
        const deletedPaths: string[] = [];
        for (const filePath of Array.from(entry.files)) {
          if (filePath.startsWith(prefix)) {
            entry.files.delete(filePath);
            deletedPaths.push(filePath);
          }
        }
        this.scheduleChange(entry, relativePath, {
          deleted: true,
          deletedPaths,
          treeChanged: true,
        });
        return;
      }
      case "addDir":
        this.scheduleChange(entry, relativePath, { treeChanged: true });
        return;
      case "change":
        this.scheduleChange(entry, relativePath, { treeChanged: false });
        return;
    }
  }

  private scheduleChange(
    entry: WorkspaceWatchEntry,
    relativePath: string,
    options: {
      added?: boolean;
      deleted?: boolean;
      deletedPaths?: string[];
      treeChanged: boolean;
    },
  ): void {
    if (options.treeChanged) {
      entry.pendingTreeChanged = true;
    }
    this.addPendingPath(entry, entry.pendingChangedPaths, relativePath);
    if (options.added) this.addPendingPath(entry, entry.pendingAddedPaths, relativePath);
    if (options.deleted) this.addPendingPath(entry, entry.pendingDeletedPaths, relativePath);
    for (const deletedPath of options.deletedPaths ?? []) {
      this.addPendingPath(entry, entry.pendingDeletedPaths, deletedPath);
    }

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = setTimeout(() => this.flushChanges(entry), CHANGE_DEBOUNCE_MS);
  }

  private addPendingPath(
    entry: WorkspaceWatchEntry,
    target: Set<string>,
    relativePath: string,
  ): void {
    if (target.size < MAX_CHANGED_PATHS_PER_EVENT) {
      target.add(relativePath);
    } else {
      entry.pendingHasMoreChangedPaths = true;
    }
  }

  private flushChanges(entry: WorkspaceWatchEntry): void {
    entry.debounceTimer = null;
    if (entry.subscribers.size === 0) return;

    entry.version += 1;
    const changedPaths = Array.from(entry.pendingChangedPaths)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const addedPaths = Array.from(entry.pendingAddedPaths)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const deletedPaths = Array.from(entry.pendingDeletedPaths)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const treeChanged = entry.pendingTreeChanged;
    const hasMoreChangedPaths = entry.pendingHasMoreChangedPaths;

    entry.pendingAddedPaths.clear();
    entry.pendingChangedPaths.clear();
    entry.pendingDeletedPaths.clear();
    entry.pendingTreeChanged = false;
    entry.pendingHasMoreChangedPaths = false;

    const subscribersByUser = new Map<string, WorkspaceFileSubscriber[]>();
    for (const subscriber of entry.subscribers.values()) {
      const subscribers = subscribersByUser.get(subscriber.userId) ?? [];
      subscribers.push(subscriber);
      subscribersByUser.set(subscriber.userId, subscribers);
    }

    for (const [userId, subscribers] of subscribersByUser.entries()) {
      const sendToUser = subscribers[0]?.sendToUser;
      if (!sendToUser) continue;
      sendToUser(userId, {
        type: "workspace_files_changed",
        workDir: entry.root,
        sessionIds: uniqueSessionIds(subscribers),
        version: entry.version,
        treeChanged,
        changedPaths,
        addedPaths,
        deletedPaths,
        hasMoreChangedPaths,
      });
    }
  }

  private emitWatchStatus(
    entry: WorkspaceWatchEntry,
    status: Extract<WatchStatus, "active" | "fallback">,
    reason?: string,
  ): void {
    for (const subscriber of entry.subscribers.values()) {
      subscriber.sendToUser(subscriber.userId, {
        type: "workspace_file_watch_status",
        sessionId: subscriber.sessionId,
        subscriberId: subscriber.subscriberId,
        workDir: entry.root,
        status,
        version: entry.version,
        ...(reason ? { reason } : {}),
      });
    }
  }

  private closeEntryIfUnused(entry: WorkspaceWatchEntry): void {
    if (entry.subscribers.size > 0) return;

    this.entriesByRoot.delete(entry.root);
    for (const [sessionId, root] of Array.from(this.rootBySessionId.entries())) {
      if (root === entry.root) {
        this.rootBySessionId.delete(sessionId);
      }
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    const watcher = entry.watcher;
    entry.watcher = null;
    if (watcher) {
      void watcher.close().catch((error) => {
        logger.warn({ error, root: entry.root }, "Failed to close workspace file watcher");
      });
    }
    logger.info({ root: entry.root }, "Workspace file watcher closed");
  }
}

export const workspaceFileWatchManager = new WorkspaceFileWatchManager();
