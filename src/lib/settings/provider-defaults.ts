import type { GitActionId } from '@/lib/git/action-templates';
import type { PermissionMode } from '@/lib/ws/message-types';
import type {
  CodexApprovalPolicy,
  CodexCollaborationMode,
  CodexSandboxMode,
  ProviderRuntimeControls,
  ProviderSessionAccessMode,
  ProviderSessionMode,
} from '@/lib/session/session-control-types';
import type { UserSettings, ProviderSessionDefaults } from './types';
import {
  DEFAULT_PROFILE_AVATAR_DATA_URL,
  DEFAULT_PROFILE_DISPLAY_NAME,
} from './profile-defaults';

export const FONT_SCALE_OPTIONS = [0.8125, 0.875, 0.9375, 1] as const;
export const DEFAULT_FONT_SCALE = 0.875;
type ClaudeAccessMode = Extract<
  ProviderSessionAccessMode,
  'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions'
>;
type CodexAccessMode = Extract<
  ProviderSessionAccessMode,
  'readOnly' | 'ask' | 'auto' | 'fullAccess'
>;

/**
 * Normalize fontSize to one of FONT_SCALE_OPTIONS. Legacy px values (12-20)
 * from prior versions collapse to 1 since the old setting never actually took
 * effect — users experienced the default size regardless of the stored number.
 */
export function normalizeFontScale(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_FONT_SCALE;
  }
  if (raw >= 2) {
    return DEFAULT_FONT_SCALE;
  }
  let best: number = FONT_SCALE_OPTIONS[0];
  let bestDelta = Math.abs(raw - best);
  for (const option of FONT_SCALE_OPTIONS) {
    const delta = Math.abs(raw - option);
    if (delta < bestDelta) {
      best = option;
      bestDelta = delta;
    }
  }
  return best;
}

export const DEFAULT_GLOBAL_GIT_GUIDELINES = '';

export function normalizeClaudeModel(model?: string): string | undefined {
  if (!model) {
    return model;
  }

  switch (model) {
    case 'opus':
      return 'claude-opus-4-7[1m]';
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    default:
      return model;
  }
}

export function getProviderSessionDefaults(
  settings: Pick<UserSettings, 'providerDefaults' | 'defaultModel' | 'defaultPermissionMode'>,
  providerId: string,
): ProviderSessionDefaults {
  const providerDefaults = settings.providerDefaults?.[providerId];
  const model = providerDefaults?.model
    ?? (providerId === 'claude-code' ? normalizeClaudeModel(settings.defaultModel) : undefined);
  const fallbackControls = buildLegacySessionControls(providerId, settings.defaultPermissionMode);
  const sessionMode = normalizeSessionMode(providerDefaults?.sessionMode)
    ?? fallbackControls.sessionMode;
  const accessMode = normalizeAccessMode(providerId, providerDefaults?.accessMode)
    ?? fallbackControls.accessMode;

  return {
    model,
    reasoningEffort: providerDefaults?.reasoningEffort ?? null,
    sessionMode,
    accessMode,
  };
}

export interface ProviderSessionRuntimeConfig extends ProviderRuntimeControls {
  permissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: string | null;
}

export function getProviderSessionRuntimeConfig(
  settings: Pick<UserSettings, 'providerDefaults' | 'defaultModel' | 'defaultPermissionMode'>,
  providerId: string,
): ProviderSessionRuntimeConfig {
  const defaults = getProviderSessionDefaults(settings, providerId);
  const permissionMode = resolveProviderPermissionMode(providerId, defaults);

  return {
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort ?? null,
    sessionMode: defaults.sessionMode,
    accessMode: defaults.accessMode,
    ...(permissionMode && { permissionMode }),
    ...resolveProviderRuntimeControls(providerId, defaults),
  };
}

export function resolveProviderPermissionMode(
  providerId: string,
  defaults: Pick<ProviderSessionDefaults, 'sessionMode' | 'accessMode'>,
): PermissionMode | undefined {
  if (providerId === 'codex') {
    return undefined;
  }

  if (defaults.sessionMode === 'plan') {
    return 'plan';
  }

  return normalizeClaudeAccessMode(defaults.accessMode) ?? 'default';
}

