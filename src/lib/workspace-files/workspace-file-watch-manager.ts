import * as fs from "fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
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
  isWslDistroRunning,
  parseWslUncRoot,
  sharedWslInotifyBridgePool,
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

interface WatchEventStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

interface WorkspaceWatchEntry {
  bridge: { stop(): void } | null;
  bridgeActive: boolean;
  closeTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  /**
   * Directories in their own right. A folder with no files in it changes no
   * file path, so without this set an empty one is invisible to the index and
   * its creation would never reach a subscriber.
   */
  directories: Set<string>;
  files: Set<string>;
  lastIndexedAt: number;
  pendingAddedPaths: Set<string>;
  pendingChangedPaths: Set<string>;
  pendingDeletedPaths: Set<string>;
  pendingHasMoreChangedPaths: boolean;
  /** Directories to re-read, mapped to whether the whole subtree is suspect. */
  pendingRescanDirs: Map<string, boolean>;
  pendingTreeChanged: boolean;
  pollTimer: NodeJS.Timeout | null;
  ready: boolean;
  readyPromise: Promise<void>;
  /** A full re-walk was asked for while one was already running or not yet possible. */
  refreshRequested: boolean;
  refreshing: boolean;
  rescanning: boolean;
  root: string;
  rootChangeListeners: Map<string, WorkspaceRootChangeListener>;
  status: WatchStatus;
  subscribers: Map<string, WorkspaceFileSubscriber>;
  symlinks: Set<string>;
  truncated: boolean;
  version: number;
  watchMode: WatchMode;
  watcher: FSWatcher | null;
  watcherReadyPromise: Promise<void>;
  wslRoot: WslUncRoot | null;
}

