import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";
import * as dbSessions from "@/lib/db/sessions";
import { execCli, isRunningInWsl, type CliEnvironment } from "@/lib/cli/cli-exec";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import { getMemoryProviderKind } from "@/lib/memory/memory-provider";
import {
  directoryExists,
  MemoryApiError,
  statFileSafe,
  withFsDeadline,
} from "@/lib/memory/claude-memory";
import type {
  MemoryFileSummary,
  MemoryGuidelineKind,
  MemoryGuidelineSummary,
} from "@/types/memory";

const CODEX_AGENTS_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md"]);
const MAX_CODEX_MEMORY_FILES = 500;

export interface CodexMemoryContext {
  codexHome: string;
  projectRoot: string | null;
  memoryDir: string;
  exists: boolean;
}

export interface CodexGuidelineTarget {
  kind: MemoryGuidelineKind;
  label: string;
  fileName: string;
  dir: string;
  absolutePath: string;
  status: "active" | "shadowed";
  statusLabel: string;
  statusReason: "active" | "shadowed-by-override";
}

function lastNonEmptyLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function windowsPathToWslPath(value: string): string | null {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!driveMatch) return null;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/[\\/]+/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export async function resolveCodexHomeForEnvironment(
  environment: CliEnvironment,
): Promise<string> {
  const configuredDir = process.env.CODEX_HOME?.trim();
  if (configuredDir) return path.resolve(configuredDir);

  if (environment === "wsl" && process.platform === "win32") {
    const result = await execCli(
      "sh",
      ["-lc", 'printf "%s" "${CODEX_HOME:-$HOME/.codex}"'],
      "wsl",
      5000,
    );
    const resolvedDir = lastNonEmptyLine(result.stdout);
    if (result.ok && resolvedDir) return resolvedDir;
  }

  if (environment === "native" && isRunningInWsl()) {
    const result = await execCli(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$home = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }; Write-Output $home",
      ],
      "native",
      5000,
    );
    const windowsCodexHome = lastNonEmptyLine(result.stdout);
    const wslCodexHome = windowsCodexHome ? windowsPathToWslPath(windowsCodexHome) : null;
    if (result.ok && wslCodexHome) return wslCodexHome;
  }

  return path.join(homedir(), ".codex");
}

export function getCodexMemorySession(sessionId: string): dbSessions.SessionRow | null {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;
  if (getMemoryProviderKind(session.provider) !== "codex") {
    throw new MemoryApiError(
      "unsupported_provider",
      "Codex memory is only available for Codex sessions",
      400,
    );
  }
  return session;
}

export async function resolveCodexMemoryContext(
  sessionId: string,
  environment: CliEnvironment,
): Promise<CodexMemoryContext | null> {
  const session = getCodexMemorySession(sessionId);
  if (!session) return null;

  const codexHome = await resolveCodexHomeForEnvironment(environment);
  const projectRoot = await resolveCodexProjectRoot(sessionId);
  const memoryDir = path.join(codexHome, "memories");
  return {
    codexHome,
    projectRoot,
    memoryDir,
    exists: await directoryExists(memoryDir),
  };
}

async function resolveCodexProjectRoot(sessionId: string): Promise<string | null> {
  return resolveSessionWorkspaceFilesystemRoot(sessionId);
}

async function buildInstructionRows(
  kind: MemoryGuidelineKind,
  dir: string,
): Promise<CodexGuidelineTarget[]> {
  const overridePath = path.join(dir, "AGENTS.override.md");
  const agentsPath = path.join(dir, "AGENTS.md");
  const [overrideStat, agentsStat] = await Promise.all([
    statFileSafe(overridePath),
    statFileSafe(agentsPath),
  ]);
  const hasOverride = overrideStat.exists;
  const rows: CodexGuidelineTarget[] = [];

  if (hasOverride) {
    rows.push({
      kind,
      label: kind === "global-guideline" ? "Global AGENTS.override.md" : "Project AGENTS.override.md",
      fileName: "AGENTS.override.md",
      dir,
      absolutePath: overridePath,
    status: "active",
    statusLabel: "Active",
    statusReason: "active",
  });
  }

  if (agentsStat.exists) {
    rows.push({
      kind,
      label: kind === "global-guideline" ? "Global AGENTS.md" : "Project AGENTS.md",
      fileName: "AGENTS.md",
      dir,
      absolutePath: agentsPath,
    status: hasOverride ? "shadowed" : "active",
    statusLabel: hasOverride ? "Shadowed by override" : "Active",
    statusReason: hasOverride ? "shadowed-by-override" : "active",
  });
  }

  return rows;
}

export async function resolveCodexGuidelineTargets(
  sessionId: string,
  environment: CliEnvironment,
): Promise<CodexGuidelineTarget[]> {
  const session = getCodexMemorySession(sessionId);
  if (!session) return [];

  const codexHome = await resolveCodexHomeForEnvironment(environment);
  const targets = await buildInstructionRows("global-guideline", codexHome);
  const projectRoot = await resolveCodexProjectRoot(sessionId);
  if (projectRoot) {
    targets.push(...await buildInstructionRows("project-guideline", projectRoot));
  }
  return targets;
}

export async function listCodexGuidelines(
  sessionId: string,
  environment: CliEnvironment,
): Promise<MemoryGuidelineSummary[]> {
  const targets = await resolveCodexGuidelineTargets(sessionId, environment);
  return Promise.all(targets.map(async (target): Promise<MemoryGuidelineSummary> => ({
    kind: target.kind,
    label: target.label,
    fileName: target.fileName,
    path: target.absolutePath,
    status: target.status,
    statusLabel: target.statusLabel,
    ...(await statFileSafe(target.absolutePath)),
  })));
}

