import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import logger from "@/lib/logger";
import { IGNORED_WORKSPACE_DIR_NAMES } from "./workspace-file-scan";

const execFileAsync = promisify(execFile);

/**
 * Real-time file events for \\wsl.localhost\ workspace roots.
 *
 * The 9P redirector that backs \\wsl.localhost cannot deliver filesystem
 * notifications to Windows (watchers stall or error), so this bridge runs
 * `inotifywait` inside the distro — where inotify is native and instant — and
 * streams its events back over stdout. If inotifywait is unavailable in the
 * distro the bridge reports down and callers fall back to polling.
 */

export interface WslUncRoot {
  distro: string;
  posixPath: string;
}

export type BridgeEventName = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export interface BridgeEvent {
  eventName: BridgeEventName;
  relativePath: string;
}

const WSL_UNC_HOSTS = new Set(["wsl.localhost", "wsl$"]);
const RESTART_DELAY_MS = 3_000;
const MAX_RESTARTS = 2;
const DISTRO_STATE_TTL_MS = 5_000;
const DISTRO_WAIT_POLL_MS = 15_000;

const distroStateCache = new Map<string, { at: number; running: boolean }>();

export function parseWslRunningDistros(stdout: string): string[] {
  return Array.from(new Set(
    stdout
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ));
}

/**
 * True when the distro is currently running. `wsl.exe --list --running` only
 * queries the WSL service — unlike touching \\wsl.localhost or spawning
 * `wsl.exe -d`, it never boots a stopped distro. After `wsl --shutdown` the
 * watcher must go quiet instead of waking the distro right back up.
 */
export async function isWslDistroRunning(distro: string): Promise<boolean> {
  const cached = distroStateCache.get(distro);
  if (cached && Date.now() - cached.at < DISTRO_STATE_TTL_MS) return cached.running;

  let running = true;
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["--list", "--running", "--quiet"], {
      encoding: "utf16le",
      timeout: 5_000,
      windowsHide: true,
    });
    running = parseWslRunningDistros(stdout)
      .some((name) => name.toLowerCase() === distro.toLowerCase());
  } catch (error) {
    // Exits non-zero when nothing is running; stdout still tells the truth.
    const stdout = (error as { stdout?: unknown })?.stdout;
    if (typeof stdout === "string") {
      running = parseWslRunningDistros(stdout)
        .some((name) => name.toLowerCase() === distro.toLowerCase());
    }
  }
  distroStateCache.set(distro, { at: Date.now(), running });
  return running;
}

export function parseWslUncRoot(root: string): WslUncRoot | null {
  if (!root.startsWith("\\\\") && !root.startsWith("//")) return null;
  const parts = root.replace(/\//g, "\\").split("\\").filter(Boolean);
  const [host, distro, ...rest] = parts;
  if (!host || !WSL_UNC_HOSTS.has(host.toLowerCase())) return null;
  if (!distro || rest.length === 0) return null;
  return { distro, posixPath: `/${rest.join("/")}` };
}

export function parseInotifyLine(line: string, posixRoot: string): BridgeEvent | null {
  const separator = line.indexOf("|");
  if (separator <= 0) return null;
  const events = line.slice(0, separator).split(",");
  const absolutePath = line.slice(separator + 1).replace(/\r$/, "");

  const prefix = posixRoot.endsWith("/") ? posixRoot : `${posixRoot}/`;
  if (!absolutePath.startsWith(prefix)) return null;
  const relativePath = absolutePath.slice(prefix.length);
  if (!relativePath) return null;

  const isDirectory = events.includes("ISDIR");
  if (events.includes("CREATE") || events.includes("MOVED_TO")) {
    return { eventName: isDirectory ? "addDir" : "add", relativePath };
  }
  if (events.includes("DELETE") || events.includes("MOVED_FROM")) {
    return { eventName: isDirectory ? "unlinkDir" : "unlink", relativePath };
  }
  if (!isDirectory && (events.includes("CLOSE_WRITE") || events.includes("MODIFY"))) {
    return { eventName: "change", relativePath };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** POSIX ERE handed to inotifywait so ignored trees are never watched. */
export function buildInotifyExcludeRegex(): string {
  const names = Array.from(IGNORED_WORKSPACE_DIR_NAMES, escapeRegExp).join("|");
  return `/(\\.[^/]+|${names})(/|$)`;
}

export class WslInotifyBridge {
  private child: ChildProcess | null = null;
  private distroWaitTimer: NodeJS.Timeout | null = null;
  private established = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private stopped = false;

  constructor(private readonly options: {
    root: WslUncRoot;
    onEvent(event: BridgeEvent): void;
    onEstablished(): void;
    onDown(reason: string): void;
  }) {}

  start(): void {
    if (this.stopped || this.child) return;
    this.established = false;
    this.stdoutBuffer = "";
    this.stderrTail = "";

    let child: ChildProcess;
    try {
      child = spawn("wsl.exe", [
        "-d", this.options.root.distro,
        // No -q: it would also suppress the "Watches established." stderr line
        // this bridge relies on to detect readiness.
        "--exec", "stdbuf", "-oL",
        "inotifywait", "-m", "-r",
        "-e", "create,delete,move,modify,close_write",
        "--exclude", buildInotifyExcludeRegex(),
        "--format", "%e|%w%f",
        "--", this.options.root.posixPath,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.reportDown(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-500);
      if (!this.established && text.includes("Watches established")) {
        this.established = true;
        this.restartCount = 0;
        this.options.onEstablished();
      }
    });
    child.on("error", (error) => {
      this.child = null;
      this.reportDown(`unable to launch wsl.exe: ${error.message}`);
    });
    child.on("close", (code) => {
      this.child = null;
      if (this.stopped) return;
      if (!this.established) {
        this.reportDown(`inotifywait unavailable in distro (exit ${code}): ${this.stderrTail.trim()}`);
        return;
      }
      void this.recoverAfterExit(code);
    });
  }

  private async recoverAfterExit(code: number | null): Promise<void> {
    const running = await isWslDistroRunning(this.options.root.distro);
    if (this.stopped) return;

    if (!running) {
      // wsl --shutdown killed the watcher. Restarting `wsl.exe -d` would boot
      // the distro right back up, so wait quietly until it returns on its own.
      logger.info({
        distro: this.options.root.distro,
        posixPath: this.options.root.posixPath,
      }, "WSL distro stopped; inotify bridge waiting for it to return");
      this.distroWaitTimer = setInterval(() => {
        void (async () => {
          if (this.stopped || this.child) return;
          if (!(await isWslDistroRunning(this.options.root.distro))) return;
          if (this.distroWaitTimer) {
            clearInterval(this.distroWaitTimer);
            this.distroWaitTimer = null;
          }
          this.restartCount = 0;
          this.start();
        })();
      }, DISTRO_WAIT_POLL_MS);
      this.distroWaitTimer.unref?.();
      return;
    }

    if (this.restartCount >= MAX_RESTARTS) {
      this.reportDown(`inotifywait exited repeatedly (exit ${code})`);
      return;
    }
    this.restartCount += 1;
    logger.warn({
      distro: this.options.root.distro,
      posixPath: this.options.root.posixPath,
      code,
      attempt: this.restartCount,
    }, "WSL inotify bridge exited; restarting");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.distroWaitTimer) {
      clearInterval(this.distroWaitTimer);
      this.distroWaitTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) child.kill();
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const event = parseInotifyLine(line, this.options.root.posixPath);
      if (event) this.options.onEvent(event);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private reportDown(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.onDown(reason);
  }
}
