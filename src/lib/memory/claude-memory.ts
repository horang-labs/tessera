import * as fs from "fs/promises";
import * as path from "path";
import * as dbProjects from "@/lib/db/projects";
import * as dbSessions from "@/lib/db/sessions";
import { isAbsoluteFilesystemPath } from "@/lib/filesystem/host-path";
import { resolveClaudeConfigDirForEnvironment } from "@/lib/skill/skill-loader";
import { normalizeCwdForCliEnvironment } from "@/lib/cli/spawn-cli";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import { isClaudeMemoryProvider } from "@/lib/memory/memory-provider";
import type { CliEnvironment } from "@/lib/cli/cli-exec";
import type { SessionRow } from "@/lib/db/sessions";
import {
  MEMORY_INDEX_FILE_NAME,
  type MemoryEntryType,
  type MemoryFileSummary,
  type MemoryGuidelineKind,
  type MemoryGuidelineSummary,
  type MemoryRootKey,
} from "@/types/memory";

export const MAX_MEMORY_FILE_BYTES = 512 * 1024;
const MAX_MEMORY_FILES = 500;
const FRONTMATTER_SCAN_BYTES = 4 * 1024;
const FS_OPERATION_TIMEOUT_MS = 2_000;

const MEMORY_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const MEMORY_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

export class MemoryApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Same rationale as the workspace file route: fs calls can block indefinitely
// on hung network, FUSE, or WSL mounts, so the HTTP response must not wait.
export function withFsDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MemoryApiError(
        "filesystem_timeout",
        "The filesystem did not respond in time",
        504,
      ));
    }, FS_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Claude Code stores per-project data under
 * `<configDir>/projects/<slug>/`, where the slug is the CLI cwd's absolute
 * path with every non-alphanumeric character replaced by `-`
 * (e.g. `/Users/rs/.tessera/x` → `-Users-rs--tessera-x`).
 *
 * The input must be the path the CLI actually runs in. On a WSL-on-Windows
 * bridge the stored workspace path is a Windows path but the CLI's cwd is the
 * WSL-native translation of it — pass the value through
 * `normalizeCwdForCliEnvironment` before slugifying (see resolveSessionMemoryDir).
 */
export function claudeProjectPathSlug(cliCwd: string): string {
  return cliCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function validateMemoryFileName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.includes("\0") || !MEMORY_FILE_NAME_PATTERN.test(name)) {
    throw new MemoryApiError(
      "invalid_memory_file_name",
      "Memory file name must be a plain .md file name",
      400,
    );
  }
  return name;
}

export interface MemoryDirContext {
  memoryDir: string;
  /** Which workspace path produced the slug the directory was resolved from. */
  workspaceRoot: string;
  root: MemoryRootKey;
  exists: boolean;
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await withFsDeadline(fs.stat(dirPath));
    return stat.isDirectory();
  } catch (error) {
    if (error instanceof MemoryApiError) throw error;
    return false;
  }
}

export function parseMemoryRootKey(value: unknown): MemoryRootKey | null {
  return value === "workDir" || value === "project" ? value : null;
}

/**
 * Load a session and enforce the provider gate. Only Claude Code sessions have
 * a `~/.claude/projects/<slug>/memory` folder or read `~/.claude/CLAUDE.md`,
 * so Codex/opencode sessions are rejected even if the API is called directly.
 * Returns null when the session is unknown (callers map that to 404/422).
 */
export function getClaudeMemorySession(sessionId: string): SessionRow | null {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;
  if (!isClaudeMemoryProvider(session.provider)) {
    throw new MemoryApiError(
      "unsupported_provider",
      "Project memory is only available for Claude Code sessions",
      400,
    );
  }
  return session;
}

