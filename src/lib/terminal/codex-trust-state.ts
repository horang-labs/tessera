import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CODEX_TRUST_BASELINE_FILE = '.tessera-trust-baseline.json';

type ProjectTrustLevel = 'trusted' | 'untrusted';

interface HookTrustState {
  enabled?: boolean;
  trustedHash?: string;
}

interface CodexTrustSnapshot {
  projects: Record<string, ProjectTrustLevel>;
  hooks: Record<string, HookTrustState>;
}

interface StoredTrustBaseline {
  version: 1;
  trust: CodexTrustSnapshot;
}

interface TomlScanState {
  basicMultiline: boolean;
  literalMultiline: boolean;
  arrayDepth: number;
}

interface TomlSection {
  start: number;
  headerEnd: number;
  end: number;
  kind: 'project' | 'hook' | 'other';
  key?: string;
}

const PROJECT_TRUST_LINE = /^[ \t]*trust_level[ \t]*=[ \t]*(?:"(trusted|untrusted)"|'(trusted|untrusted)')[ \t\r]*(?:#.*)?$/m;
const HOOK_ENABLED_LINE = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m;
const HOOK_HASH_LINE = /^[ \t]*trusted_hash[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t\r]*(?:#.*)?$/m;

/**
 * Persist only the trust view that existed before Codex started. Cleanup uses
 * this as the base of a three-way merge, so a concurrent edit to the user's
 * real config wins over a stale terminal snapshot.
 */
export function writeCodexTrustBaseline(overlayHome: string, configToml: string): void {
  const baseline: StoredTrustBaseline = {
    version: 1,
    trust: extractCodexTrustSnapshot(configToml),
  };
  fs.writeFileSync(
    path.join(overlayHome, CODEX_TRUST_BASELINE_FILE),
    JSON.stringify(baseline) + '\n',
    { mode: 0o600 },
  );
}

function serializeAdvancedCodexProjectTrustBaseline(
  baselineJson: string,
  finalOverlayConfig: string,
): string | null {
  const baseline = parseStoredBaseline(baselineJson);
  if (!baseline) return null;
  const finalTrust = extractCodexTrustSnapshot(finalOverlayConfig);
  const advanced: StoredTrustBaseline = {
    version: 1,
    trust: {
      projects: finalTrust.projects,
      hooks: baseline.hooks,
    },
  };
  return JSON.stringify(advanced) + '\n';
}

export function planCodexTrustPromotion(options: {
  baselineJson: string;
  finalOverlayConfig: string;
  currentAccountConfig: string;
  managedHooksPath: string;
  scope: 'all' | 'projects';
}): { accountConfig: string; advancedBaseline: string | null } {
  return {
    accountConfig: mergeCodexOverlayTrust({
      baselineJson: options.baselineJson,
      finalOverlayConfig: options.finalOverlayConfig,
      currentAccountConfig: options.currentAccountConfig,
      managedHooksPath: options.managedHooksPath,
      includeHookTrust: options.scope === 'all',
    }),
    advancedBaseline: options.scope === 'projects'
      ? serializeAdvancedCodexProjectTrustBaseline(
          options.baselineJson,
          options.finalOverlayConfig,
        )
      : null,
  };
}

export function serializeCodexTrustBaseline(configToml: string): string {
  const baseline: StoredTrustBaseline = {
    version: 1,
    trust: extractCodexTrustSnapshot(configToml),
  };
  return JSON.stringify(baseline) + '\n';
}

/**
 * Promote only trust fields changed by the Codex TUI. Model, sandbox, MCP and
 * every other config value remain isolated in the per-terminal overlay.
 */
export function mergeCodexOverlayTrust(options: {
  baselineJson: string;
  finalOverlayConfig: string;
  currentAccountConfig: string;
  managedHooksPath: string;
  includeHookTrust?: boolean;
}): string {
  const baseline = parseStoredBaseline(options.baselineJson);
  if (!baseline) return options.currentAccountConfig;

  const finalTrust = extractCodexTrustSnapshot(options.finalOverlayConfig);
  const currentTrust = extractCodexTrustSnapshot(options.currentAccountConfig);
  let merged = options.currentAccountConfig;

  for (const key of changedKeys(baseline.projects, finalTrust.projects)) {
    const before = baseline.projects[key];
    const after = finalTrust.projects[key];
    const current = currentTrust.projects[key];
    if (current !== before) continue;
    merged = setProjectTrust(merged, key, after);
  }

  if (options.includeHookTrust !== false) {
    for (const key of changedKeys(baseline.hooks, finalTrust.hooks, hookStateEqual)) {
      if (hookTrustBelongsToManagedOverlay(key, options.managedHooksPath)) continue;
      const before = baseline.hooks[key];
      const after = finalTrust.hooks[key];
      const current = currentTrust.hooks[key];
      if (!hookStateEqual(current, before)) continue;
      merged = setHookTrust(merged, key, after);
    }
  }

  return merged;
}

export function writeCodexConfigAtomically(configPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, configPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
    }
  }
}