export async function resolveCodexGuidelineTarget(
  sessionId: string,
  environment: CliEnvironment,
  kind: MemoryGuidelineKind,
  rawName: string,
): Promise<CodexGuidelineTarget> {
  const name = rawName.trim();
  if (!CODEX_AGENTS_FILE_NAMES.has(name)) {
    throw new MemoryApiError("invalid_guideline_file", "Invalid Codex instruction file", 400);
  }

  const targets = await resolveCodexGuidelineTargets(sessionId, environment);
  const target = targets.find((candidate) => candidate.kind === kind && candidate.fileName === name);
  if (!target) {
    throw new MemoryApiError("guideline_unavailable", "Codex instruction file is unavailable", 404);
  }
  return target;
}

function toDisplayName(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) ?? relativePath;
}

function isPlainMarkdownFileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value);
}

function isSafeSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function validateCodexMemoryRelativePath(rawPath: string): string {
  const relativePath = rawPath.trim().replace(/\\/g, "/");
  if (!relativePath || relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new MemoryApiError("invalid_memory_path", "Invalid Codex memory path", 400);
  }

  if (relativePath === "memory_summary.md" || relativePath === "MEMORY.md") return relativePath;

  const rolloutMatch = relativePath.match(/^rollout_summaries\/([^/]+\.md)$/);
  if (rolloutMatch && isPlainMarkdownFileName(rolloutMatch[1])) return relativePath;

  const adHocMatch = relativePath.match(/^extensions\/ad_hoc\/notes\/([^/]+\.md)$/);
  if (adHocMatch && isPlainMarkdownFileName(adHocMatch[1])) return relativePath;

  const skillMatch = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch && isSafeSkillName(skillMatch[1])) return relativePath;

  throw new MemoryApiError("invalid_memory_path", "Unsupported Codex memory path", 400);
}

export function resolveCodexMemoryFilePath(memoryDir: string, rawPath: string): {
  relativePath: string;
  fileName: string;
  absolutePath: string;
} {
  const relativePath = validateCodexMemoryRelativePath(rawPath);
  const absolutePath = path.resolve(memoryDir, relativePath);
  const normalizedRoot = path.resolve(memoryDir);
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new MemoryApiError("invalid_memory_path", "Codex memory path escapes the memory directory", 400);
  }
  return { relativePath, fileName: toDisplayName(relativePath), absolutePath };
}

async function fileSummary(
  memoryDir: string,
  relativePath: string,
  section: MemoryFileSummary["section"],
  description: string,
): Promise<MemoryFileSummary | null> {
  const { fileName, absolutePath } = resolveCodexMemoryFilePath(memoryDir, relativePath);
  try {
    const stat = await withFsDeadline(fs.stat(absolutePath));
    if (!stat.isFile()) return null;
    return {
      fileName,
      relativePath,
      name: fileName.replace(/\.md$/, ""),
      description,
      type: null,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isIndex: relativePath === "MEMORY.md",
      section,
      readOnly: true,
    };
  } catch (error) {
    if (error instanceof MemoryApiError) throw error;
    return null;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await withFsDeadline(fs.readdir(dir, { withFileTypes: true }));
    return entries
      .filter((entry) => entry.isFile() && isPlainMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  } catch (error) {
    if (error instanceof MemoryApiError) throw error;
    return [];
  }
}

export async function listCodexMemoryFiles(memoryDir: string): Promise<MemoryFileSummary[]> {
  const files: MemoryFileSummary[] = [];

  for (const summary of await Promise.all([
    fileSummary(
      memoryDir,
      "memory_summary.md",
      "global-memory",
      "Global memory summary injected at session start.",
    ),
    fileSummary(
      memoryDir,
      "MEMORY.md",
      "global-memory",
      "Global memory registry used for search and indexing.",
    ),
  ])) {
    if (summary) files.push(summary);
  }

  for (const fileName of await listMarkdownFiles(path.join(memoryDir, "rollout_summaries"))) {
    if (files.length >= MAX_CODEX_MEMORY_FILES) break;
    const summary = await fileSummary(
      memoryDir,
      `rollout_summaries/${fileName}`,
      "rollout-summaries",
      "Past work summary.",
    );
    if (summary) files.push(summary);
  }

  for (const fileName of await listMarkdownFiles(path.join(memoryDir, "extensions", "ad_hoc", "notes"))) {
    if (files.length >= MAX_CODEX_MEMORY_FILES) break;
    const summary = await fileSummary(
      memoryDir,
      `extensions/ad_hoc/notes/${fileName}`,
      "ad-hoc-notes",
      "User-authored memory note.",
    );
    if (summary) files.push(summary);
  }

  try {
    const skillEntries = await withFsDeadline(fs.readdir(path.join(memoryDir, "skills"), { withFileTypes: true }));
    for (const entry of skillEntries) {
      if (files.length >= MAX_CODEX_MEMORY_FILES) break;
      if (!entry.isDirectory() || !isSafeSkillName(entry.name)) continue;
      const summary = await fileSummary(
        memoryDir,
        `skills/${entry.name}/SKILL.md`,
        "memory-skills",
        "Memory-backed reusable workflow.",
      );
      if (summary) files.push(summary);
    }
  } catch (error) {
    if (error instanceof MemoryApiError) throw error;
  }

  return files;
}
