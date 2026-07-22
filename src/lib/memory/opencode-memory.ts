import * as fs from "fs/promises";
import * as path from "path";
import { homedir } from "os";
import * as dbSessions from "@/lib/db/sessions";
import { execCli, isRunningInWsl, type CliEnvironment } from "@/lib/cli/cli-exec";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import { resolveClaudeConfigDirForEnvironment } from "@/lib/skill/skill-loader";
import { getMemoryProviderKind } from "@/lib/memory/memory-provider";
import { toMemoryDisplayPath } from "@/lib/memory/memory-display-path";
import {
  directoryExists,
  MemoryApiError,
  statFileSafe,
  withFsDeadline,
} from "@/lib/memory/claude-memory";
import type {
  MemoryGuidelineKind,
  MemoryGuidelineStatus,
  MemoryGuidelineStatusReason,
  MemoryGuidelineSummary,
} from "@/types/memory";

const RESERVED_OPENCODE_RULE_FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "opencode.json"]);
const GLOB_PATTERN_CHARS = /[*?[\]{}]/;

export interface OpenCodeRulesContext {
  opencodeConfigDir: string;
  projectRoot: string | null;
  exists: boolean;
}

export interface OpenCodeGuidelineTarget {
  kind: MemoryGuidelineKind;
  label: string;
  fileName: string;
  dir: string;
  absolutePath: string;
  status: MemoryGuidelineStatus;
  statusLabel: string;
  statusReason: MemoryGuidelineStatusReason;
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

export async function resolveOpenCodeConfigDirForEnvironment(
  environment: CliEnvironment,
): Promise<string> {
  if (environment === "wsl" && process.platform === "win32") {
    const result = await execCli(
      "sh",
      ["-lc", 'printf "%s" "$HOME/.config/opencode"'],
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
        "$dir = Join-Path $env:USERPROFILE '.config\\opencode'; Write-Output $dir",
      ],
      "native",
      5000,
    );
    const windowsConfigDir = lastNonEmptyLine(result.stdout);
    const wslConfigDir = windowsConfigDir ? windowsPathToWslPath(windowsConfigDir) : null;
    if (result.ok && wslConfigDir) return wslConfigDir;
  }

  return path.join(homedir(), ".config", "opencode");
}

export function getOpenCodeRulesSession(sessionId: string): dbSessions.SessionRow | null {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;
  if (getMemoryProviderKind(session.provider) !== "opencode") {
    throw new MemoryApiError(
      "unsupported_provider",
      "OpenCode rules are only available for OpenCode sessions",
      400,
    );
  }
  return session;
}

export async function resolveOpenCodeRulesContext(
  sessionId: string,
  environment: CliEnvironment,
): Promise<OpenCodeRulesContext | null> {
  const session = getOpenCodeRulesSession(sessionId);
  if (!session) return null;

  const opencodeConfigDir = await resolveOpenCodeConfigDirForEnvironment(environment);
  return {
    opencodeConfigDir,
    projectRoot: await resolveSessionWorkspaceFilesystemRoot(sessionId),
    exists: await directoryExists(opencodeConfigDir),
  };
}

function makeTarget({
  kind,
  label,
  fileName,
  dir,
  status,
  statusLabel,
  statusReason,
}: {
  kind: MemoryGuidelineKind;
  label: string;
  fileName: string;
  dir: string;
  status: MemoryGuidelineStatus;
  statusLabel: string;
  statusReason: MemoryGuidelineStatusReason;
}): OpenCodeGuidelineTarget {
  return {
    kind,
    label,
    fileName,
    dir,
    absolutePath: path.join(dir, fileName),
    status,
    statusLabel,
    statusReason,
  };
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeLocalInstructionPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  if (GLOB_PATTERN_CHARS.test(trimmed)) return null;
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;

  const normalized = path.normalize(trimmed).replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (normalized.includes(":")) return null;
  if (RESERVED_OPENCODE_RULE_FILE_NAMES.has(normalized)) return null;
  return normalized;
}

async function readConfiguredInstructionPaths(configPath: string): Promise<string[]> {
  try {
    const raw = await withFsDeadline(fs.readFile(configPath, "utf8"));
    const parsed = JSON.parse(raw) as { instructions?: unknown };
    if (!Array.isArray(parsed.instructions)) return [];
    return parsed.instructions
      .filter((item): item is string => typeof item === "string")
      .map(normalizeLocalInstructionPath)
      .filter((item): item is string => item !== null);
  } catch {
    return [];
  }
}

async function configuredInstructionTargets({
  kind,
  opencodeDir,
  configPath,
  seenAbsolutePaths,
}: {
  kind: MemoryGuidelineKind;
  opencodeDir: string;
  configPath: string;
  seenAbsolutePaths: Set<string>;
}): Promise<OpenCodeGuidelineTarget[]> {
  const relativePaths = await readConfiguredInstructionPaths(configPath);
  const targets: OpenCodeGuidelineTarget[] = [];

  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(opencodeDir, relativePath);
    if (!isWithinDirectory(opencodeDir, absolutePath)) continue;
    if (seenAbsolutePaths.has(absolutePath)) continue;

    const stat = await statFileSafe(absolutePath);
    if (!stat.exists) continue;
    seenAbsolutePaths.add(absolutePath);

    targets.push({
      kind,
      label: kind === "global-guideline"
        ? `Global instruction ${relativePath}`
        : `Project instruction ${relativePath}`,
      fileName: relativePath,
      dir: path.dirname(absolutePath),
      absolutePath,
      status: "active",
      statusLabel: "Configured",
      statusReason: "custom-instructions",
    });
  }

  return targets;
}