const CHANGE_DEBOUNCE_MS = 300;
const MAX_CHANGED_PATHS_PER_EVENT = 200;
// Past this many invalidated directories, re-reading each one costs more than
// one walk of the whole tree, so the rescan collapses into a full refresh. The
// same trade-off the event batch makes when it stops tracking individual paths.
const MAX_RESCAN_DIRECTORIES = 64;
// Sweep cadence for poll-mode roots. With a live inotify bridge the sweep is
// only a consistency backstop; without one it is the sole change source and
// must stay near-real-time.
const POLL_SWEEP_FAST_MS = 2_000;
const POLL_SWEEP_SLOW_MS = 60_000;
const POLL_UNUSED_GRACE_MS = 60_000;
const POLL_IDLE_CLOSE_MS = 5 * 60_000;

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
   * Like getIndexedSnapshotForRoot, but for Windows-hosted WSL roots it also creates
   * and bootstraps the index on first use, so repeat requests are served from
   * memory instead of re-walking the share. Watch-capable roots keep the
   * passive behavior: no entry is created on behalf of a plain REST read.
   */
  async ensureSnapshotForRoot(root: string): Promise<WorkspaceFileWalkResult | null> {
    const canonicalRoot = await resolveCanonicalWorkspaceRoot(root);
    const existing = this.entriesByRoot.get(canonicalRoot);
    if (!existing && !isWindowsHostedWslRoot(canonicalRoot)) {
      return this.getIndexedSnapshotForRoot(canonicalRoot);
    }

    const entry = existing ?? this.getOrCreateEntry(canonicalRoot);
    await entry.readyPromise;
    if (entry.status !== "active" || entry.truncated) return null;
    return this.serveSnapshot(entry);
  }

  /** Fire-and-forget index prewarm for a Windows-hosted WSL workspace. */
  warmSessionWorkspace(sessionId: string, agentEnvironment: AgentEnvironment): void {
    void (async () => {
      const root = await this.resolveRootForSession(sessionId, agentEnvironment);
      if (!root || !isWindowsHostedWslRoot(root)) return;
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
    return applyMaxFiles(entry.files, entry.symlinks, entry.directories);
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
      bridgeActive: false,
      closeTimer: null,
      debounceTimer: null,
      directories: new Set(),
      files: new Set(),
      lastIndexedAt: 0,
      pendingAddedPaths: new Set(),
      pendingChangedPaths: new Set(),
      pendingDeletedPaths: new Set(),
      pendingHasMoreChangedPaths: false,
      pendingRescanDirs: new Map(),
      pendingTreeChanged: false,
      pollTimer: null,
      ready: false,
      readyPromise: Promise.resolve(),
      refreshRequested: false,
      refreshing: false,
      rescanning: false,
      root,
      rootChangeListeners: new Map(),
      status: "starting",
      subscribers: new Map(),
      symlinks: new Set(),
      truncated: false,
      version: 0,
      watchMode: wslRoot ? "poll" : "watch",
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
    try {
      const snapshot = await walkWorkspaceFiles(entry.root);
      entry.directories = new Set(snapshot.directories);
      entry.files = new Set(snapshot.files);
      entry.symlinks = new Set(snapshot.symlinks);
      entry.truncated = snapshot.truncated;
      entry.lastIndexedAt = Date.now();
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
      // Still ready: the index is empty and `status` keeps callers off it, but
      // a permanently unready entry would queue invalidations forever and never
      // act on one. Serving falls back to a direct walk in the meantime.
      entry.ready = true;
      entry.status = "fallback";
      logger.warn({ error, root: entry.root }, "Failed to bootstrap workspace file index");
    }

    // The walk observed each directory once, at whatever moment it arrived
    // there. Anything written to a directory it had already passed — a worktree
    // preparation script copying files in, most of all — is only in the
    // invalidations collected meanwhile.
    if (entry.refreshRequested) {
      entry.refreshRequested = false;
      void this.refreshPollIndex(entry);
    }
    void this.runPendingRescans(entry);
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
          isIgnoredWorkspacePath(
            toWorkspaceRelativePath(entry.root, String(filePath)),
            stats,
            { includeHidden: true },
          )
        ),
        persistent: true,
      });

      watcher.on("all", (eventName, filePath, stats?: WatchEventStats) => {
        if (!this.isWatchEventName(eventName)) return;
        if (!this.isWatchEventShape(eventName, stats)) return;
        const relativePath = toWorkspaceRelativePath(entry.root, String(filePath));
        if (!relativePath || isIgnoredWorkspacePath(relativePath, undefined, { includeHidden: true })) return;
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
    // With followSymlinks:false chokidar lstats every entry, so a symlink is
    // neither isFile() nor isDirectory() and arrives as "add" whatever it points
    // at. Admit it here; the rescan stats the target and decides whether it
    // belongs in the index, applying the same rule as the initial walk.
    if (eventName === "add" || eventName === "change") {
      return stats.isFile() || Boolean(stats.isSymbolicLink?.());
    }
    if (eventName === "addDir") return stats.isDirectory();
    return true;
  }

  /**
   * Turn a watch event into an invalidation rather than an index mutation.
   *
   * Trusting the event stream as the index means every event the kernel or the
   * bridge fails to deliver is a file the tree never shows again. Recording
   * which directory to re-read instead makes a lost event cost nothing as long
   * as *some* event for that directory arrives — and the poll sweep is the
   * backstop for when none does.
   */
  private applyWatchEvent(
    entry: WorkspaceWatchEntry,
    eventName: WatchEventName,
    relativePath: string,
  ): void {
    const parentDir = workspaceRelativeDirname(relativePath);
    switch (eventName) {
      case "add":
      case "change":
      case "unlink":
        this.invalidateDirectory(entry, parentDir, false);
        return;
      case "addDir":
      case "unlinkDir":
        // The subtree, not just the entry: a directory that appears is already
        // full by the time a watch reaches it, and one that disappears takes
        // its contents with it. Either way what was held for it is unusable.
        this.invalidateDirectory(entry, relativePath, true);
        this.invalidateDirectory(entry, parentDir, false);
        return;
    }
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
    let rootChangeNotified = false;
    try {
      while (entry.pendingRescanDirs.size > 0) {
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        const targets = Array.from(entry.pendingRescanDirs.entries());
        entry.pendingRescanDirs.clear();

        if (targets.length > MAX_RESCAN_DIRECTORIES) {
          rootChangeNotified = await this.refreshPollIndex(entry) || rootChangeNotified;
          continue;
        }

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
      // file leaves the rescan unchanged. Root listeners still need the raw
      // watch invalidation to refresh Git diff stats.
      if (!rootChangeNotified) this.notifyRootChangeListeners(entry);
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
    const bridge = sharedWslInotifyBridgePool.acquire({
      root: wslRoot,
      excludeRegex: buildInotifyExcludeRegex(wslRoot.posixPath),
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
        if (this.entriesByRoot.get(entry.root) !== entry) return;
        entry.status = "fallback";
        this.setPollCadence(entry, POLL_SWEEP_FAST_MS);
        this.emitWatchStatus(entry, "fallback", "wsl_bridge_unavailable");
        logger.warn({
          root: entry.root,
          distro: wslRoot.distro,
          reason,
        }, "WSL inotify bridge unavailable; falling back to fast polling (install inotify-tools in the distro for real-time sync)");
      },
    });
    entry.bridge = bridge;
  }

  private handleBridgeEvent(entry: WorkspaceWatchEntry, event: BridgeEvent): void {
    const relativePath = normalizeWorkspaceRelativePath(event.relativePath);
    if (!relativePath || isIgnoredWorkspacePath(relativePath, undefined, { includeHidden: true })) return;
    // A moved-in directory carries no per-file events, and a nested one may not
    // even announce itself — applyWatchEvent invalidates the subtree so the
    // rescan reads it rather than trusting what arrived. Events that land
    // before the initial walk finishes are recorded the same way; the walk can
    // only see the tree as it was when it passed each directory, so whatever it
    // raced is exactly what these invalidations recover.
    this.applyWatchEvent(entry, event.eventName, relativePath);
  }

  private async refreshPollIndex(entry: WorkspaceWatchEntry): Promise<boolean> {
    // A sweep already under way started reading the tree before this request
    // existed, so it cannot answer it. Remember the request and re-run once it
    // finishes instead of dropping it — dropping is how a burst of writes ends
    // up permanently missing from the index.
    if (entry.refreshing || !entry.ready) {
      entry.refreshRequested = true;
      return false;
    }
    // Touching \\wsl.localhost boots a stopped distro; after `wsl --shutdown`
    // stay quiet and serve the last snapshot until the distro is back.
    if (
      entry.wslRoot
      && process.platform === "win32"
      && !(await isWslDistroRunning(entry.wslRoot.distro))
    ) {
      return false;
    }
    if (entry.refreshing || !entry.ready) {
      entry.refreshRequested = true;
      return false;
    }
    entry.refreshing = true;
    entry.refreshRequested = false;
    let rootChangeNotified = false;
    try {
      const snapshot = await walkWorkspaceFiles(entry.root);
      if (this.entriesByRoot.get(entry.root) !== entry) return false;
      const previous = entry.files;
      const previousSymlinks = entry.symlinks;
      const previousDirectories = entry.directories;
      const next = new Set(snapshot.files);
      const nextSymlinks = new Set(snapshot.symlinks);
      const nextDirectories = new Set(snapshot.directories);
      entry.directories = nextDirectories;
      entry.files = next;
      entry.symlinks = nextSymlinks;
      entry.truncated = snapshot.truncated;
      entry.lastIndexedAt = Date.now();

      // A folder created or removed with nothing in it moves no file path, so
      // the file diff below cannot see it at all.
      let changed = previousDirectories.size !== nextDirectories.size
        || Array.from(nextDirectories).some((dirPath) => !previousDirectories.has(dirPath));
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
      // Swapping a file for a link to the same path leaves the name set
      // untouched, so only the marker moves. Treat that as a tree change or the
      // badge would stay stale until some unrelated edit forces a reload. It
      // also backfills markers for adds the inotify bridge reported without
      // stat'ing the entry (a 9P stat per event is too expensive there).
      if (!changed) {
        for (const filePath of nextSymlinks) {
          if (previousSymlinks.has(filePath)) continue;
          changed = true;
          break;
        }
      }
      if (!changed) {
        for (const filePath of previousSymlinks) {
          if (nextSymlinks.has(filePath)) continue;
          changed = true;
          break;
        }
      }
      if (changed) {
        entry.pendingTreeChanged = true;
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
          entry.debounceTimer = null;
        }
        this.flushChanges(entry);
        rootChangeNotified = true;
      } else if (!entry.bridgeActive && entry.rootChangeListeners.size > 0) {
        // A filename-only snapshot cannot see edits to an existing file. In
        // bridge fallback mode, periodically invalidate terminal git stats so
        // content-only changes are still observed.
        this.notifyRootChangeListeners(entry);
        rootChangeNotified = true;
      }
    } catch (error) {
      logger.warn({ error, root: entry.root }, "Workspace poll index refresh failed");
    } finally {
      entry.refreshing = false;
      if (entry.refreshRequested && this.entriesByRoot.get(entry.root) === entry) {
        entry.refreshRequested = false;
        void this.refreshPollIndex(entry);
      }
    }
    return rootChangeNotified;
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
