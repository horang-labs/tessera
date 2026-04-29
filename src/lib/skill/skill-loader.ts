import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import logger from '../logger';
import { execCli, isRunningInWsl, type CliEnvironment } from '../cli/cli-exec';

export interface SkillInfo {
  name: string;
  description: string;
}

interface SkillEntry {
  info: SkillInfo;
  content: string;
}

/** Manifest for a single plugin (.claude-plugin/plugin.json) */
interface PluginManifest {
  name?: string;
  skills?: string | string[];
}

/** Plugin entry within a marketplace.json */
interface MarketplacePluginEntry {
  name: string;
  source?: string | { source: string; url: string };
  skills?: string | string[];
  version?: string;
}

/** Top-level marketplace.json */
interface MarketplaceManifest {
  name?: string;
  plugins?: MarketplacePluginEntry[];
}

interface InstalledPluginRecord {
  installPath?: string;
  version?: string;
}

interface InstalledPluginsManifest {
  version?: number;
  plugins?: Record<string, InstalledPluginRecord[]>;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  userInvocable?: boolean;
  body: string;
}

export function getClaudeConfigDir(): string {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configuredDir ? resolve(configuredDir) : join(homedir(), '.claude');
}

function lastNonEmptyLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? null;
}

export async function resolveClaudeConfigDirForEnvironment(
  environment: CliEnvironment,
): Promise<string> {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configuredDir) return resolve(configuredDir);

  if (environment === 'wsl' && process.platform === 'win32') {
    const result = await execCli(
      'sh',
      ['-lc', 'wslpath -w "$HOME/.claude" 2>/dev/null || printf %s "$HOME/.claude"'],
      'wsl',
      5000,
    );
    const resolvedDir = lastNonEmptyLine(result.stdout);
    if (result.ok && resolvedDir) return resolvedDir;
  }

  if (environment === 'native' && isRunningInWsl()) {
    const result = await execCli(
      'powershell.exe',
      ['-NoProfile', '-Command', '[Environment]::GetFolderPath("UserProfile")'],
      'native',
      5000,
    );
    const windowsHome = lastNonEmptyLine(result.stdout);
    const wslConfigDir = windowsHome ? toWslPath(`${windowsHome}\\.claude`) : null;
    if (result.ok && wslConfigDir) return wslConfigDir;
  }

  return getClaudeConfigDir();
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith('---')) {
    return { body: raw };
  }

  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) {
    return { body: raw };
  }

  const frontmatter = raw.slice(3, endIdx);
  const body = raw.slice(endIdx + 3).trimStart();

  let name: string | undefined;
  let description: string | undefined;
  let userInvocable: boolean | undefined;

  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('name:')) {
      name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '');
    } else if (trimmed.startsWith('description:')) {
      description = trimmed.slice(12).trim().replace(/^["']|["']$/g, '');
    } else if (trimmed.startsWith('user-invocable:')) {
      const val = trimmed.slice(15).trim().toLowerCase();
      userInvocable = val !== 'false';
    }
  }

  return { name, description, userInvocable, body };
}

