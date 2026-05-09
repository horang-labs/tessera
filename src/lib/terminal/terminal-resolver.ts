import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVisibleProjects } from '@/lib/db/projects';
import { getSession } from '@/lib/db/sessions';
import type { TerminalCwdResolution, TerminalResolvedShell, TerminalShellKind } from './types';

export function resolveTerminalCwd(candidate?: string | null): string {
  if (candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Fall through to home directory.
    }
  }

  return os.homedir();
}

function resolveExistingDirectory(candidate: string): string | null {
  try {
    const resolved = path.resolve(candidate);
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate: string, allowedRoot: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(allowedRoot);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function resolveAllowedTerminalCwd(options: {
  cwd?: string | null;
  sessionId?: string | null;
}): TerminalCwdResolution {
  const requestedCwd = options.cwd?.trim();
  const allowedRoots = new Set<string>();

  for (const project of getVisibleProjects()) {
    allowedRoots.add(project.decoded_path);
  }

  if (options.sessionId) {
    const session = getSession(options.sessionId);
    if (session?.work_dir) {
      allowedRoots.add(session.work_dir);
    }
  }

  if (allowedRoots.size === 0) {
    return { ok: false, message: 'No project is available for terminal startup.' };
  }

  if (!requestedCwd) {
    for (const root of allowedRoots) {
      const existingRoot = resolveExistingDirectory(root);
      if (existingRoot) {
        return { ok: true, cwd: existingRoot };
      }
    }

    return { ok: false, message: 'No registered project directory exists on this server.' };
  }

  const resolvedCandidate = resolveExistingDirectory(requestedCwd);
  if (!resolvedCandidate) {
    return { ok: false, message: 'Terminal cwd does not exist or is not a directory.' };
  }

  for (const root of allowedRoots) {
    if (isSameOrChildPath(resolvedCandidate, root)) {
      return { ok: true, cwd: resolvedCandidate };
    }
  }

  return {
    ok: false,
    message: 'Terminal cwd must be inside a registered project or active worktree.',
  };
}

export function resolveTerminalShell(options: {
  cwd?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shellKind?: TerminalShellKind;
}): TerminalResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const shellKind = options.shellKind ?? 'default';
  const cwd = resolveTerminalCwd(options.cwd);

  if (shellKind === 'wsl') {
    throw new Error('WSL terminal profiles are not supported yet.');
  }

  if (platform === 'win32') {
    if (shellKind === 'cmd') {
      return { command: 'cmd.exe', args: [], cwd };
    }

    return {
      command: env.ComSpec?.toLowerCase().includes('powershell')
        ? env.ComSpec
        : 'powershell.exe',
      args: ['-NoLogo'],
      cwd,
    };
  }

  const command = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

  return { command, args: [], cwd };
}
