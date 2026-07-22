export const MEMORY_INDEX_FILE_NAME = "MEMORY.md";

export type MemoryProviderKind = "claude-code" | "codex" | "opencode";

export type MemoryEntryType = "user" | "feedback" | "project" | "reference";

/**
 * What a memory tab points at:
 * - `memory`: a file in `~/.claude/projects/<slug>/memory/`
 * - `global-guideline`: `~/.claude/CLAUDE.md` (applies to every project)
 * - `project-guideline`: `<workspace>/CLAUDE.md` (this project's instructions)
 * Codex reuses the guideline kinds for AGENTS files and `memory` for files
 * under `$CODEX_HOME/memories`. OpenCode uses guideline kinds for rule files
 * only; it has no built-in memory files in this UI.
 */
export type MemoryTargetKind = "memory" | "global-guideline" | "project-guideline";

export type MemoryGuidelineKind = "global-guideline" | "project-guideline";

export type MemoryGuidelineStatus = "active" | "shadowed";

export type MemoryGuidelineStatusReason =
  | "active"
  | "fallback-active"
  | "custom-instructions"
  | "shadowed-by-override"
  | "shadowed-by-agents"
  | "shadowed-by-opencode-global"
  | "disabled-by-env";

export interface MemoryGuidelineSummary {
  kind: MemoryGuidelineKind;
  /** Human label, e.g. "Global CLAUDE.md". */
  label: string;
  fileName: string;
  /** Absolute path on the host filesystem, used to open/reveal the file. */
  path: string;
  /** Same file as the CLI sees it; `path` on non-bridged setups. */
  displayPath: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  status: MemoryGuidelineStatus;
  statusLabel: string;
  statusReason?: MemoryGuidelineStatusReason;
}

/**
 * Which workspace path the memory directory slug was derived from.
 * Clients echo this back on writes so reads and writes stay in the same
 * directory even when the other candidate appears mid-edit.
 */
export type MemoryRootKey = "workDir" | "project";

export interface MemoryFileSummary {
  fileName: string;
  /** Path relative to the provider memory root; defaults to fileName. */
  relativePath: string;
  /** Frontmatter `name`, falling back to the file name without extension. */
  name: string;
  /** Frontmatter `description`, empty when absent. */
  description: string;
  /** Frontmatter `metadata.type`, null when absent or unrecognized. */
  type: MemoryEntryType | null;
  size: number;
  mtimeMs: number;
  isIndex: boolean;
  section: "project-memory" | "global-memory" | "rollout-summaries" | "ad-hoc-notes" | "memory-skills";
  readOnly: boolean;
}

/**
 * Paths travel in two forms because the server and the CLI can live on
 * different sides of a WSL bridge: the `*Display` values are what the CLI
 * reads (and therefore what the user must see), while the plain values stay
 * host-filesystem paths so Electron can open and reveal them. On non-bridged
 * setups the two are identical.
 */
export interface MemoryListData {
  sessionId: string;
  provider: MemoryProviderKind;
  memoryDir: string;
  memoryDirDisplay: string;
  instructionRoots: {
    user: string;
    project: string | null;
  };
  instructionRootsDisplay: {
    user: string;
    project: string | null;
  };
  root: MemoryRootKey;
  exists: boolean;
  files: MemoryFileSummary[];
  memoryScopeLabel: string;
  memoryScopeDescription: string;
  /** Provider instruction files, shown above the memory list. */
  guidelines: MemoryGuidelineSummary[];
}

export interface MemoryFileData {
  sessionId: string;
  provider: MemoryProviderKind;
  kind: MemoryTargetKind;
  /** Directory the target lives in (memory dir or CLAUDE.md's folder). */
  dir: string;
  root: MemoryRootKey;
  /** Display file name. */
  fileName: string;
  /** Relative path inside the provider memory root, or fileName for guidelines. */
  relativePath: string;
  content: string;
  size: number;
  mtimeMs: number;
  readOnly: boolean;
}