function isClaudeProjectFallbackDisabled(): boolean {
  return process.env.OPENCODE_DISABLE_CLAUDE_CODE?.trim() === "1";
}

function isClaudeGlobalFallbackDisabled(): boolean {
  return process.env.OPENCODE_DISABLE_CLAUDE_CODE?.trim() === "1"
    || process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT?.trim() === "1";
}

async function buildOpenCodeScopeRows({
  kind,
  opencodeDir,
  claudeFallbackDir,
  disableClaudeFallback,
}: {
  kind: MemoryGuidelineKind;
  opencodeDir: string;
  claudeFallbackDir: string;
  disableClaudeFallback: boolean;
}): Promise<OpenCodeGuidelineTarget[]> {
  const agentsTarget = makeTarget({
    kind,
    label: kind === "global-guideline" ? "Global AGENTS.md" : "Project AGENTS.md",
    fileName: "AGENTS.md",
    dir: opencodeDir,
    status: "active",
    statusLabel: "Active",
    statusReason: "active",
  });
  const configTarget = makeTarget({
    kind,
    label: kind === "global-guideline" ? "Global opencode.json" : "Project opencode.json",
    fileName: "opencode.json",
    dir: opencodeDir,
    status: "active",
    statusLabel: "Configured",
    statusReason: "custom-instructions",
  });

  const [agentsStat, configStat, claudeStat] = await Promise.all([
    statFileSafe(agentsTarget.absolutePath),
    statFileSafe(configTarget.absolutePath),
    statFileSafe(path.join(claudeFallbackDir, "CLAUDE.md")),
  ]);
  const hasAgents = agentsStat.exists;
  const rows: OpenCodeGuidelineTarget[] = [];
  const seenAbsolutePaths = new Set<string>();

  if (hasAgents) {
    rows.push(agentsTarget);
    seenAbsolutePaths.add(agentsTarget.absolutePath);
  }
  if (configStat.exists) {
    rows.push(configTarget);
    seenAbsolutePaths.add(configTarget.absolutePath);
    rows.push(...await configuredInstructionTargets({
      kind,
      opencodeDir,
      configPath: configTarget.absolutePath,
      seenAbsolutePaths,
    }));
  }

  if (claudeStat.exists) {
    rows.push(makeTarget({
      kind,
      label: kind === "global-guideline" ? "Global CLAUDE.md" : "Project CLAUDE.md",
      fileName: "CLAUDE.md",
      dir: claudeFallbackDir,
      status: disableClaudeFallback || hasAgents ? "shadowed" : "active",
      statusLabel: disableClaudeFallback
        ? "Disabled by environment"
        : hasAgents
          ? "Shadowed by AGENTS.md"
          : "Fallback active",
      statusReason: disableClaudeFallback
        ? "disabled-by-env"
        : hasAgents
          ? "shadowed-by-agents"
          : "fallback-active",
    }));
  }

  return rows;
}

export async function resolveOpenCodeGuidelineTargets(
  sessionId: string,
  environment: CliEnvironment,
): Promise<OpenCodeGuidelineTarget[]> {
  const session = getOpenCodeRulesSession(sessionId);
  if (!session) return [];

  const context = await resolveOpenCodeRulesContext(sessionId, environment);
  if (!context) return [];

  const claudeConfigDir = await resolveClaudeConfigDirForEnvironment(environment);
  const targets = await buildOpenCodeScopeRows({
    kind: "global-guideline",
    opencodeDir: context.opencodeConfigDir,
    claudeFallbackDir: claudeConfigDir,
    disableClaudeFallback: isClaudeGlobalFallbackDisabled(),
  });

  if (context.projectRoot) {
    targets.push(...await buildOpenCodeScopeRows({
      kind: "project-guideline",
      opencodeDir: context.projectRoot,
      claudeFallbackDir: context.projectRoot,
      disableClaudeFallback: isClaudeProjectFallbackDisabled(),
    }));
  }

  return targets;
}

export async function listOpenCodeGuidelines(
  sessionId: string,
  environment: CliEnvironment,
): Promise<MemoryGuidelineSummary[]> {
  const targets = await resolveOpenCodeGuidelineTargets(sessionId, environment);
  return Promise.all(targets.map(async (target): Promise<MemoryGuidelineSummary> => ({
    kind: target.kind,
    label: target.label,
    fileName: target.fileName,
    path: target.absolutePath,
    displayPath: toMemoryDisplayPath(target.absolutePath, environment),
    status: target.status,
    statusLabel: target.statusLabel,
    statusReason: target.statusReason,
    ...(await statFileSafe(target.absolutePath)),
  })));
}

export async function resolveOpenCodeGuidelineTarget(
  sessionId: string,
  environment: CliEnvironment,
  kind: MemoryGuidelineKind,
  rawName: string,
): Promise<OpenCodeGuidelineTarget> {
  const name = rawName.trim();
  if (!name) {
    throw new MemoryApiError("invalid_guideline_file", "Invalid OpenCode rules file", 400);
  }

  const targets = await resolveOpenCodeGuidelineTargets(sessionId, environment);
  const target = targets.find((candidate) => candidate.kind === kind && candidate.fileName === name);
  if (!target) {
    throw new MemoryApiError("guideline_unavailable", "OpenCode rules file is unavailable", 404);
  }
  return target;
}
