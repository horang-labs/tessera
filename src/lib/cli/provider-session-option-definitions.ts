import type { PermissionMode } from '@/lib/ws/message-types';
import { getCodexPermissionMapping, listCodexPermissionMappings } from './providers/codex/session-config';
import type {
  ProviderModelOption,
  ProviderPermissionMapping,
  ProviderReasoningEffortOption,
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

const CLAUDE_EFFORT_COMMON: ProviderReasoningEffortOption[] = [
  { value: 'auto', label: 'Auto', description: 'CLI default (no --effort flag)' },
  { value: 'low', label: 'Low', description: 'Faster responses with less thinking' },
  { value: 'medium', label: 'Medium', description: 'Balanced thinking and speed' },
  { value: 'high', label: 'High', description: 'Deeper reasoning' },
];

const CLAUDE_EFFORT_WITH_MAX: ProviderReasoningEffortOption[] = [
  ...CLAUDE_EFFORT_COMMON,
  { value: 'max', label: 'Max', description: 'Maximum reasoning depth' },
];

const CLAUDE_EFFORT_WITH_XHIGH_MAX: ProviderReasoningEffortOption[] = [
  ...CLAUDE_EFFORT_COMMON,
  { value: 'xhigh', label: 'Extra High', description: 'Deeper reasoning, just below maximum (Opus 4.7 only)' },
  { value: 'max', label: 'Max', description: 'Maximum reasoning depth' },
];

export const CLAUDE_MODELS: ProviderModelOption[] = [
  {
    value: 'claude-opus-4-7',
    label: 'claude-opus-4-7',
    isDefault: false,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_XHIGH_MAX,
  },
  {
    value: 'claude-opus-4-7[1m]',
    label: 'claude-opus-4-7[1m]',
    isDefault: true,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_XHIGH_MAX,
  },
  {
    value: 'claude-opus-4-6',
    label: 'claude-opus-4-6',
    isDefault: false,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_MAX,
  },
  {
    value: 'claude-opus-4-6[1m]',
    label: 'claude-opus-4-6[1m]',
    isDefault: false,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_MAX,
  },
  {
    value: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
    isDefault: false,
    defaultReasoningEffort: 'auto',
    supportedReasoningEfforts: CLAUDE_EFFORT_WITH_MAX,
  },
  {
    value: 'claude-haiku-4-5-20251001',
    label: 'claude-haiku-4-5-20251001',
    isDefault: false,
    supportedReasoningEfforts: [],
  },
];

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
    runtimeEffortChange: false,
    runtimeAccessChange: true,
    modelOptions: CLAUDE_MODELS,
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
