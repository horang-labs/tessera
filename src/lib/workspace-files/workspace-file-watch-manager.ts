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
import {
  type BridgeEvent,
  isWslDistroRunning,
  parseWslUncRoot,
  WslInotifyBridge,
  type WslUncRoot,
} from "./wsl-inotify-bridge";

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;

type WatchStatus = "starting" | "active" | "fallback";
type WatchMode = "watch" | "poll";
type WatchEventName = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

interface WorkspaceFileSubscriber {
  connectionId: string;
  sendToUser: WsSendToUser;
  sessionId: string;
  subscriberId: string;
  userId: string;
}

interface WorkspaceRootChangeListener {
  listenerId: string;
  onChange: (root: string) => void;
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
  bridge: WslInotifyBridge | null;
  bridgeActive: boolean;
  closeTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  files: Set<string>;
  lastIndexedAt: number;
  pendingAddedPaths: Set<string>;
  pendingChangedPaths: Set<string>;
  pendingDeletedPaths: Set<string>;
  pendingEventsBeforeReady: PendingWatchEvent[];
  pendingHasMoreChangedPaths: boolean;
  pendingTreeChanged: boolean;
  pollTimer: NodeJS.Timeout | null;
  ready: boolean;
  readyPromise: Promise<void>;
  refreshing: boolean;
  root: string;
  rootChangeListeners: Map<string, WorkspaceRootChangeListener>;
  status: WatchStatus;
  subscribers: Map<string, WorkspaceFileSubscriber>;
  truncated: boolean;
  version: number;
  watchMode: WatchMode;
  watcher: FSWatcher | null;
  watcherReadyPromise: Promise<void>;
  wslRoot: WslUncRoot | null;
}

const CHANGE_DEBOUNCE_MS = 300;
const MAX_CHANGED_PATHS_PER_EVENT = 200;
// Sweep cadence for poll-mode roots. With a live inotify bridge the sweep is
// only a consistency backstop; without one it is the sole change source and
// must stay near-real-time.
const POLL_SWEEP_FAST_MS = 2_000;
const POLL_SWEEP_SLOW_MS = 60_000;
const POLL_UNUSED_GRACE_MS = 60_000;
const POLL_IDLE_CLOSE_MS = 5 * 60_000;

// Recursive fs watching over network redirectors (e.g. \\wsl.localhost via 9P)
// is unreliable: chokidar takes 10s+ to become ready, errors with EISDIR, and
// never reports changes. Those roots use a periodic re-walk instead of a watcher.
function isNetworkShareRoot(root: string): boolean {
  return root.startsWith("\\\\") || root.startsWith("//");
}

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

export class WorkspaceFileWatchManager {
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
    this.cancelScheduledClose(entry);

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