function loadFromDir(dir: string): Map<string, SkillEntry> {
  const map = new Map<string, SkillEntry>();

  if (!existsSync(dir)) {
    logger.debug({ path: dir }, 'Skills directory not found');
    return map;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.error({ dir, error: err }, 'Failed to read skills directory');
    return map;
  }

  for (const entry of entries) {
    const dirPath = join(dir, entry);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(dirPath, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    try {
      const raw = readFileSync(skillPath, 'utf-8');
      const { name, description } = parseFrontmatter(raw);

      const skillName = name || entry;
      map.set(skillName, {
        info: {
          name: skillName,
          description: description || '',
        },
        content: raw, // full content including frontmatter
      });
    } catch (err) {
      logger.warn({ entry, error: err }, 'Failed to read skill');
    }
  }

  logger.info({ count: map.size }, 'Skills loaded');
  return map;
}

// ---------------------------------------------------------------------------
// Plugin marketplace scanning (manifest-driven)
// ---------------------------------------------------------------------------

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pluginKey(marketplaceName: string, pluginName: string): string {
  return `${pluginName}@${marketplaceName}`;
}

function parsePluginKey(value: string): { marketplaceName: string; pluginName: string } | null {
  const separatorIndex = value.lastIndexOf('@');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  return {
    pluginName: value.slice(0, separatorIndex),
    marketplaceName: value.slice(separatorIndex + 1),
  };
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function toWslPath(value: string): string | null {
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match || process.platform === 'win32') return null;

  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/[\\/]+/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function resolveExistingDir(value: string, configDir = getClaudeConfigDir()): string | null {
  const candidates = [value];
  const wslPath = toWslPath(value);
  if (wslPath) candidates.push(wslPath);

  if (!isWindowsAbsolutePath(value) && !value.startsWith('/')) {
    candidates.unshift(resolve(configDir, value));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && isDir(candidate)) return candidate;
  }

  return null;
}

/**
 * Load command .md files from a directory.
 * Each .md file becomes a command named `{pluginName}:{filename}`.
 */
function loadCommandMdFiles(map: Map<string, SkillEntry>, dir: string, pluginName: string): void {
  if (!existsSync(dir)) return;

  for (const file of safeReaddir(dir)) {
    if (!file.endsWith('.md')) continue;
    const filePath = join(dir, file);
    if (isDir(filePath)) continue;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { description, userInvocable } = parseFrontmatter(raw);

      // CLI skips commands with user-invocable: false (default: true)
      if (userInvocable === false) continue;

      const commandName = basename(file, '.md');
      const qualifiedName = `${pluginName}:${commandName}`;

      map.set(qualifiedName, {
        info: {
          name: qualifiedName,
          description: description || '',
        },
        content: raw,
      });
    } catch (err) {
      logger.warn({ file, error: err }, 'Failed to read plugin command');
    }
  }
}

/**
 * Load a SKILL.md from a skill directory.
 * Named `{pluginName}:{skillName}`.
 */
function loadSkillDir(map: Map<string, SkillEntry>, skillDir: string, pluginName: string): void {
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) return;

  try {
    const raw = readFileSync(skillPath, 'utf-8');
    const { name, description, userInvocable } = parseFrontmatter(raw);

    // CLI skips skills with user-invocable: false (default: true)
    if (userInvocable === false) return;

    const skillName = name || basename(skillDir);
    const qualifiedName = `${pluginName}:${skillName}`;

    map.set(qualifiedName, {
      info: {
        name: qualifiedName,
        description: description || '',
      },
      content: raw,
    });
  } catch (err) {
    logger.warn({ skillDir, error: err }, 'Failed to read plugin skill');
  }
}

/**
 * Given a skills field value and a base directory, load skills into the map.
 *
 * skills field formats:
 * - string (directory path, e.g. "./commands/") → scan *.md files as commands
 * - string[] (array of skill directory paths) → each has SKILL.md
 */
function loadSkillsField(
  map: Map<string, SkillEntry>,
  skillsField: string | string[],
  baseDir: string,
  pluginName: string,
): void {
  if (typeof skillsField === 'string') {
    // Directory path — scan for .md command files AND nested skill dirs with SKILL.md
    const dir = resolve(baseDir, skillsField);
    if (!existsSync(dir) || !isDir(dir)) return;

    loadCommandMdFiles(map, dir, pluginName);

    // Also check for nested skill directories (dir/*/SKILL.md)
    for (const entry of safeReaddir(dir)) {
      const entryPath = join(dir, entry);
      if (isDir(entryPath) && existsSync(join(entryPath, 'SKILL.md'))) {
        loadSkillDir(map, entryPath, pluginName);
      }
    }
  } else if (Array.isArray(skillsField)) {
    // Array of skill directory paths
    for (const skillPath of skillsField) {
      if (typeof skillPath !== 'string') continue;
      const resolved = resolve(baseDir, skillPath);
      if (isDir(resolved)) {
        loadSkillDir(map, resolved, pluginName);
      }
    }
  }
}

/**
 * Convention-based fallback: scan commands/ and skills/ directories.
 */
