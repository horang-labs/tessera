import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import type { UserSettings } from '@/lib/settings/types';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every tree a reference could hide in, plus the standalone server entry point. */
const SCAN_TARGETS = ['src', 'tests', 'electron', 'scripts', 'docs', 'server.ts'];

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.md']);

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  'dist',
  'dist-server',
  'dist-electron',
]);

/**
 * Dated records describe the code as it stood when they were written, so their
 * citations stay dangling on purpose: ADR `0005` cites these symbols as the
 * state that justified the decision, and the gap analysis is a survey snapshot
 * whose whole finding was that the templates had no call site. This test file
 * names the symbols too, to assert their absence.
 */
const EXEMPT_FILES = new Set([
  path.join('docs', 'adr', '0005-product-executes-git-no-agent-recovery.md'),
  path.join('docs', 'research', 'open-source-common-feature-gap-analysis-2026-08.md'),
  path.join('tests', 'git-prompt-templates-removed.test.ts'),
]);

function collectScannedFiles(target: string): string[] {
  const absolute = path.join(repoRoot, target);
  const stats = fs.statSync(absolute);

  if (stats.isFile()) {
    return SCANNED_EXTENSIONS.has(path.extname(target)) ? [target] : [];
  }

  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name)
        ? []
        : collectScannedFiles(path.join(target, entry.name));
    }
    return SCANNED_EXTENSIONS.has(path.extname(entry.name))
      ? [path.join(target, entry.name)]
      : [];
  });
}

const scannedFiles = SCAN_TARGETS.flatMap(collectScannedFiles)
  .filter((relativePath) => !EXEMPT_FILES.has(relativePath));

test('git settings keep the branch prefix', () => {
  const settings = normalizeUserSettings({
    gitConfig: { branchPrefix: 'feature/' },
  });

  assert.equal(settings.gitConfig.branchPrefix, 'feature/');
});

test('git settings keep Source Control AI provider and model defaults', () => {
  const settings = normalizeUserSettings({
    gitConfig: {
      branchPrefix: '',
      sourceControlAi: { provider: 'codex', model: 'gpt-5.6-codex' },
    },
  });

  assert.deepEqual(settings.gitConfig.sourceControlAi, {
    provider: 'codex',
    model: 'gpt-5.6-codex',
  });
});

test('a stored record still carrying prompt templates loads without error', () => {
  // Written the way an older settings.json actually looks on disk: the removed
  // fields are no longer part of GitConfig, so the cast is the point of the test.
  const stored = {
    gitConfig: {
      branchPrefix: 'wip/',
      globalGuidelines: 'Reply in English.',
      actionTemplates: {
        commit: 'Commit everything.',
        createPr: 'Open a PR for {{branch}}.',
      },
      // Older shapes that were already being stripped.
      commitGuidelines: 'legacy commit text',
      prGuidelines: 'legacy pr text',
    },
  } as unknown as Partial<UserSettings>;

  const settings = normalizeUserSettings(stored);

  assert.deepEqual(settings.gitConfig, {
    branchPrefix: 'wip/',
    sourceControlAi: { provider: 'claude-code', model: '' },
  });
});

test('the prompt-template module and builder are gone', () => {
  for (const relativePath of [
    'src/lib/git/action-templates.ts',
    'src/components/git/git-action-prompts.ts',
  ]) {
    assert.equal(
      fs.existsSync(new URL(relativePath, new URL('..', import.meta.url))),
      false,
      `${relativePath} should be deleted`,
    );
  }
});

test('the scan covers every tree a reference could hide in', () => {
  // Guards the scan itself: a bad root or an over-eager skip would empty it out
  // and the reference test below would pass while asserting nothing.
  assert.ok(scannedFiles.length > 500, `only ${scannedFiles.length} files scanned`);

  for (const target of SCAN_TARGETS) {
    assert.ok(
      scannedFiles.some((relativePath) => relativePath === target || relativePath.startsWith(`${target}${path.sep}`)),
      `nothing scanned under ${target}`,
    );
  }
});

test('no file references the removed prompt-template symbols', () => {
  const patterns = [
    'action-templates',
    'buildGitActionPrompt',
    'GIT_ACTION_DEFINITIONS',
    'GIT_ACTION_IDS',
    'actionTemplates',
    'gitConfig.globalGuidelines',
    'DEFAULT_GLOBAL_GIT_GUIDELINES',
  ];

  const hits: string[] = [];
  for (const relativePath of scannedFiles) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const pattern of patterns) {
      if (source.includes(pattern)) {
        hits.push(`${relativePath}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(hits, [], `unexpected references:\n${hits.join('\n')}`);
});
