import * as fs from "fs/promises";
import { startNativeWorkspaceWatcher } from "./native-workspace-watcher";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import logger from "@/lib/logger";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import type { AgentEnvironment } from "@/lib/settings/types";
import type { ServerTransportMessage } from "@/lib/ws/message-types";
import {
  applyMaxFiles,
  isIgnoredWorkspacePath,
  MAX_WORKSPACE_FILES,
  normalizeWorkspaceRelativePath,
  scanWorkspaceDirectory,
  type WorkspaceFileWalkResult,
  walkWorkspaceFiles,
  workspaceRelativeDirname,
} from "./workspace-file-scan";
import {
  buildInotifyExcludeRegex,
  type BridgeEvent,
  parseWslUncRoot,
  sharedWslInotifyBridgePool,
  type WslInotifyBridgeOptions,
  type WslUncRoot,
} from "./wsl-inotify-bridge";

type WsSendToUser = (userId: string, message: ServerTransportMessage) => void;

type WatchStatus = "starting" | "active" | "fallback";
type WatchMode = "watch" | "wsl-bridge";

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

interface WorkspaceWatchEntry {
  bridge: { stop(): void } | null;
  debounceTimer: NodeJS.Timeout | null;
  /**
   * Directories in their own right. A folder with no files in it changes no
   * file path, so without this set an empty one is invisible to the index and
   * its creation would never reach a subscriber.
   */
  directories: Set<string>;
  files: Set<string>;
  pendingAddedPaths: Set<string>;
  pendingChangedPaths: Set<string>;
  pendingDeletedPaths: Set<string>;
  pendingHasMoreChangedPaths: boolean;
  /** Directories to re-read, mapped to whether the whole subtree is suspect. */
  pendingRescanDirs: Map<string, boolean>;
  pendingTreeChanged: boolean;
  ready: boolean;
  readyPromise: Promise<void>;
  rescanning: boolean;
  root: string;
  rootChangeListeners: Map<string, WorkspaceRootChangeListener>;
  status: WatchStatus;
  subscribers: Map<string, WorkspaceFileSubscriber>;
  symlinks: Set<string>;
  truncated: boolean;
  version: number;
  watchMode: WatchMode;
  watcher: ReturnType<typeof startNativeWorkspaceWatcher> | null;
  watcherReadyPromise: Promise<void>;
  wslRoot: WslUncRoot | null;
}

const CHANGE_DEBOUNCE_MS = 300;
const MAX_CHANGED_PATHS_PER_EVENT = 200;

// Recursive watching through the Windows WSL 9P redirector is unreliable:
// chokidar takes 10s+ to become ready, emits EISDIR storms, and starves the
// server event loop that also carries PTY input. Keep unrelated SMB shares on
// their existing watcher path; only Windows-hosted WSL roots use the bridge.
export function isWindowsHostedWslRoot(root: string): boolean {
  return parseWslUncRoot(root) !== null;
}

function subscriberKey(connectionId: string, sessionId: string, subscriberId: string): string {
  return `${connectionId}:${sessionId}:${subscriberId}`;
}