function parseStoredBaseline(value: string): CodexTrustSnapshot | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredTrustBaseline>;
    if (parsed.version !== 1 || !parsed.trust) return null;
    if (!isRecord(parsed.trust.projects) || !isRecord(parsed.trust.hooks)) return null;
    return parsed.trust;
  } catch {
    return null;
  }
}

function extractCodexTrustSnapshot(configToml: string): CodexTrustSnapshot {
  const projects: Record<string, ProjectTrustLevel> = {};
  const hooks: Record<string, HookTrustState> = {};

  for (const section of scanTomlSections(configToml)) {
    if (!section.key || section.kind === 'other') continue;
    const body = configToml.slice(section.headerEnd, section.end);
    if (section.kind === 'project') {
      const match = PROJECT_TRUST_LINE.exec(body);
      const trust = match?.[1] ?? match?.[2];
      if (trust === 'trusted' || trust === 'untrusted') projects[section.key] = trust;
      continue;
    }

    const enabledMatch = HOOK_ENABLED_LINE.exec(body);
    const hashMatch = HOOK_HASH_LINE.exec(body);
    const state: HookTrustState = {};
    if (enabledMatch) state.enabled = enabledMatch[1] === 'true';
    if (hashMatch) state.trustedHash = unescapeTomlBasicString(hashMatch[1]);
    if (state.enabled !== undefined || state.trustedHash !== undefined) {
      hooks[section.key] = state;
    }
  }

  return { projects, hooks };
}

function changedKeys<T>(
  before: Record<string, T>,
  after: Record<string, T>,
  equal: (left: T | undefined, right: T | undefined) => boolean = Object.is,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !equal(before[key], after[key]));
}

function hookStateEqual(left: HookTrustState | undefined, right: HookTrustState | undefined): boolean {
  return left?.enabled === right?.enabled && left?.trustedHash === right?.trustedHash;
}

function hookTrustBelongsToManagedOverlay(key: string, managedHooksPath: string): boolean {
  const sourcePath = hookTrustSourcePath(key);
  if (!sourcePath) return false;
  return normalizePathForComparison(sourcePath) === normalizePathForComparison(managedHooksPath);
}

function hookTrustSourcePath(key: string): string | null {
  const lastColon = key.lastIndexOf(':');
  const secondLast = key.lastIndexOf(':', lastColon - 1);
  const thirdLast = key.lastIndexOf(':', secondLast - 1);
  if (lastColon < 0 || secondLast < 0 || thirdLast < 0) return null;
  if (!/^\d+$/.test(key.slice(lastColon + 1))) return null;
  if (!/^\d+$/.test(key.slice(secondLast + 1, lastColon))) return null;
  return key.slice(0, thirdLast);
}