export function resolveProviderRuntimeControls(
  providerId: string,
  defaults: Pick<ProviderSessionDefaults, 'sessionMode' | 'accessMode'>,
): ProviderRuntimeControls {
  if (providerId !== 'codex') {
    return {};
  }

  const collaborationMode: CodexCollaborationMode = defaults.sessionMode === 'plan'
    ? 'plan'
    : 'default';
  const accessMode = normalizeCodexAccessMode(defaults.accessMode) ?? 'ask';
  const accessConfig = CODEX_ACCESS_RUNTIME[accessMode];

  return {
    collaborationMode,
    approvalPolicy: accessConfig.approvalPolicy,
    sandboxMode: accessConfig.sandboxMode,
  };
}

function normalizeSessionMode(value: unknown): ProviderSessionMode | undefined {
  return value === 'work' || value === 'plan' ? value : undefined;
}

function normalizeAccessMode(
  providerId: string,
  value: unknown,
): ProviderSessionAccessMode | undefined {
  return providerId === 'codex'
    ? normalizeCodexAccessMode(value)
    : normalizeClaudeAccessMode(value);
}

function normalizeClaudeAccessMode(value: unknown): ClaudeAccessMode | undefined {
  switch (value) {
    case 'default':
    case 'acceptEdits':
    case 'dontAsk':
    case 'bypassPermissions':
      return value;
    default:
      return undefined;
  }
}

function normalizeCodexAccessMode(value: unknown): CodexAccessMode | undefined {
  switch (value) {
    case 'readOnly':
    case 'ask':
    case 'auto':
    case 'fullAccess':
      return value;
    default:
      return undefined;
  }
}

function buildLegacySessionControls(
  providerId: string,
  permissionMode: PermissionMode,
): Required<Pick<ProviderSessionDefaults, 'sessionMode' | 'accessMode'>> {
  if (providerId === 'codex') {
    switch (permissionMode) {
      case 'plan':
        return { sessionMode: 'plan', accessMode: 'readOnly' };
      case 'bypassPermissions':
        return { sessionMode: 'work', accessMode: 'fullAccess' };
      case 'acceptEdits':
      case 'dontAsk':
        return { sessionMode: 'work', accessMode: 'auto' };
      case 'default':
      default:
        return { sessionMode: 'work', accessMode: 'ask' };
    }
  }

  if (permissionMode === 'plan') {
    return { sessionMode: 'plan', accessMode: 'default' };
  }

  return {
    sessionMode: 'work',
    accessMode: normalizeClaudeAccessMode(permissionMode) ?? 'default',
  };
}

const CODEX_ACCESS_RUNTIME: Record<
  CodexAccessMode,
  { approvalPolicy: CodexApprovalPolicy; sandboxMode: CodexSandboxMode }
> = {
  readOnly: { approvalPolicy: 'never', sandboxMode: 'read-only' },
  ask: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  auto: { approvalPolicy: 'never', sandboxMode: 'workspace-write' },
  fullAccess: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
};

export function buildProviderSessionDefaultsUpdate(
  settings: Pick<UserSettings, 'providerDefaults' | 'defaultModel'>,
  providerId: string,
  patch: Partial<ProviderSessionDefaults>,
): Partial<UserSettings> {
  const nextProviderDefaults = {
    ...settings.providerDefaults,
    [providerId]: {
      ...settings.providerDefaults?.[providerId],
      ...patch,
    },
  };

  if (!nextProviderDefaults[providerId].model && patch.model !== undefined) {
    delete nextProviderDefaults[providerId].model;
  }

  const nextClaudeModel =
    providerId === 'claude-code' && patch.model !== undefined
      ? normalizeClaudeModel(patch.model) || settings.defaultModel
      : settings.defaultModel;

  return {
    providerDefaults: nextProviderDefaults,
    defaultModel: nextClaudeModel,
  };
}

