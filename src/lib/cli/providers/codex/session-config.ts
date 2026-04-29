import path from 'path';
import type { PermissionMode } from '@/lib/ws/message-types';
import type { CodexApprovalPolicy, CodexSandboxMode } from '@/lib/session/session-control-types';

export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexSandboxPolicy {
  type: 'dangerFullAccess' | 'readOnly' | 'workspaceWrite';
  access?: { type: 'fullAccess' };
  writableRoots?: string[];
  readOnlyAccess?: { type: 'fullAccess' };
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface CodexPermissionMapping {
  sharedMode: PermissionMode;
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
  sandboxPolicy: CodexSandboxPolicy;
  mappedLabel: string;
  isExact: boolean;
  note?: string;
}

const DEFAULT_NETWORK_ACCESS = false;

const CODEX_PERMISSION_MAPPINGS: Record<
  PermissionMode,
  Omit<CodexPermissionMapping, 'sharedMode' | 'sandboxPolicy'>
> = {
  default: {
    approvalPolicy: 'untrusted',
    sandboxMode: 'workspace-write',
    mappedLabel: 'untrusted + workspace-write',
    isExact: false,
    note: 'Closest Codex match. Claude risk-based approvals do not map 1:1 to Codex approvalPolicy + sandbox.',
  },
  acceptEdits: {
    approvalPolicy: 'on-failure',
    sandboxMode: 'workspace-write',
    mappedLabel: 'on-failure + workspace-write',
    isExact: false,
    note: 'Closest Codex match. Codex does not expose a global "auto-approve only file edits" mode.',
  },
  plan: {
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    mappedLabel: 'never + read-only',
    isExact: false,
    note: 'Approximated via a read-only sandbox. This preserves no-write behavior rather than Claude-specific planning semantics.',
  },
  dontAsk: {
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    mappedLabel: 'never + workspace-write',
    isExact: false,
    note: 'Closest Codex match. Escalations are blocked without prompting, but in-sandbox actions may still run.',
  },
  bypassPermissions: {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    mappedLabel: 'never + danger-full-access',
    isExact: false,
    note: 'Closest Codex match to bypassing prompts. This is broader than Claude bypass permissions because it also removes sandboxing.',
  },
};

export function buildCodexSandboxPolicy(
  sandboxMode: CodexSandboxMode,
  cwd: string,
): CodexSandboxPolicy {
  if (sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (sandboxMode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: DEFAULT_NETWORK_ACCESS,
    };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [resolveAbsolutePathForCodex(cwd)],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: DEFAULT_NETWORK_ACCESS,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function resolveAbsolutePathForCodex(cwd: string): string {
  if (cwd.startsWith('/')) {
    return path.posix.resolve(cwd);
  }

  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('//')) {
    return path.win32.resolve(cwd.replace(/\//g, '\\'));
  }

  return path.resolve(cwd);
}

export function getCodexPermissionMapping(
  sharedMode: PermissionMode | string | undefined = 'default',
  cwd: string = process.cwd(),
): CodexPermissionMapping {
  const normalizedMode = (
    sharedMode && sharedMode in CODEX_PERMISSION_MAPPINGS
      ? sharedMode
      : 'default'
  ) as PermissionMode;
  const mapping = CODEX_PERMISSION_MAPPINGS[normalizedMode] ?? CODEX_PERMISSION_MAPPINGS.default;

  return {
    sharedMode: normalizedMode,
    ...mapping,
    sandboxPolicy: buildCodexSandboxPolicy(mapping.sandboxMode, cwd),
  };
}

export function listCodexPermissionMappings(
  cwd: string = process.cwd(),
): CodexPermissionMapping[] {
  return (Object.keys(CODEX_PERMISSION_MAPPINGS) as PermissionMode[]).map((mode) =>
    getCodexPermissionMapping(mode, cwd)
  );
}