async function resolveCanonicalWorkspaceRoot(root: string): Promise<string> {
  // Resolving a WSL UNC path asks the Windows redirector to traverse into WSL
  // before the guest-side watcher even starts. The session resolver already
  // supplies the canonical UNC spelling, so keep registration independent of
  // that avoidable network filesystem operation.
  if (parseWslUncRoot(root)) return root;
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

  constructor(private readonly runtime: {
    platform: NodeJS.Platform;
    acquireWslBridge(options: WslInotifyBridgeOptions): { stop(): void };
  } = {
    platform: process.platform,
    acquireWslBridge: (options) => sharedWslInotifyBridgePool.acquire(options),
  }) {}

  async subscribe(options: {
    agentEnvironment: AgentEnvironment;
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

    const root = await this.resolveRootForSession(
      options.sessionId,
      options.agentEnvironment,
    );
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
        status: entry.status,
        version: entry.version,
      });
      // The first HTTP listing may precede watcher establishment. Refresh the
      // directories the client already loaded once event delivery is live.
      current.sendToUser(current.userId, {
        type: "workspace_files_changed",
        workDir: entry.root,
        sessionIds: [current.sessionId],
        version: entry.version,
        treeChanged: true,
        changedPaths: [],
        addedPaths: [],
        deletedPaths: [],
        hasMoreChangedPaths: false,
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
    if (
      !entry
      || entry.watchMode === "wsl-bridge"
      || entry.status !== "active"
      || entry.truncated
    ) return null;

    await entry.readyPromise;
    if (entry.status !== "active" || entry.truncated) return null;
    return applyMaxFiles(entry.files, entry.symlinks, entry.directories);
  }

  /**
   * Watch-backed indexes are an optimization for native roots only. WSL roots
   * deliberately stay out of the recursive index: their file explorer reads
   * one visible directory at a time, while an explicit global-search request
   * performs its own walk.
   */
  async ensureSnapshotForRoot(root: string): Promise<WorkspaceFileWalkResult | null> {
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    if (isWindowsHostedWslRoot(canonicalRoot)) return null;
    return this.getIndexedSnapshotForRoot(canonicalRoot);
  }

  private async resolveRootForSession(
    sessionId: string,
    agentEnvironment: AgentEnvironment,
  ): Promise<string | null> {
    const root = await resolveSessionWorkspaceFilesystemRoot(sessionId, {
      agentEnvironment,
    });
    if (!root) return null;
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    this.rootBySessionId.set(sessionId, canonicalRoot);
    return canonicalRoot;
  }

  private getOrCreateEntry(root: string): WorkspaceWatchEntry {
    const existing = this.entriesByRoot.get(root);
    if (existing) return existing;
    const wslRoot = parseWslUncRoot(root);

    const entry: WorkspaceWatchEntry = {
      bridge: null,
      debounceTimer: null,
      directories: new Set(),
      files: new Set(),
      pendingAddedPaths: new Set(),
      pendingChangedPaths: new Set(),
      pendingDeletedPaths: new Set(),
      pendingHasMoreChangedPaths: false,
      pendingRescanDirs: new Map(),
      pendingTreeChanged: false,
      ready: false,
      readyPromise: Promise.resolve(),
      rescanning: false,
      root,
      rootChangeListeners: new Map(),
      status: "starting",
      subscribers: new Map(),
      symlinks: new Set(),
      truncated: false,
      version: 0,
      watchMode: wslRoot ? "wsl-bridge" : "watch",
      watcher: null,
      watcherReadyPromise: Promise.resolve(),
      wslRoot,
    };
    this.entriesByRoot.set(root, entry);
    this.startWatcher(entry);
    entry.readyPromise = this.bootstrapEntry(entry);
    return entry;
  }

  private async bootstrapEntry(entry: WorkspaceWatchEntry): Promise<void> {
    await entry.watcherReadyPromise;
    if (this.entriesByRoot.get(entry.root) !== entry) return;
    if (entry.watchMode === "wsl-bridge") {
      entry.ready = true;
      if (entry.status !== "fallback") entry.status = "active";
      logger.info({
        root: entry.root,
        distro: entry.wslRoot?.distro,
      }, "WSL workspace watcher ready without recursive indexing");
      return;
    }
    try {
      const snapshot = await walkWorkspaceFiles(entry.root);
      entry.directories = new Set(snapshot.directories);
      entry.files = new Set(snapshot.files);
      entry.symlinks = new Set(snapshot.symlinks);
      entry.truncated = snapshot.truncated;
      entry.ready = true;

      if (entry.status !== "fallback") {
        entry.status = "active";
      }
      logger.info({
        root: entry.root,
        files: entry.files.size,
        truncated: entry.truncated,
      }, "Workspace file watch index ready");
    } catch (error) {
      // Still ready: the index is empty and `status` keeps callers off it.
      entry.ready = true;
      entry.status = "fallback";
      logger.warn({ error, root: entry.root }, "Failed to bootstrap workspace file index");
    }

    void this.runPendingRescans(entry);
  }

  private startWatcher(entry: WorkspaceWatchEntry): void {
    if (entry.watchMode === "wsl-bridge") {
      const useBridge = Boolean(entry.wslRoot && this.runtime.platform === "win32");
      if (entry.wslRoot && useBridge) {
        this.startBridge(entry, entry.wslRoot);
      } else {
        entry.status = "fallback";
      }
      logger.info({
        root: entry.root,
        bridge: useBridge,
      }, "Workspace root is a WSL share; using event-only bridge watching");
      return;
    }

    const fail = (error: unknown) => {
      if (this.entriesByRoot.get(entry.root) !== entry) return;
      entry.status = "fallback";
      const watcher = entry.watcher;
      entry.watcher = null;
      void watcher?.close().catch((closeError) => {
        logger.warn({ error: closeError }, "Failed to close workspace file watcher");
      });
      this.emitWatchStatus(entry, "fallback", "watch_error");
      logger.warn({ error, root: entry.root }, "Workspace native watcher failed");
    };
    const watcher = startNativeWorkspaceWatcher(entry.root, (error, events) => {
      if (this.entriesByRoot.get(entry.root) !== entry) return;
      if (error) { fail(error); return; }
      for (const event of events) {
        const relativePath = toWorkspaceRelativePath(entry.root, event.path);
        if (!relativePath || isIgnoredWorkspacePath(relativePath, undefined, { includeHidden: true })) continue;
        if (event.type === "update") {
          this.addPendingPath(entry, entry.pendingChangedPaths, relativePath);
        }
        // Parcel does not attach stat information. Reconcile create/delete
        // subtrees too: moved-in directories may arrive without child events.
        if (event.type !== "update" && !isIgnoredWorkspacePath(
          relativePath, { isDirectory: () => true }, { includeHidden: true },
        )) this.invalidateDirectory(entry, relativePath, true);
        this.invalidateDirectory(entry, workspaceRelativeDirname(relativePath), false);
      }
    });
    entry.watcher = watcher;
    entry.watcherReadyPromise = watcher.ready.catch(fail);
  }

  private invalidateDirectory(
    entry: WorkspaceWatchEntry,
    relativeDir: string,
    recursive: boolean,
  ): void {
    const existing = entry.pendingRescanDirs.get(relativeDir);
    entry.pendingRescanDirs.set(relativeDir, Boolean(existing) || recursive);

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    const timer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.runPendingRescans(entry);
    }, CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    entry.debounceTimer = timer;
  }

  /**
   * Re-read every invalidated directory, then publish what actually changed.
   *
   * Directories invalidated while this runs are picked up by the loop rather
   * than dropped: an in-flight scan read the tree as it was before they were
   * queued, so letting it stand for them would lose exactly the writes that
   * arrive in bursts.
   */
  private async runPendingRescans(entry: WorkspaceWatchEntry): Promise<void> {
    // Nothing to reconcile against until the initial walk lands; the events are
    // still queued and replay into invalidations once it does.
    if (!entry.ready || entry.rescanning || entry.pendingRescanDirs.size === 0) return;

    entry.rescanning = true;
    let changed = false;
    try {
      while (entry.pendingRescanDirs.size > 0) {
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        const targets = Array.from(entry.pendingRescanDirs.entries());
        entry.pendingRescanDirs.clear();

        // Shallowest first, so a subtree rescan subsumes the individual
        // directories under it instead of racing them.
        targets.sort(([a], [b]) => a.length - b.length);
        for (const [relativeDir, recursive] of targets) {
          if (this.entriesByRoot.get(entry.root) !== entry) return;
          if (await this.rescanDirectory(entry, relativeDir, recursive)) changed = true;
        }
      }
    } catch (error) {
      logger.warn({ error, root: entry.root }, "Workspace directory rescan failed");
    } finally {
      entry.rescanning = false;
    }

    if (!changed) {
      // The index only records paths, so writing new content to an existing
      // file leaves the rescan unchanged. Open editors still need the changed
      // path, while Git listeners need invalidation even without a path delta.
      if (entry.pendingChangedPaths.size > 0 || entry.pendingHasMoreChangedPaths) {
        this.flushChanges(entry);
      } else {
        this.notifyRootChangeListeners(entry);
      }
      return;
    }
    entry.pendingTreeChanged = true;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    this.flushChanges(entry);
  }

  /** Reconcile the index for one directory with what is on disk right now. */
  private async rescanDirectory(
    entry: WorkspaceWatchEntry,
    relativeDir: string,
    recursive: boolean,
  ): Promise<boolean> {
    const result = await scanWorkspaceDirectory(entry.root, relativeDir, {
      limit: MAX_WORKSPACE_FILES,
      recursive,
    });
    if (this.entriesByRoot.get(entry.root) !== entry) return false;

    const prefix = relativeDir ? `${relativeDir}/` : "";
    // A directory that is gone takes its whole subtree with it, whatever the
    // event claimed to be about.
    const wholeSubtree = recursive || result.missing;
    const inScope = (filePath: string): boolean => {
      if (prefix && !filePath.startsWith(prefix)) return false;
      if (wholeSubtree) return true;
      return filePath.indexOf("/", prefix.length) === -1;
    };

    const previous = new Set<string>();
    for (const filePath of entry.files) {
      if (inScope(filePath)) previous.add(filePath);
    }
    const next = new Set(result.missing ? [] : result.files);
    const nextSymlinks = new Set(result.missing ? [] : result.symlinks);

    let changed = this.reconcileDirectories(entry, relativeDir, inScope, result);
    for (const filePath of previous) {
      if (next.has(filePath)) continue;
      entry.files.delete(filePath);
      entry.symlinks.delete(filePath);
      this.addPendingPath(entry, entry.pendingDeletedPaths, filePath);
      this.addPendingPath(entry, entry.pendingChangedPaths, filePath);
      changed = true;
    }
    for (const filePath of next) {
      if (!previous.has(filePath)) {
        entry.files.add(filePath);
        this.addPendingPath(entry, entry.pendingAddedPaths, filePath);
        this.addPendingPath(entry, entry.pendingChangedPaths, filePath);
        changed = true;
      }
      // A path swapped between a real file and a link keeps its name, so only
      // the marker moves — the badge would stay stale without this.
      if (nextSymlinks.has(filePath)) {
        if (!entry.symlinks.has(filePath)) {
          entry.symlinks.add(filePath);
          changed = true;
        }
      } else if (entry.symlinks.delete(filePath)) {
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Bring the directory index in line with one rescanned scope.
   *
   * Directory names stay out of `addedPaths` / `deletedPaths`: those lists are
   * read as file paths — the file tab treats a lone delete+add pair as a rename
   * of *its* file — so a folder appearing there would be mistaken for one. A
   * directory change is a tree change and nothing more.
   */
  private reconcileDirectories(
    entry: WorkspaceWatchEntry,
    relativeDir: string,
    inScope: (relativePath: string) => boolean,
    result: { directories: string[]; missing: boolean },
  ): boolean {
    // The scanned directory itself is inside its own scope: it is what goes
    // away when the scan reports the directory missing.
    const inDirectoryScope = (dirPath: string): boolean =>
      (Boolean(relativeDir) && dirPath === relativeDir) || inScope(dirPath);

    const nextDirectories = new Set(result.missing ? [] : result.directories);
    if (!result.missing && relativeDir) nextDirectories.add(relativeDir);

    let changed = false;
    for (const dirPath of entry.directories) {
      if (!inDirectoryScope(dirPath) || nextDirectories.has(dirPath)) continue;
      entry.directories.delete(dirPath);
      changed = true;
    }
    for (const dirPath of nextDirectories) {
      if (entry.directories.has(dirPath)) continue;
      entry.directories.add(dirPath);
      changed = true;
    }
    return changed;
  }

  private startBridge(entry: WorkspaceWatchEntry, wslRoot: WslUncRoot): void {
    let resolveFirstEstablished!: () => void;
    let firstEstablished = false;
    entry.watcherReadyPromise = new Promise<void>((resolve) => {
      resolveFirstEstablished = resolve;
    });
    const bridge = this.runtime.acquireWslBridge({
      root: wslRoot,
      excludeRegex: buildInotifyExcludeRegex(wslRoot.posixPath),
      onEvent: (event) => this.handleBridgeEvent(entry, event),
      onEstablished: () => {
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        entry.status = "active";
        if (!firstEstablished) {
          firstEstablished = true;
          resolveFirstEstablished();
        } else {
          // The bridge was temporarily disconnected. Refresh only directories
          // the UI already has open; do not walk the workspace to guess what
          // happened during the gap.
          entry.pendingTreeChanged = true;
          this.scheduleChangeFlush(entry);
          this.emitWatchStatus(entry, "active");
        }
        logger.info({ root: entry.root, distro: wslRoot.distro }, "WSL inotify bridge established");
      },
      onDown: (reason) => {
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        entry.status = "starting";
        this.emitWatchStatus(entry, "starting", "wsl_bridge_reconnecting");
        logger.warn({
          root: entry.root,
          distro: wslRoot.distro,
          reason,
        }, "WSL inotify bridge unavailable; waiting for watcher re-registration");
      },
    });
    entry.bridge = bridge;
  }

  private handleBridgeEvent(entry: WorkspaceWatchEntry, event: BridgeEvent): void {
    const relativePath = normalizeWorkspaceRelativePath(event.relativePath);
    if (!relativePath || isIgnoredWorkspacePath(relativePath, undefined, { includeHidden: true })) return;
    switch (event.eventName) {
      case "add":
        this.addPendingPath(entry, entry.pendingAddedPaths, relativePath);
        this.addPendingPath(entry, entry.pendingChangedPaths, relativePath);
        entry.pendingTreeChanged = true;
        break;
      case "unlink":
        this.addPendingPath(entry, entry.pendingDeletedPaths, relativePath);
        this.addPendingPath(entry, entry.pendingChangedPaths, relativePath);
        entry.pendingTreeChanged = true;
        break;
      case "change":
        this.addPendingPath(entry, entry.pendingChangedPaths, relativePath);
        break;
      case "addDir":
      case "unlinkDir":
        entry.pendingTreeChanged = true;
        break;
    }
    this.scheduleChangeFlush(entry);
  }

  private scheduleChangeFlush(entry: WorkspaceWatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    const timer = setTimeout(() => {
      entry.debounceTimer = null;
      this.flushChanges(entry);
    }, CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    entry.debounceTimer = timer;
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

    this.notifyRootChangeListeners(entry);

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

  private notifyRootChangeListeners(entry: WorkspaceWatchEntry): void {
    for (const listener of entry.rootChangeListeners.values()) {
      try {
        listener.onChange(entry.root);
      } catch (error) {
        logger.warn({ error, listenerId: listener.listenerId, root: entry.root }, "Workspace root change listener failed");
      }
    }
  }

  private emitWatchStatus(
    entry: WorkspaceWatchEntry,
    status: WatchStatus,
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
    if (entry.subscribers.size > 0 || entry.rootChangeListeners.size > 0) return;
    this.closeEntryNow(entry);
  }

  private closeEntryNow(entry: WorkspaceWatchEntry): void {
    if (entry.subscribers.size > 0 || entry.rootChangeListeners.size > 0) return;

    if (entry.bridge) {
      entry.bridge.stop();
      entry.bridge = null;
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