export async function statFileSafe(absolutePath: string): Promise<{
  exists: boolean;
  size: number;
  mtimeMs: number;
}> {
  try {
    const stat = await withFsDeadline(fs.stat(absolutePath));
    return { exists: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error instanceof MemoryApiError) throw error; // filesystem timeout
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

/**
 * Resolve the Claude memory directory for a session. Worktree sessions get
 * a slug derived from their work_dir (that is what the CLI spawned there
 * actually reads); when that directory has no memory folder yet, fall back
 * to the source project path so users still see the project's memories.
 *
 * `pinnedRoot` fixes the candidate choice to what a previous read resolved,
 * so a write cannot silently land in a different directory when the CLI
 * creates the work_dir memory folder mid-edit. Only the key travels over the
 * wire — the path itself is always derived server-side.
 *
 * The slug is computed from the path the CLI actually runs in, not the raw
 * stored workspace path: on a WSL-on-Windows bridge the stored path is a
 * Windows path (e.g. `\\wsl.localhost\Ubuntu\home\u\p`) while the CLI's cwd
 * is its WSL-native form (`/home/u/p`), and only the latter matches the
 * directory the CLI created. `normalizeCwdForCliEnvironment` performs that
 * translation and is a no-op for plain native environments.
 */
export async function resolveSessionMemoryDir(
  sessionId: string,
  environment: CliEnvironment,
  pinnedRoot?: MemoryRootKey | null,
): Promise<MemoryDirContext | null> {
  const session = getClaudeMemorySession(sessionId);
  if (!session) return null;

  const candidates: Array<{ root: MemoryRootKey; workspaceRoot: string }> = [];
  const workDir = session.work_dir?.trim();
  if (workDir) candidates.push({ root: "workDir", workspaceRoot: workDir });
  const projectPath = dbProjects.getProject(session.project_id)?.decoded_path?.trim();
  const projectId = session.project_id?.trim();
  const projectRoot = projectPath
    || (projectId && isAbsoluteFilesystemPath(projectId) ? projectId : null);
  if (projectRoot && projectRoot !== workDir) {
    candidates.push({ root: "project", workspaceRoot: projectRoot });
  }
  if (candidates.length === 0) return null;

  const configDir = await resolveClaudeConfigDirForEnvironment(environment);
  const contextFor = async (
    candidate: { root: MemoryRootKey; workspaceRoot: string },
  ): Promise<MemoryDirContext> => {
    const cliCwd = normalizeCwdForCliEnvironment(candidate.workspaceRoot, environment);
    const memoryDir = path.join(
      configDir,
      "projects",
      claudeProjectPathSlug(cliCwd),
      "memory",
    );
    return {
      memoryDir,
      workspaceRoot: candidate.workspaceRoot,
      root: candidate.root,
      exists: await directoryExists(memoryDir),
    };
  };

  if (pinnedRoot) {
    const pinned = candidates.find((candidate) => candidate.root === pinnedRoot);
    if (pinned) return contextFor(pinned);
  }

  let first: MemoryDirContext | null = null;
  for (const candidate of candidates) {
    const context = await contextFor(candidate);
    if (context.exists) return context;
    first ??= context;
  }
  return first;
}

export interface GuidelineTarget {
  kind: MemoryGuidelineKind;
  label: string;
  /** Folder the CLAUDE.md lives in. */
  dir: string;
  absolutePath: string;
}

/**
 * The CLAUDE.md files Claude reads for this session, as plain file targets:
 * the global `~/.claude/CLAUDE.md` (every project) and the project's own
 * `<workspace>/CLAUDE.md`. Paths are fixed (no client-supplied name), so
 * there is no path-traversal surface.
 */
export async function resolveGuidelineTargets(
  sessionId: string,
  environment: CliEnvironment,
): Promise<GuidelineTarget[]> {
  const session = getClaudeMemorySession(sessionId);
  if (!session) return [];

  const targets: GuidelineTarget[] = [];
  const configDir = await resolveClaudeConfigDirForEnvironment(environment);
  targets.push({
    kind: "global-guideline",
    label: "Global CLAUDE.md",
    dir: configDir,
    absolutePath: path.join(configDir, "CLAUDE.md"),
  });

  const workspaceRoot = await resolveSessionWorkspaceFilesystemRoot(sessionId);
  if (workspaceRoot) {
    targets.push({
      kind: "project-guideline",
      label: "Project CLAUDE.md",
      dir: workspaceRoot,
      absolutePath: path.join(workspaceRoot, "CLAUDE.md"),
    });
  }
  return targets;
}

export async function resolveGuidelineTarget(
  sessionId: string,
  environment: CliEnvironment,
  kind: MemoryGuidelineKind,
): Promise<GuidelineTarget> {
  const target = (await resolveGuidelineTargets(sessionId, environment))
    .find((candidate) => candidate.kind === kind);
  if (!target) {
    throw new MemoryApiError("guideline_unavailable", "CLAUDE.md target is unavailable", 404);
  }
  return target;
}

export async function listGuidelines(
  sessionId: string,
  environment: CliEnvironment,
): Promise<MemoryGuidelineSummary[]> {
  const targets = await resolveGuidelineTargets(sessionId, environment);
  const summaries = await Promise.all(targets.map(async (target): Promise<MemoryGuidelineSummary> => ({
    kind: target.kind,
    label: target.label,
    fileName: "CLAUDE.md",
    path: target.absolutePath,
    status: "active",
    statusLabel: "Active",
    statusReason: "active",
    ...(await statFileSafe(target.absolutePath)),
  })));
  return summaries.filter((summary) => summary.exists);
}

/** Resolve a validated file name inside the memory directory. */
export function resolveMemoryFilePath(memoryDir: string, rawName: string): {
  fileName: string;
  absolutePath: string;
} {
  const fileName = validateMemoryFileName(rawName);
  const absolutePath = path.join(memoryDir, fileName);
  // The name pattern already forbids path separators; keep a structural
  // containment check as a second layer, mirroring the workspace file route.
  if (path.dirname(absolutePath) !== path.normalize(memoryDir)) {
    throw new MemoryApiError(
      "invalid_memory_file_name",
      "Memory file name escapes the memory directory",
      400,
    );
  }
  return { fileName, absolutePath };
}

interface ParsedMemoryFrontmatter {
  name?: string;
  description?: string;
  type?: MemoryEntryType;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

export function parseMemoryFrontmatter(raw: string): ParsedMemoryFrontmatter {
  if (!raw.startsWith("---")) return {};
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return {};

  const parsed: ParsedMemoryFrontmatter = {};
  for (const line of raw.slice(3, endIdx).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:") && parsed.name === undefined) {
      parsed.name = stripQuotes(trimmed.slice(5).trim());
    } else if (trimmed.startsWith("description:") && parsed.description === undefined) {
      parsed.description = stripQuotes(trimmed.slice(12).trim());
    } else if (trimmed.startsWith("type:") && parsed.type === undefined) {
      const value = stripQuotes(trimmed.slice(5).trim());
      if (MEMORY_ENTRY_TYPES.has(value)) parsed.type = value as MemoryEntryType;
    }
  }
  return parsed;
}

export async function readFileHead(absolutePath: string, bytes: number): Promise<string> {
  const handle = await withFsDeadline(fs.open(absolutePath, "r"));
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await withFsDeadline(handle.read(buffer, 0, bytes, 0));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    // Do not tie the response to close(): it can hang on stalled mounts.
    void handle.close().catch(() => {});
  }
}

export async function listMemoryFiles(memoryDir: string): Promise<MemoryFileSummary[]> {
  const entries = await withFsDeadline(fs.readdir(memoryDir, { withFileTypes: true }));
  const fileNames = entries
    .filter((entry) => entry.isFile() && MEMORY_FILE_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .slice(0, MAX_MEMORY_FILES);

  const summaries = await Promise.all(fileNames.map(async (fileName): Promise<MemoryFileSummary | null> => {
    const absolutePath = path.join(memoryDir, fileName);
    try {
      const stat = await withFsDeadline(fs.stat(absolutePath));
      const isIndex = fileName === MEMORY_INDEX_FILE_NAME;
      const frontmatter = isIndex
        ? {}
        : parseMemoryFrontmatter(await readFileHead(absolutePath, FRONTMATTER_SCAN_BYTES));
      return {
        fileName,
        relativePath: fileName,
        name: frontmatter.name || fileName.replace(/\.md$/, ""),
        description: frontmatter.description ?? "",
        type: frontmatter.type ?? null,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isIndex,
        section: "project-memory",
        readOnly: false,
      };
    } catch (error) {
      if (error instanceof MemoryApiError) throw error;
      // Skip entries that vanished between readdir and stat.
      return null;
    }
  }));

  return summaries
    .filter((summary): summary is MemoryFileSummary => summary !== null)
    .sort((a, b) => {
      if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
}