  async subscribeRootChanges(options: {
    listenerId: string;
    onChange: (root: string) => void;
    root: string;
  }): Promise<() => void> {
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(options.root);
    const entry = this.getOrCreateEntry(canonicalRoot);
    const listener: WorkspaceRootChangeListener = {
      listenerId: options.listenerId,
      onChange: options.onChange,
    };
    entry.rootChangeListeners.set(options.listenerId, listener);
    this.cancelScheduledClose(entry);

    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      if (entry.rootChangeListeners.get(options.listenerId) === listener) {
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
          entry.debounceTimer = null;
          this.flushChanges(entry);
        }
        entry.rootChangeListeners.delete(options.listenerId);
      }
      this.closeEntryIfUnused(entry);
    };

    // Return the disposer without waiting for chokidar readiness. A watcher on
    // an unavailable filesystem may never emit ready/error; terminal teardown
    // must still be able to remove the listener and close the watcher.
    void Promise.all([entry.readyPromise, entry.watcherReadyPromise]).then(() => {
      if (entry.rootChangeListeners.get(options.listenerId) !== listener) return;
      try {
        listener.onChange(entry.root);
      } catch (error) {
        logger.warn({ error, listenerId: listener.listenerId, root: entry.root }, "Workspace root change listener failed during initial refresh");
      }
    }).catch((error) => {
      logger.warn({ error, listenerId: listener.listenerId, root: entry.root }, "Workspace root change listener readiness failed");
    });

    return dispose;
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
    return this.serveSnapshot(entry);
  }

  /**
   * Like getIndexedSnapshotForRoot, but for network-share roots it also creates
   * and bootstraps the index on first use, so repeat requests are served from
   * memory instead of re-walking the share. Watch-capable roots keep the
   * passive behavior: no entry is created on behalf of a plain REST read.
   */
  async ensureSnapshotForRoot(root: string): Promise<WorkspaceFileWalkResult | null> {
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    const existing = this.entriesByRoot.get(canonicalRoot);
    if (!existing && !isNetworkShareRoot(canonicalRoot)) {
      return this.getIndexedSnapshotForRoot(canonicalRoot);
    }

    const entry = existing ?? this.getOrCreateEntry(canonicalRoot);
    await entry.readyPromise;
    if (entry.status !== "active" || entry.truncated) return null;
    return this.serveSnapshot(entry);
  }

  /** Fire-and-forget index prewarm for a session's network-share workspace. */
  warmSessionWorkspace(sessionId: string): void {
    void (async () => {
      const root = await this.resolveRootForSession(sessionId);
      if (!root || !isNetworkShareRoot(root)) return;
      const entry = this.getOrCreateEntry(root);
      this.touchEntry(entry);
      await entry.readyPromise;
    })().catch((error) => {
      logger.warn({ error, sessionId }, "Workspace index prewarm failed");
    });
  }

  private serveSnapshot(entry: WorkspaceWatchEntry): WorkspaceFileWalkResult {
    this.touchEntry(entry);
    const staleAfterMs = entry.bridgeActive ? POLL_SWEEP_SLOW_MS : POLL_SWEEP_FAST_MS;
    if (entry.watchMode === "poll" && Date.now() - entry.lastIndexedAt > staleAfterMs) {
      void this.refreshPollIndex(entry);
    }
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
      bridge: null,
      bridgeActive: false,
      closeTimer: null,
      debounceTimer: null,
      files: new Set(),
      lastIndexedAt: 0,
      pendingAddedPaths: new Set(),
      pendingChangedPaths: new Set(),
      pendingDeletedPaths: new Set(),
      pendingEventsBeforeReady: [],
      pendingHasMoreChangedPaths: false,
      pendingTreeChanged: false,
      pollTimer: null,
      ready: false,
      readyPromise: Promise.resolve(),
      refreshing: false,
      root,
      rootChangeListeners: new Map(),
      status: "starting",
      subscribers: new Map(),
      truncated: false,
      version: 0,
      watchMode: isNetworkShareRoot(root) ? "poll" : "watch",
      watcher: null,
      watcherReadyPromise: Promise.resolve(),
      wslRoot: parseWslUncRoot(root),
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
      entry.lastIndexedAt = Date.now();
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
    if (entry.watchMode === "poll") {
      this.setPollCadence(entry, POLL_SWEEP_FAST_MS);
      const useBridge = Boolean(entry.wslRoot && process.platform === "win32");
      if (entry.wslRoot && useBridge) {
        this.startBridge(entry, entry.wslRoot);
      }
      logger.info({
        root: entry.root,
        bridge: useBridge,
      }, "Workspace root is a network share; using poll-based indexing");
      return;
    }

    let resolveWatcherReady!: () => void;
    entry.watcherReadyPromise = new Promise<void>((resolve) => {
      resolveWatcherReady = resolve;
    });
    let watcherReadySettled = false;
    const markWatcherReady = () => {
      if (watcherReadySettled) return;
      watcherReadySettled = true;
      resolveWatcherReady();
    };

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

      watcher.on("ready", markWatcherReady);

      watcher.on("error", (error) => {
        markWatcherReady();
        entry.status = "fallback";
        logger.warn({ error, root: entry.root }, "Workspace file watcher failed; falling back to visible polling");
        this.emitWatchStatus(entry, "fallback", "watch_error");
      });

      entry.watcher = watcher;
    } catch (error) {
      markWatcherReady();
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

  private setPollCadence(entry: WorkspaceWatchEntry, intervalMs: number): void {
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    const timer = setInterval(() => {
      if (entry.subscribers.size === 0 && entry.rootChangeListeners.size === 0) return;
      void this.refreshPollIndex(entry);
    }, intervalMs);
    timer.unref?.();
    entry.pollTimer = timer;
  }

  private startBridge(entry: WorkspaceWatchEntry, wslRoot: WslUncRoot): void {
    const bridge = new WslInotifyBridge({
      root: wslRoot,
      onEvent: (event) => this.handleBridgeEvent(entry, event),
      onEstablished: () => {
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        entry.bridgeActive = true;
        this.setPollCadence(entry, POLL_SWEEP_SLOW_MS);
        // Reconcile anything that changed while watches were being set up.
        void this.refreshPollIndex(entry);
        logger.info({ root: entry.root, distro: wslRoot.distro }, "WSL inotify bridge established");
      },
      onDown: (reason) => {
        entry.bridgeActive = false;
        entry.bridge = null;
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        this.setPollCadence(entry, POLL_SWEEP_FAST_MS);
        logger.warn({
          root: entry.root,
          distro: wslRoot.distro,
          reason,
        }, "WSL inotify bridge unavailable; falling back to fast polling (install inotify-tools in the distro for real-time sync)");
      },
    });
    entry.bridge = bridge;
    bridge.start();
  }

  private handleBridgeEvent(entry: WorkspaceWatchEntry, event: BridgeEvent): void {
    const relativePath = normalizeWorkspaceRelativePath(event.relativePath);
    if (!relativePath || isIgnoredWorkspacePath(relativePath)) return;
    if (!entry.ready) {
      entry.pendingEventsBeforeReady.push({ eventName: event.eventName, relativePath });
      return;
    }
    this.applyWatchEvent(entry, event.eventName, relativePath);
    // A moved-in directory carries no per-file events; re-walk to pick up its
    // contents (refreshing flag coalesces bursts).
    if (event.eventName === "addDir") void this.refreshPollIndex(entry);
  }

  private async refreshPollIndex(entry: WorkspaceWatchEntry): Promise<void> {
    if (entry.refreshing || !entry.ready) return;
    // Touching \\wsl.localhost boots a stopped distro; after `wsl --shutdown`
    // stay quiet and serve the last snapshot until the distro is back.
    if (
      entry.wslRoot
      && process.platform === "win32"
      && !(await isWslDistroRunning(entry.wslRoot.distro))
    ) {
      return;
    }
    if (entry.refreshing || !entry.ready) return;
    entry.refreshing = true;
    try {
      const snapshot = await walkWorkspaceFiles(entry.root);
      if (this.entriesByRoot.get(entry.root) !== entry) return;
      const previous = entry.files;
      const next = new Set(snapshot.files);
      entry.files = next;
      entry.truncated = snapshot.truncated;
      entry.lastIndexedAt = Date.now();

      let changed = false;
      for (const filePath of next) {
        if (previous.has(filePath)) continue;
        changed = true;
        this.addPendingPath(entry, entry.pendingAddedPaths, filePath);
        this.addPendingPath(entry, entry.pendingChangedPaths, filePath);
      }
      for (const filePath of previous) {
        if (next.has(filePath)) continue;
        changed = true;
        this.addPendingPath(entry, entry.pendingDeletedPaths, filePath);
        this.addPendingPath(entry, entry.pendingChangedPaths, filePath);
      }
      if (changed) {
        entry.pendingTreeChanged = true;
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
          entry.debounceTimer = null;
        }
        this.flushChanges(entry);
      }
    } catch (error) {
      logger.warn({ error, root: entry.root }, "Workspace poll index refresh failed");
    } finally {
      entry.refreshing = false;
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
    if (entry.subscribers.size === 0 && entry.rootChangeListeners.size === 0) return;

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

    for (const listener of entry.rootChangeListeners.values()) {
      try {
        listener.onChange(entry.root);
      } catch (error) {
        logger.warn({ error, listenerId: listener.listenerId, root: entry.root }, "Workspace root change listener failed");
      }
    }

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

  private touchEntry(entry: WorkspaceWatchEntry): void {
    if (entry.watchMode !== "poll") return;
    if (entry.subscribers.size > 0 || entry.rootChangeListeners.size > 0) return;
    this.scheduleClose(entry, POLL_IDLE_CLOSE_MS);
  }

  private scheduleClose(entry: WorkspaceWatchEntry, delayMs: number): void {
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    const timer = setTimeout(() => {
      entry.closeTimer = null;
      this.closeEntryNow(entry);
    }, delayMs);
    timer.unref?.();
    entry.closeTimer = timer;
  }

  private cancelScheduledClose(entry: WorkspaceWatchEntry): void {
    if (!entry.closeTimer) return;
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }

  private closeEntryIfUnused(entry: WorkspaceWatchEntry): void {
    if (entry.subscribers.size > 0 || entry.rootChangeListeners.size > 0) {
      this.cancelScheduledClose(entry);
      return;
    }

    // Poll-mode entries are expensive to rebuild (a full walk over a network
    // share), so keep them warm briefly for quick tab re-entry. Watcher-backed
    // entries keep the original immediate teardown.
    if (entry.watchMode === "poll") {
      this.scheduleClose(entry, POLL_UNUSED_GRACE_MS);
      return;
    }
    this.closeEntryNow(entry);
  }

  private closeEntryNow(entry: WorkspaceWatchEntry): void {
    if (entry.subscribers.size > 0 || entry.rootChangeListeners.size > 0) return;

    this.cancelScheduledClose(entry);
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    if (entry.bridge) {
      entry.bridge.stop();
      entry.bridge = null;
      entry.bridgeActive = false;
    }
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