export function normalizeUserSettings(raw: Partial<UserSettings> | null | undefined): UserSettings {
  const retentionDays =
    typeof raw?.archivedWorktreeRetentionDays === 'number'
    && Number.isFinite(raw.archivedWorktreeRetentionDays)
      ? Math.min(365, Math.max(1, Math.floor(raw.archivedWorktreeRetentionDays)))
      : undefined;
  const defaults = {
    language: 'en',
    profile: {
      displayName: DEFAULT_PROFILE_DISPLAY_NAME,
      avatarDataUrl: DEFAULT_PROFILE_AVATAR_DATA_URL,
    },
    notifications: {
      soundEnabled: true,
      showToast: true,
      autoGenerateTitle: true,
    },
    theme: 'auto',
    fontSize: DEFAULT_FONT_SCALE,
    enterKeyBehavior: 'send',
    defaultPermissionMode: 'default',
    defaultModel: 'claude-opus-4-7[1m]',
    providerDefaults: {
      'claude-code': {
        model: 'claude-opus-4-7[1m]',
        reasoningEffort: null,
        sessionMode: 'work',
        accessMode: 'default',
      },
      codex: {
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
        sessionMode: 'work',
        accessMode: 'ask',
      },
    },
    inactivePanelDimming: 30,
    sttEngine: 'webSpeech',
    geminiApiKey: '',
    favoriteSkills: [],
    agentEnvironment: 'native',
    setup: {
      dismissedAt: null,
      completedAt: null,
    },
    autoDeleteArchivedWorktrees: true,
    archivedWorktreeRetentionDays: 7,
    shortcutOverrides: {},
    gitConfig: {
      branchPrefix: '',
      globalGuidelines: DEFAULT_GLOBAL_GIT_GUIDELINES,
      actionTemplates: {},
    },
    version: '1.0.0',
    lastModified: new Date().toISOString(),
  } satisfies UserSettings;

  const normalizedClaudeModel = normalizeClaudeModel(raw?.defaultModel) || defaults.defaultModel;
  const providerDefaults = {
    ...defaults.providerDefaults,
    ...(raw?.providerDefaults ?? {}),
    'claude-code': {
      ...defaults.providerDefaults['claude-code'],
      ...(raw?.providerDefaults?.['claude-code'] ?? {}),
      model: normalizeClaudeModel(raw?.providerDefaults?.['claude-code']?.model) || normalizedClaudeModel,
    },
  };
  const rawGitConfig = raw?.gitConfig as
    | (Partial<UserSettings['gitConfig']> & {
        commitGuidelines?: unknown;
        prGuidelines?: unknown;
        prMergeMethod?: unknown;
        showSidebarPrIcon?: unknown;
        alwaysForceWithLease?: unknown;
        createDraftPr?: unknown;
      })
    | undefined;

  return {
    ...defaults,
    ...raw,
    defaultModel: normalizedClaudeModel,
    fontSize: normalizeFontScale(raw?.fontSize),
    archivedWorktreeRetentionDays: retentionDays ?? defaults.archivedWorktreeRetentionDays,
    profile: normalizeProfileSettings(raw?.profile, defaults.profile),
    notifications: {
      ...defaults.notifications,
      ...(raw?.notifications ?? {}),
    },
    providerDefaults,
    setup: {
      ...defaults.setup,
      ...(raw?.setup ?? {}),
    },
    shortcutOverrides: raw?.shortcutOverrides ?? {},
    gitConfig: normalizeGitConfig(rawGitConfig, defaults.gitConfig),
    lastModified: raw?.lastModified || defaults.lastModified,
  };
}