function normalizePathForComparison(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function setProjectTrust(
  content: string,
  projectPath: string,
  trust: ProjectTrustLevel | undefined,
): string {
  const section = findLastSection(content, 'project', projectPath);
  if (!section) {
    if (!trust) return content;
    return appendTomlBlock(content, [
      `[projects."${escapeTomlBasicString(projectPath)}"]`,
      `trust_level = "${trust}"`,
    ]);
  }
  return replaceSectionField(content, section, PROJECT_TRUST_LINE, trust
    ? `trust_level = "${trust}"`
    : undefined);
}

function setHookTrust(
  content: string,
  key: string,
  state: HookTrustState | undefined,
): string {
  const section = findLastSection(content, 'hook', key);
  if (!state) {
    return section ? removeSection(content, section) : content;
  }
  if (!section) {
    const lines = [`[hooks.state.${formatHookStateKey(key)}]`];
    if (state.enabled !== undefined) lines.push(`enabled = ${state.enabled}`);
    if (state.trustedHash !== undefined) {
      lines.push(`trusted_hash = "${escapeTomlBasicString(state.trustedHash)}"`);
    }
    return appendTomlBlock(content, lines);
  }

  let updated = replaceSectionField(
    content,
    section,
    HOOK_ENABLED_LINE,
    state.enabled === undefined ? undefined : `enabled = ${state.enabled}`,
  );
  const refreshed = findLastSection(updated, 'hook', key);
  if (!refreshed) return updated;
  updated = replaceSectionField(
    updated,
    refreshed,
    HOOK_HASH_LINE,
    state.trustedHash === undefined
      ? undefined
      : `trusted_hash = "${escapeTomlBasicString(state.trustedHash)}"`,
  );
  return updated;
}

function replaceSectionField(
  content: string,
  section: TomlSection,
  pattern: RegExp,
  replacement: string | undefined,
): string {
  const body = content.slice(section.headerEnd, section.end);
  if (pattern.test(body)) {
    const nextBody = replacement ? body.replace(pattern, replacement) : body.replace(pattern, '');
    return content.slice(0, section.headerEnd) + nextBody + content.slice(section.end);
  }
  if (!replacement) return content;
  const eol = detectEol(content);
  return content.slice(0, section.headerEnd)
    + eol + replacement
    + body
    + content.slice(section.end);
}

function removeSection(content: string, section: TomlSection): string {
  let end = section.end;
  while (end < content.length && (content[end] === '\r' || content[end] === '\n')) end += 1;
  return content.slice(0, section.start) + content.slice(end);
}

function appendTomlBlock(content: string, lines: string[]): string {
  const eol = detectEol(content);
  const trimmed = content.replace(/[\r\n]+$/, '');
  return `${trimmed}${trimmed ? eol + eol : ''}${lines.join(eol)}${eol}`;
}

function findLastSection(
  content: string,
  kind: TomlSection['kind'],
  key: string,
): TomlSection | undefined {
  return scanTomlSections(content).filter((section) => (
    section.kind === kind && section.key === key
  )).at(-1);
}

function scanTomlSections(content: string): TomlSection[] {
  const headers: Array<Omit<TomlSection, 'end'>> = [];
  let cursor = 0;
  let state: TomlScanState = { basicMultiline: false, literalMultiline: false, arrayDepth: 0 };
  while (cursor < content.length) {
    const newline = content.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? content.length : newline;
    const nextCursor = newline === -1 ? content.length : newline + 1;
    const line = content.slice(cursor, lineEnd).replace(/\r$/, '');
    if (isStructuralLine(state)) {
      const headerBody = parseTomlHeaderBody(line);
      if (headerBody !== null) {
        const parsed = classifyTomlHeader(headerBody);
        headers.push({
          start: cursor,
          headerEnd: lineEnd,
          kind: parsed.kind,
          ...(parsed.key === undefined ? {} : { key: parsed.key }),
        });
      }
    }
    state = updateScanState(state, line);
    cursor = nextCursor;
  }
  return headers.map((header, index) => ({
    ...header,
    end: headers[index + 1]?.start ?? content.length,
  }));
}

function classifyTomlHeader(body: string): Pick<TomlSection, 'kind' | 'key'> {
  const projectKey = parseQuotedDottedKey(body, 'projects');
  if (projectKey !== null) return { kind: 'project', key: projectKey };
  const hookKey = parseQuotedDottedKey(body, 'hooks.state');
  if (hookKey !== null) return { kind: 'hook', key: hookKey };
  return { kind: 'other' };
}

function parseQuotedDottedKey(body: string, prefix: string): string | null {
  const escapedPrefix = prefix.replaceAll('.', '\\.');
  const match = new RegExp(
    `^${escapedPrefix}\\s*\\.\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'([^']*)')\\s*$`,
  ).exec(body.trim());
  if (!match) return null;
  return match[1] === undefined ? match[2] : unescapeTomlBasicString(match[1]);
}

function parseTomlHeaderBody(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  let quote: 'basic' | 'literal' | null = null;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote === 'basic') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === 'literal') {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"') quote = 'basic';
    else if (char === "'") quote = 'literal';
    else if (char === ']') {
      return /^\s*(?:#.*)?$/.test(trimmed.slice(index + 1))
        ? trimmed.slice(1, index)
        : null;
    }
  }
  return null;
}

function isStructuralLine(state: TomlScanState): boolean {
  return !state.basicMultiline && !state.literalMultiline && state.arrayDepth === 0;
}

function updateScanState(state: TomlScanState, line: string): TomlScanState {
  let mode: 'basic' | 'literal' | null = state.basicMultiline
    ? 'basic'
    : state.literalMultiline ? 'literal' : null;
  let arrayDepth = state.arrayDepth;
  for (let index = 0; index < line.length; index += 1) {
    if (mode === 'basic') {
      if (line[index] === '\\') index += 1;
      else if (line.startsWith('"""', index)) {
        mode = null;
        index += 2;
      }
      continue;
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null;
        index += 2;
      }
      continue;
    }
    if (line[index] === '#') break;
    if (line.startsWith('"""', index)) {
      mode = 'basic';
      index += 2;
    } else if (line.startsWith("'''", index)) {
      mode = 'literal';
      index += 2;
    } else if (line[index] === '"') {
      index = skipQuotedString(line, index, '"');
    } else if (line[index] === "'") {
      index = skipQuotedString(line, index, "'");
    } else if (line[index] === '[') arrayDepth += 1;
    else if (line[index] === ']') arrayDepth = Math.max(0, arrayDepth - 1);
  }
  return {
    basicMultiline: mode === 'basic',
    literalMultiline: mode === 'literal',
    arrayDepth,
  };
}

function skipQuotedString(line: string, start: number, quote: '"' | "'"): number {
  for (let index = start + 1; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') index += 1;
    else if (line[index] === quote) return index;
  }
  return line.length;
}

function formatHookStateKey(key: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(key) || key.startsWith('\\\\');
  if (windowsPath && !key.includes("'")) return `'${key}'`;
  return `"${escapeTomlBasicString(key)}"`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

function unescapeTomlBasicString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
