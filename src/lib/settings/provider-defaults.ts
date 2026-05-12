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
import type {
  ProviderModelOption,
  ProviderSessionOptions,
} from '@/lib/cli/provider-session-option-types';
import {
  normalizeOpenCodeAccessMode,
  splitOpenCodeModelId,
} from '@/lib/cli/providers/opencode/session-config';
import type { UserSettings, ProviderSessionDefaults } from './types';
import { normalizeCliCommandOverrides } from './cli-command-overrides';
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
type OpenCodeAccessMode = Extract<
  ProviderSessionAccessMode,
  'opencodeDefault' | 'opencodeAskChanges' | 'opencodeReadOnly' | 'opencodeAllowAll'
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
  let model = providerDefaults?.model
    ?? (providerId === 'claude-code' ? normalizeClaudeModel(settings.defaultModel) : undefined);
  let reasoningEffort = providerDefaults?.reasoningEffort ?? null;
  if (providerId === 'opencode' && model) {
    const selection = splitOpenCodeModelId(model);
    model = selection.baseModelId;
    reasoningEffort = providerDefaults?.reasoningEffort ?? selection.reasoningEffort ?? null;
  }
  const fallbackControls = buildLegacySessionControls(providerId, settings.defaultPermissionMode);
  const sessionMode = normalizeProviderSessionMode(providerId, providerDefaults?.sessionMode)
    ?? fallbackControls.sessionMode;
  const accessMode = normalizeAccessMode(providerId, providerDefaults?.accessMode)
    ?? fallbackControls.accessMode;

  return {
    model,
    reasoningEffort,
    sessionMode,
    accessMode,
  };
}

export function getProviderSessionDefaultsWithOptions(
  settings: Pick<UserSettings, 'providerDefaults' | 'defaultModel' | 'defaultPermissionMode'>,
  providerId: string,
  sessionOptions: ProviderSessionOptions | null | undefined,
): ProviderSessionDefaults {
  const defaults = getProviderSessionDefaults(settings, providerId);
  const modelOption = resolveProviderModelOption(
    providerId,
    sessionOptions,
    defaults.model,
  );

  if (!modelOption) {
    return defaults;
  }

  return {
    ...defaults,
    model: modelOption.value,
    reasoningEffort: resolveProviderReasoningEffort(
      providerId,
      sessionOptions,
      modelOption,
      defaults.reasoningEffort,
    ),
  };
}

export function resolveProviderModelOption(
  providerId: string,
  sessionOptions: ProviderSessionOptions | null | undefined,
  requestedModel?: string,
): ProviderModelOption | null {
  if (!sessionOptions || sessionOptions.providerId !== providerId) {
    return null;
  }

  if (requestedModel) {
    const normalizedRequestedModel = providerId === 'opencode'
      ? splitOpenCodeModelId(requestedModel).baseModelId
      : requestedModel;
    const selected = sessionOptions.modelOptions.find((option) => option.value === normalizedRequestedModel);
    if (selected) {
      return selected;
    }
  }

  if (providerId === 'codex') {
    return sessionOptions.modelOptions[0] ?? null;
  }

  return sessionOptions.modelOptions.find((option) => option.isDefault)
    ?? sessionOptions.modelOptions[0]
    ?? null;
}

export function getProviderReasoningEffortFallback(
  providerId: string,
  modelOption: ProviderModelOption | null | undefined,
): string | null {
  if (!modelOption) {
    return null;
  }

  const reasoningOptions = modelOption.supportedReasoningEfforts;
  if (reasoningOptions.length === 0) {
    return modelOption.defaultReasoningEffort ?? null;
  }

  if (providerId === 'codex') {
    return reasoningOptions[reasoningOptions.length - 1]?.value
      ?? modelOption.defaultReasoningEffort
      ?? null;
  }

  return modelOption.defaultReasoningEffort
    ?? reasoningOptions[0]?.value
    ?? null;
}

