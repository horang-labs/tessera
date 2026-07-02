import type { PermissionMode } from '@/lib/ws/message-types';
import { getCodexPermissionMapping, listCodexPermissionMappings } from './providers/codex/session-config';
import { getClaudeModelOptions } from '../model-config/remote-config';
import type {
  ProviderPermissionMapping,
  ProviderSessionOptions,
} from './provider-session-option-types';

const PROVIDER_LABELS: Record<PermissionMode, { label: string; description: string }> = {
  default: {
    label: 'Default',
    description: 'Requires approval for risky actions',
  },
  acceptEdits: {
    label: 'Accept Edits',
    description: 'Auto-approve file edits',
  },
  plan: {
    label: 'Plan',
    description: 'No code changes (read-only)',
  },
  dontAsk: {
    label: "Don't Ask",
    description: 'Block without asking',
  },
  bypassPermissions: {
    label: 'YOLO',
    description: 'Auto-approve everything',
  },
};

export const SHARED_MODE_OPTIONS = [
  {
    value: 'work',
    label: 'Work',
    description: 'Implement, edit, and run tasks using the selected access level',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Research first and propose a plan before implementation',
  },
] as const;

export const CLAUDE_ACCESS_OPTIONS = [
  {
    value: 'default',
    label: 'Default',
    description: 'Ask before edits and risky commands',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Auto-approve file edits while still prompting for risky commands',
  },
  {
    value: 'dontAsk',
    label: "Don't Ask",
    description: 'Block unapproved actions without prompting',
  },
  {
    value: 'bypassPermissions',
    label: 'YOLO',
    description: 'Bypass prompts in isolated environments only',
  },
] as const;

export const CODEX_ACCESS_OPTIONS = [
  {
    value: 'readOnly',
    label: 'Read Only',
    description: 'Read and analyze without writes',
  },
  {
    value: 'ask',
    label: 'Ask',
    description: 'Ask before workspace writes and commands',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Run in the workspace without prompting',
  },
  {
    value: 'fullAccess',
    label: 'Full Access',
    description: 'Disable sandboxing for externally isolated environments',
  },
] as const;

export const OPENCODE_MODE_OPTIONS = [
  {
    value: 'build',
    label: 'Build',
    description: 'Use OpenCode build mode with the selected permission preset',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Use OpenCode plan mode for read-only analysis and planning',
  },
] as const;

export const OPENCODE_ACCESS_OPTIONS = [
  {
    value: 'opencodeDefault',
    label: 'Default',
    description: 'Use OpenCode config defaults',
  },
  {
    value: 'opencodeAskChanges',
    label: 'Ask Changes',
    description: 'Ask before shell commands, edits, todos, and risky loops',
  },
  {
    value: 'opencodeReadOnly',
    label: 'Read Only',
    description: 'Allow read/search context and deny changing tools',
  },
  {
    value: 'opencodeAllowAll',
    label: 'Allow All',
    description: 'Allow every OpenCode permission category',
  },
] as const;

// The Claude model list is served entirely by the remote config Worker (via
// getClaudeModelOptions()). No models, effort tiers, or defaults are hardcoded here.

export function buildSharedPermissionMapping(permissionMode: PermissionMode): ProviderPermissionMapping {
  return {
    value: permissionMode,
    label: PROVIDER_LABELS[permissionMode].label,
    description: PROVIDER_LABELS[permissionMode].description,
    isExact: true,
  };
}

export function buildClaudePermissionMappings(): ProviderPermissionMapping[] {
  return (Object.keys(PROVIDER_LABELS) as PermissionMode[]).map(buildSharedPermissionMapping);
}

export function buildClaudeSessionOptions(): ProviderSessionOptions {
  return {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    supportsReasoningEffort: true,
    // Live changes ride the apply_flag_settings control_request (the same
    // mechanism the CLI's own /effort command uses) — except `max`, which is
    // spawn-only (stamped requiresRestart in remote-config normalization).
    runtimeEffortChange: true,
    runtimeAccessChange: true,
    modelOptions: getClaudeModelOptions(),
    permissionMappings: buildClaudePermissionMappings(),
    modeOptions: [...SHARED_MODE_OPTIONS],
    accessOptions: [...CLAUDE_ACCESS_OPTIONS],
    planLocksAccess: true,
    planAccessLabel: 'Read-only planning',
  };
}

export function buildCodexPermissionMappings(): ProviderPermissionMapping[] {
  return listCodexPermissionMappings().map((mapping) => ({
    value: mapping.sharedMode,
    label: PROVIDER_LABELS[mapping.sharedMode].label,
    description: PROVIDER_LABELS[mapping.sharedMode].description,
    mappedLabel: mapping.mappedLabel,
    isExact: mapping.isExact,
    note: mapping.note,
  }));
}

export function buildCodexPermissionMapping(permissionMode: PermissionMode): ProviderPermissionMapping {
  const mapping = getCodexPermissionMapping(permissionMode);
  return {
    value: mapping.sharedMode,
    label: PROVIDER_LABELS[mapping.sharedMode].label,
    description: PROVIDER_LABELS[mapping.sharedMode].description,
    mappedLabel: mapping.mappedLabel,
    isExact: mapping.isExact,
    note: mapping.note,
  };
}