function loadByConvention(map: Map<string, SkillEntry>, pluginDir: string, pluginName: string): void {
  const commandsDir = join(pluginDir, 'commands');
  if (existsSync(commandsDir) && isDir(commandsDir)) {
    loadCommandMdFiles(map, commandsDir, pluginName);
  }

  const skillsDir = join(pluginDir, 'skills');
  if (existsSync(skillsDir) && isDir(skillsDir)) {
    for (const entry of safeReaddir(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      if (isDir(entryPath)) {
        loadSkillDir(map, entryPath, pluginName);
      }
    }
  }
}

/**
 * Resolve the cached version directory for a plugin.
 * CLI reads all plugins (local and remote) from the cache directory at runtime,
 * so Tessera should do the same to stay consistent.
 */
function resolveCachedPluginDir(
  marketplaceName: string,
  pluginName: string,
  version?: string,
  configDir = getClaudeConfigDir(),
): string | null {
  const cacheBase = join(configDir, 'plugins', 'cache', marketplaceName, pluginName);
  if (!existsSync(cacheBase) || !isDir(cacheBase)) return null;

  // Try the exact version specified in marketplace entry
  if (version) {
    const versionDir = join(cacheBase, version);
    if (existsSync(versionDir) && isDir(versionDir)) return versionDir;
  }

  // Fallback: pick the latest available cached version
  const versions = safeReaddir(cacheBase).filter((v) => isDir(join(cacheBase, v)));
  if (versions.length === 0) return null;
  versions.sort().reverse();
  return join(cacheBase, versions[0]);
}

/**
 * Resolve the source path for a marketplace plugin entry.
 * Priority: cache directory (matches CLI behavior) → marketplace directory (fallback for local plugins).
 */
function resolvePluginSourceDir(
  entry: MarketplacePluginEntry,
  marketplaceDir: string,
  configDir = getClaudeConfigDir(),
): string | null {
  if (!entry.source) return null;

  const marketplaceName = basename(marketplaceDir);
  const pluginName = entry.name;
  if (!pluginName) return null;

  // Always try cache first (CLI reads from cache at runtime)
  const cached = resolveCachedPluginDir(marketplaceName, pluginName, entry.version, configDir);
  if (cached) return cached;

  // Fallback: local source path (for plugins not yet cached)
  if (typeof entry.source === 'string') {
    return resolve(marketplaceDir, entry.source);
  }

  return null;
}

function resolveInstalledPluginDir(
  pluginId: string,
  record: InstalledPluginRecord,
  configDir = getClaudeConfigDir(),
): { dir: string; marketplaceName: string; pluginName: string } | null {
  const parsed = parsePluginKey(pluginId);
  if (!parsed) return null;

  if (record.installPath) {
    const installPath = resolveExistingDir(record.installPath, configDir);
    if (installPath) {
      return {
        dir: installPath,
        marketplaceName: parsed.marketplaceName,
        pluginName: parsed.pluginName,
      };
    }
  }

  const cached = resolveCachedPluginDir(
    parsed.marketplaceName,
    parsed.pluginName,
    record.version,
    configDir,
  );
  if (!cached) return null;

  return {
    dir: cached,
    marketplaceName: parsed.marketplaceName,
    pluginName: parsed.pluginName,
  };
}

/**
 * Load a single plugin (reads its plugin.json for skills field, falls back to convention).
 * CLI behavior: the "main" skill (where command name === plugin name) is placed first.
 */
function loadSinglePlugin(
  map: Map<string, SkillEntry>,
  pluginDir: string,
  pluginName: string,
  marketplaceSkillsField?: string | string[],
): void {
  if (!existsSync(pluginDir) || !isDir(pluginDir)) return;

  // Load into a temporary map first, then reorder before merging into the main map
  const pluginMap = new Map<string, SkillEntry>();

  // Priority: marketplace entry skills → plugin.json skills → convention
  if (marketplaceSkillsField) {
    loadSkillsField(pluginMap, marketplaceSkillsField, pluginDir, pluginName);
  } else {
    const pluginJson = readJsonFile<PluginManifest>(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
    );
    if (pluginJson?.skills) {
      loadSkillsField(pluginMap, pluginJson.skills, pluginDir, pluginName);
    } else {
      loadByConvention(pluginMap, pluginDir, pluginName);
    }
  }

  // CLI puts the "main" skill first via unshift().
  // The main skill is the one whose command name is a prefix of all other commands
  // (e.g., "aidlc" is the prefix of "aidlc-nfr-requirements", "aidlc-user-stories", etc.)
  const commandNames = [...pluginMap.keys()].map((k) => k.split(':')[1] || '');
  let mainKey: string | null = null;

  for (const [key] of pluginMap) {
    const cmdName = key.split(':')[1] || '';
    const isPrefix = commandNames.every(
      (other) => other === cmdName || other.startsWith(cmdName + '-'),
    );
    if (isPrefix && commandNames.length > 1) {
      mainKey = key;
      break;
    }
  }

  if (mainKey) {
    map.set(mainKey, pluginMap.get(mainKey)!);
  }
  for (const [key, entry] of pluginMap) {
    if (key !== mainKey) {
      map.set(key, entry);
    }
  }
}

/**
 * Load plugins from Claude Code's installed plugin registry.
 *
 * Windows installs may only have `plugins/installed_plugins.json` plus cache
 * directories available to the Electron server. Reading this registry directly
 * matches the CLI's installed-plugin source of truth and avoids depending on a
 * marketplace checkout being present.
 */
function loadInstalledPlugins(
  map: Map<string, SkillEntry>,
  loadedPluginKeys: Set<string>,
  configDir = getClaudeConfigDir(),
): number {
  const manifest = readJsonFile<InstalledPluginsManifest>(
    join(configDir, 'plugins', 'installed_plugins.json'),
  );
  if (!manifest?.plugins) return 0;

  let loaded = 0;
  for (const [pluginId, records] of Object.entries(manifest.plugins)) {
    if (!Array.isArray(records)) continue;

    for (const record of records) {
      const resolved = resolveInstalledPluginDir(pluginId, record, configDir);
      if (!resolved) continue;

      loadSinglePlugin(map, resolved.dir, resolved.pluginName);
      loadedPluginKeys.add(pluginKey(resolved.marketplaceName, resolved.pluginName));
      loaded += 1;
    }
  }

  return loaded;
}

function loadCacheOnlyPlugins(
  map: Map<string, SkillEntry>,
  loadedPluginKeys: Set<string>,
  configDir = getClaudeConfigDir(),
): number {
  const cacheDir = join(configDir, 'plugins', 'cache');
  if (!existsSync(cacheDir) || !isDir(cacheDir)) return 0;

  let loaded = 0;
  for (const marketplaceName of safeReaddir(cacheDir)) {
    const marketplaceDir = join(cacheDir, marketplaceName);
    if (!isDir(marketplaceDir)) continue;

    for (const pluginName of safeReaddir(marketplaceDir)) {
      const key = pluginKey(marketplaceName, pluginName);
      if (loadedPluginKeys.has(key)) continue;

      const pluginRoot = join(marketplaceDir, pluginName);
      if (!isDir(pluginRoot)) continue;

      const pluginDir = resolveCachedPluginDir(marketplaceName, pluginName, undefined, configDir);
      if (!pluginDir) continue;

      loadSinglePlugin(map, pluginDir, pluginName);
      loadedPluginKeys.add(key);
      loaded += 1;
    }
  }

  return loaded;
}

/**
 * Scan plugin registries/marketplaces/cache and load their skills/commands.
 */
function loadPluginMarketplaces(configDir = getClaudeConfigDir()): Map<string, SkillEntry> {
  const map = new Map<string, SkillEntry>();
  const loadedPluginKeys = new Set<string>();
  const installedPluginCount = loadInstalledPlugins(map, loadedPluginKeys, configDir);
  const marketplacesDir = join(configDir, 'plugins', 'marketplaces');

  if (existsSync(marketplacesDir)) {
    for (const marketplaceName of safeReaddir(marketplacesDir)) {
      const marketplaceDir = join(marketplacesDir, marketplaceName);
      if (!isDir(marketplaceDir)) continue;

      const manifest = readJsonFile<MarketplaceManifest>(
        join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      );

      if (manifest?.plugins) {
        for (const pluginEntry of manifest.plugins) {
          const pluginName = pluginEntry.name || marketplaceName;
          const key = pluginKey(marketplaceName, pluginName);
          if (loadedPluginKeys.has(key)) continue;

          const sourceDir = resolvePluginSourceDir(pluginEntry, marketplaceDir, configDir);
          if (!sourceDir) continue; // skip remote-only plugins

          loadSinglePlugin(map, sourceDir, pluginName, pluginEntry.skills);
          loadedPluginKeys.add(key);
        }
      } else {
        // No marketplace.json or no plugins array — treat the directory itself as a plugin
        const key = pluginKey(marketplaceName, marketplaceName);
        if (loadedPluginKeys.has(key)) continue;

        loadSinglePlugin(map, marketplaceDir, marketplaceName);
        loadedPluginKeys.add(key);
      }
    }
  }

  const cacheOnlyPluginCount = installedPluginCount === 0
    ? loadCacheOnlyPlugins(map, loadedPluginKeys, configDir)
    : 0;

  logger.info({
    count: map.size,
    installedPlugins: installedPluginCount,
    cacheOnlyPlugins: cacheOnlyPluginCount,
  }, 'Plugin skills loaded');
  return map;
}

function ensureLoaded(configDir = getClaudeConfigDir()): Map<string, SkillEntry> {
  return loadFromDir(join(configDir, 'skills'));
}

function ensurePluginsLoaded(configDir = getClaudeConfigDir()): Map<string, SkillEntry> {
  return loadPluginMarketplaces(configDir);
}

/**
 * CLI built-in commands that work via stdin in --print mode.
 * These are NOT file-based skills — they are hardcoded in the CLI binary.
 * They are sent as "/commandName" directly to CLI stdin (not as .md content).
 */
const BUILTIN_COMMANDS: SkillEntry[] = [
  { info: { name: 'compact', description: 'Clear conversation history but keep a summary in context' }, content: '' },
  { info: { name: 'cost', description: 'Show the total cost and duration of the current session' }, content: '' },
  { info: { name: 'context', description: 'Show current context window usage' }, content: '' },
];

/** Check if a skill name is a CLI built-in command (not a file-based skill) */
export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((cmd) => cmd.info.name === name);
}