function normalizeProfileSettings(
  rawProfile: Partial<UserSettings['profile']> | undefined,
  defaults: UserSettings['profile'],
): UserSettings['profile'] {
  const sanitizedDisplayName =
    typeof rawProfile?.displayName === 'string'
      ? rawProfile.displayName.replace(/[\r\n\t]/g, ' ').slice(0, 80).trim()
      : '';
  const displayName =
    sanitizedDisplayName.length > 0 ? sanitizedDisplayName : defaults.displayName;
  const avatarDataUrl =
    typeof rawProfile?.avatarDataUrl === 'string' && rawProfile.avatarDataUrl.startsWith('data:image/')
      ? rawProfile.avatarDataUrl
      : defaults.avatarDataUrl;

  return {
    displayName,
    avatarDataUrl,
  };
}

function normalizeGitConfig(
  rawGitConfig:
    | (Partial<UserSettings['gitConfig']> & {
        commitGuidelines?: unknown;
        prGuidelines?: unknown;
        prMergeMethod?: unknown;
        showSidebarPrIcon?: unknown;
        alwaysForceWithLease?: unknown;
        createDraftPr?: unknown;
      })
    | undefined,
  defaults: UserSettings['gitConfig'],
): UserSettings['gitConfig'] {
  // Strip legacy fields that are no longer part of GitConfig before spreading,
  // otherwise old settings.json values leak into the typed result at runtime.
  const cleaned: Partial<UserSettings['gitConfig']> = {};
  if (rawGitConfig) {
    for (const [key, value] of Object.entries(rawGitConfig)) {
      if (
        key === 'commitGuidelines'
        || key === 'prGuidelines'
        || key === 'prMergeMethod'
        || key === 'showSidebarPrIcon'
        || key === 'alwaysForceWithLease'
        || key === 'createDraftPr'
      ) {
        continue;
      }
      (cleaned as Record<string, unknown>)[key] = value;
    }
  }

  const merged: UserSettings['gitConfig'] = {
    ...defaults,
    ...cleaned,
    globalGuidelines:
      typeof rawGitConfig?.globalGuidelines === 'string'
        ? rawGitConfig.globalGuidelines
        : defaults.globalGuidelines,
    actionTemplates: {
      ...defaults.actionTemplates,
      ...(rawGitConfig?.actionTemplates ?? {}),
    },
  };

  // Migrate legacy commitGuidelines / prGuidelines fields. Only legacy values
  // that diverge from the prior default are kept — old defaults are dropped so
  // the user picks up the new templates automatically.
  const legacyCommit =
    typeof rawGitConfig?.commitGuidelines === 'string'
      ? rawGitConfig.commitGuidelines.trim()
      : '';
  const legacyPr =
    typeof rawGitConfig?.prGuidelines === 'string'
      ? rawGitConfig.prGuidelines.trim()
      : '';
  const LEGACY_DEFAULT_COMMIT =
    'Review the current git diff and create an appropriate commit message, then commit all changes. Run `git add -A` first if needed.';
  const LEGACY_DEFAULT_PR = [
    'Create a GitHub Pull Request for the current branch targeting the selected base branch.',
    'If there are uncommitted changes, commit them first with an appropriate message.',
    'If the branch has not been pushed yet, push it with `git push -u origin HEAD`.',
    'Generate a good title and description based on the commits.',
  ].join(' ');

  const actionTemplates: Partial<Record<GitActionId, string>> = {
    ...merged.actionTemplates,
  };

  if (
    legacyCommit
    && legacyCommit !== LEGACY_DEFAULT_COMMIT
    && actionTemplates.commit === undefined
  ) {
    actionTemplates.commit = legacyCommit;
  }
  if (
    legacyPr
    && legacyPr !== LEGACY_DEFAULT_PR
    && actionTemplates.createPr === undefined
  ) {
    actionTemplates.createPr = legacyPr;
  }
  if (typeof actionTemplates.createPr === 'string') {
    const normalizedCreatePrTemplate = actionTemplates.createPr
      .replace(/[ \t]*\{\{draftFlag\}\}/g, '')
      .replace(/[ \t]+$/gm, '');
    if (normalizedCreatePrTemplate.trim()) {
      actionTemplates.createPr = normalizedCreatePrTemplate;
    } else {
      delete actionTemplates.createPr;
    }
  }

  return {
    ...merged,
    actionTemplates,
  };
}