export function resolveProviderReasoningEffort(
  providerId: string,
  sessionOptions: ProviderSessionOptions | null | undefined,
  modelOption: ProviderModelOption | null | undefined,
  requestedReasoningEffort?: string | null,
): string | null {
  if (!sessionOptions?.supportsReasoningEffort) {
    return null;
  }

  const reasoningOptions = modelOption?.supportedReasoningEfforts ?? [];
  if (reasoningOptions.length === 0) {
    return requestedReasoningEffort
      ?? modelOption?.defaultReasoningEffort
      ?? null;
  }

  if (
    requestedReasoningEffort
    && reasoningOptions.some((option) => option.value === requestedReasoningEffort)
  ) {
    return requestedReasoningEffort;
  }

  return getProviderReasoningEffortFallback(providerId, modelOption);
}

export interface ProviderSessionRuntimeConfig extends ProviderRuntimeControls {
  permissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: string | null;
}

export function applyProviderSessionRuntimeOverrides(
  config: ProviderSessionRuntimeConfig,
  overrides: {
    model?: string;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
    sessionMode?: ProviderSessionMode;
    accessMode?: ProviderSessionAccessMode;
  } | null | undefined,
  providerId?: string,
): ProviderSessionRuntimeConfig {
  const sessionMode = overrides?.sessionMode ?? config.sessionMode;
  const accessMode = overrides?.accessMode ?? config.accessMode;
  const hasControlOverride = overrides?.sessionMode !== undefined || overrides?.accessMode !== undefined;
  const permissionMode = providerId && sessionMode && accessMode
    ? resolveProviderPermissionMode(providerId, { sessionMode, accessMode })
    : undefined;
  const controlPatch = hasControlOverride && sessionMode && accessMode
    ? {
        sessionMode,
        accessMode,
        ...(permissionMode && { permissionMode }),
        ...(providerId ? resolveProviderRuntimeControls(providerId, { sessionMode, accessMode }) : {}),
      }
    : {};

  return {
    ...config,
    ...(overrides?.model !== undefined && { model: overrides.model }),
    ...(overrides?.reasoningEffort !== undefined && { reasoningEffort: overrides.reasoningEffort }),
    ...(overrides?.serviceTier !== undefined && { serviceTier: overrides.serviceTier }),
    ...controlPatch,
  };
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
  if (providerId === 'codex' || providerId === 'opencode') {
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

function normalizeWindowsCloseBehavior(value: unknown): UserSettings['windowsCloseBehavior'] {
  return value === 'tray' || value === 'quit' ? value : 'ask';
}

function normalizeProviderSessionMode(
  providerId: string,
  value: unknown,
): ProviderSessionMode | undefined {
  if (providerId === 'opencode') {
    switch (value) {
      case 'build':
        return 'build';
      case 'work':
        return 'build';
      case 'plan':
        return 'plan';
      default:
        return undefined;
    }
  }

  return normalizeSessionMode(value);
}

function normalizeAccessMode(
  providerId: string,
  value: unknown,
): ProviderSessionAccessMode | undefined {
  if (providerId === 'codex') {
    return normalizeCodexAccessMode(value);
  }
  if (providerId === 'opencode') {
    return normalizeOpenCodeAccessMode(value);
  }
  return normalizeClaudeAccessMode(value);
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

function normalizeOpenCodeAccessModeForSettings(value: unknown): OpenCodeAccessMode | undefined {
  return normalizeOpenCodeAccessMode(value);
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

  if (providerId === 'opencode') {
    switch (permissionMode) {
      case 'plan':
        return { sessionMode: 'plan', accessMode: 'opencodeReadOnly' };
      case 'bypassPermissions':
        return { sessionMode: 'build', accessMode: 'opencodeAllowAll' };
      case 'acceptEdits':
      case 'dontAsk':
        return { sessionMode: 'build', accessMode: 'opencodeAskChanges' };
      case 'default':
      default:
        return { sessionMode: 'build', accessMode: 'opencodeDefault' };
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
        sessionMode: 'work',
        accessMode: 'ask',
      },
      opencode: {
        sessionMode: 'build',
        accessMode: 'opencodeDefault',
      },
    },
    inactivePanelDimming: 30,
    showProviderIcons: true,
    sttEngine: 'webSpeech',
    geminiApiKey: '',
    favoriteSkills: [],
    agentEnvironment: 'native',
    cliCommandOverrides: {},
    windowsCloseBehavior: 'ask',
    setup: {
      dismissedAt: null,
      completedAt: null,
    },
    telemetry: {
      enabled: true,
    },
    autoDeleteArchivedWorktrees: true,
    archivedWorktreeRetentionDays: 7,
    managedWorktreePathTemplate: '',
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
  const rawCodexProviderDefaults = raw?.providerDefaults?.codex ?? {};
  const rawOpenCodeProviderDefaults = raw?.providerDefaults?.opencode ?? {};
  const rawOpenCodeModelSelection = splitOpenCodeModelId(rawOpenCodeProviderDefaults.model);
  const rawOpenCodeReasoningEffort = rawOpenCodeProviderDefaults.reasoningEffort !== undefined
    ? rawOpenCodeProviderDefaults.reasoningEffort
    : rawOpenCodeModelSelection.reasoningEffort;
  const codexProviderDefaults = {
    ...defaults.providerDefaults.codex,
    ...rawCodexProviderDefaults,
  };
  if (
    rawCodexProviderDefaults.model === 'gpt-5.4'
    && (
      rawCodexProviderDefaults.reasoningEffort === 'medium'
      || rawCodexProviderDefaults.reasoningEffort == null
    )
  ) {
    delete codexProviderDefaults.model;
    delete codexProviderDefaults.reasoningEffort;
  }

  const providerDefaults = {
    ...defaults.providerDefaults,
    ...(raw?.providerDefaults ?? {}),
    'claude-code': {
      ...defaults.providerDefaults['claude-code'],
      ...(raw?.providerDefaults?.['claude-code'] ?? {}),
      model: normalizeClaudeModel(raw?.providerDefaults?.['claude-code']?.model) || normalizedClaudeModel,
    },
    codex: codexProviderDefaults,
    opencode: {
      ...defaults.providerDefaults.opencode,
      ...rawOpenCodeProviderDefaults,
      ...(rawOpenCodeModelSelection.baseModelId ? { model: rawOpenCodeModelSelection.baseModelId } : {}),
      ...(rawOpenCodeReasoningEffort !== undefined ? { reasoningEffort: rawOpenCodeReasoningEffort } : {}),
      accessMode: normalizeOpenCodeAccessModeForSettings(rawOpenCodeProviderDefaults.accessMode)
        ?? defaults.providerDefaults.opencode.accessMode,
      sessionMode: normalizeProviderSessionMode('opencode', rawOpenCodeProviderDefaults.sessionMode)
        ?? defaults.providerDefaults.opencode.sessionMode,
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
    showProviderIcons: raw?.showProviderIcons ?? defaults.showProviderIcons,
    cliCommandOverrides: normalizeCliCommandOverrides(raw?.cliCommandOverrides),
    archivedWorktreeRetentionDays: retentionDays ?? defaults.archivedWorktreeRetentionDays,
    managedWorktreePathTemplate: normalizeManagedWorktreePathTemplate(raw?.managedWorktreePathTemplate),
    windowsCloseBehavior: normalizeWindowsCloseBehavior(raw?.windowsCloseBehavior),
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
    telemetry: {
      ...defaults.telemetry,
      ...(raw?.telemetry ?? {}),
      enabled: raw?.telemetry?.enabled !== false,
    },
    shortcutOverrides: raw?.shortcutOverrides ?? {},
    gitConfig: normalizeGitConfig(rawGitConfig, defaults.gitConfig),
    lastModified: raw?.lastModified || defaults.lastModified,
  };
}

function normalizeManagedWorktreePathTemplate(rawTemplate: unknown): string {
  if (typeof rawTemplate !== 'string') {
    return '';
  }
  return rawTemplate.trim().slice(0, 1024);
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