export function getSkillList(projectCwd?: string, configDir = getClaudeConfigDir()): SkillInfo[] {
  const globalDir = join(configDir, 'skills');
  const pluginSkills = ensurePluginsLoaded(configDir);

  if (!projectCwd) {
    const globalSkills = ensureLoaded(configDir);
    const merged = new Map(pluginSkills);
    for (const [name, entry] of globalSkills) {
      merged.set(name, entry);
    }
    // Add built-in commands (lowest priority — overridden by any skill with same name)
    for (const cmd of BUILTIN_COMMANDS) {
      if (!merged.has(cmd.info.name)) {
        merged.set(cmd.info.name, cmd);
      }
    }
    return Array.from(merged.values()).map((e) => e.info);
  }

  // With project CWD: merge plugin + global + local (local overrides global, global overrides plugin)
  const globalSkills = loadFromDir(globalDir);
  const localDir = join(projectCwd, '.claude', 'skills');
  const localSkills = loadFromDir(localDir);

  const merged = new Map(pluginSkills);
  for (const [name, entry] of globalSkills) {
    merged.set(name, entry);
  }
  for (const [name, entry] of localSkills) {
    merged.set(name, entry);
  }
  // Add built-in commands (lowest priority)
  for (const cmd of BUILTIN_COMMANDS) {
    if (!merged.has(cmd.info.name)) {
      merged.set(cmd.info.name, cmd);
    }
  }

  logger.info({
    plugin: pluginSkills.size,
    global: globalSkills.size,
    local: localSkills.size,
    builtin: BUILTIN_COMMANDS.length,
    merged: merged.size,
    }, 'Skills loaded (plugin+global+local+builtin)');

  return Array.from(merged.values()).map((e) => e.info);
}

export function getSkillContent(name: string, configDir = getClaudeConfigDir()): string | null {
  // Always do a fresh load to avoid stale cache issues across module instances
  // (Next.js webpack and tsx maintain separate module caches in dev mode)
  const globalDir = join(configDir, 'skills');
  const globalMap = loadFromDir(globalDir);
  const found = globalMap.get(name);
  if (found) return found.content;

  const pluginMap = loadPluginMarketplaces(configDir);
  return pluginMap.get(name)?.content ?? null;
}
