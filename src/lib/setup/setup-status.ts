import '@/lib/cli/providers/bootstrap';
import { checkAllCliStatuses, type CliStatusEntry } from '@/lib/cli/connection-checker';
import { execCli, isRunningInWsl, type CliEnvironment, type ExecResult } from '@/lib/cli/cli-exec';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import type {
  CliCommandShape,
  CliCommandSource,
  CliDetectionReason,
  CliProbeSummary,
} from '@/lib/cli/providers/provider-contract';
import type { AgentEnvironment, UserSettings } from '@/lib/settings/types';

export type SetupToolStatus = 'ready' | 'missing' | 'needs_login' | 'needs_config';

export type SetupReasonCode =
  | 'ai_cli_missing'
  | 'ai_cli_needs_login'
  | 'git_missing'
  | 'git_identity_missing'
  | 'gh_missing'
  | 'gh_needs_login';

export interface SetupProviderState {
  providerId: string;
  displayName: string;
  status: 'connected' | 'needs_login' | 'not_installed';
  version?: string;
  detectionReason?: CliDetectionReason;
  commandSource?: CliCommandSource;
  commandShape?: CliCommandShape;
  versionProbe?: CliProbeSummary;
  authProbe?: CliProbeSummary;
}

export interface SetupToolState {
  status: SetupToolStatus;
  reasonCode: SetupReasonCode | null;
  message: string;
  version?: string;
  installUrl?: string;
  loginCommand?: string;
}

export interface SetupEnvironmentState {
  aiCli: SetupToolState;
  git: SetupToolState;
  gh: SetupToolState;
  providers: SetupProviderState[];
}

export interface SetupEnvironmentSuggestion {
  tool: 'aiCli' | 'git' | 'gh';
  activeEnvironment: CliEnvironment;
  availableEnvironment: CliEnvironment;
}

export interface SetupStatusResponse {
  activeEnvironment: AgentEnvironment;
  availableEnvironments: CliEnvironment[];
  isWindowsEcosystem: boolean;
  summary: SetupEnvironmentState;
  environments: Partial<Record<CliEnvironment, SetupEnvironmentState>>;
  suggestions: SetupEnvironmentSuggestion[];
  isFullyReady: boolean;
  canUseCoreFeatures: boolean;
  installLinks: {
    claudeCode: string;
    codex: string;
    opencode: string;
    git: string;
    gh: string;
  };
}

interface BuildSetupStatusOptions {
  exec?: typeof execCli;
  checkCliStatuses?: typeof checkAllCliStatuses;
  userId?: string;
}

export const SETUP_INSTALL_LINKS = {
  claudeCode: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://opencode.ai/docs/cli/',
  git: 'https://git-scm.com/downloads',
  gh: 'https://cli.github.com/',
} as const;

export function getSetupEnvironments(): CliEnvironment[] {
  const isWindowsEcosystem = process.platform === 'win32' || isRunningInWsl();
  return isWindowsEcosystem ? ['native', 'wsl'] : ['native'];
}

export function normalizeSetupEnvironment(
  preferred: AgentEnvironment,
  availableEnvironments: CliEnvironment[],
): AgentEnvironment {
  if (preferred === 'wsl' && availableEnvironments.includes('wsl')) {
    return 'wsl';
  }
  return 'native';
}

export async function buildSetupStatus(
  settings: Pick<UserSettings, 'agentEnvironment'>,
  options: BuildSetupStatusOptions = {},
): Promise<SetupStatusResponse> {
  const run = options.exec ?? execCli;
  const checkStatuses = options.checkCliStatuses ?? checkAllCliStatuses;
  const availableEnvironments = getSetupEnvironments();
  const activeEnvironment = normalizeSetupEnvironment(
    settings.agentEnvironment,
    availableEnvironments,
  );

  const [cliStatuses, probedTools] = await Promise.all([
    checkStatuses({ userId: options.userId }),
    Promise.all(
      availableEnvironments.map(async (environment) => ({
        environment,
        git: await checkGit(run, environment),
        gh: await checkGh(run, environment),
      })),
    ),
  ]);

  const environments: Partial<Record<CliEnvironment, SetupEnvironmentState>> = {};
  for (const environment of availableEnvironments) {
    const providers = buildProviderStates(cliStatuses, environment);
    const tools = probedTools.find((entry) => entry.environment === environment);
    environments[environment] = {
      aiCli: summarizeAiCli(providers),
      git: tools?.git ?? missingGitState(),
      gh: tools?.gh ?? missingGhState(),
      providers,
    };
  }

  const summary = environments[activeEnvironment] ?? environments.native;
  if (!summary) {
    throw new Error('No setup environment summary was produced.');
  }

  return {
    activeEnvironment,
    availableEnvironments,
    isWindowsEcosystem: availableEnvironments.includes('wsl'),
    summary,
    environments,
    suggestions: buildSuggestions(activeEnvironment, environments),
    isFullyReady:
      summary.aiCli.status === 'ready'
      && summary.git.status === 'ready'
      && summary.gh.status === 'ready',
    canUseCoreFeatures: summary.aiCli.status === 'ready',
    installLinks: SETUP_INSTALL_LINKS,
  };
}

function buildProviderStates(
  cliStatuses: CliStatusEntry[],
  environment: CliEnvironment,
): SetupProviderState[] {
  return cliStatuses
    .filter((entry) => entry.environment === environment)
    .map((entry) => ({
      providerId: entry.providerId,
      displayName: cliProviderRegistry.getProvider(entry.providerId)?.getDisplayName?.()
        ?? entry.providerId,
      status: entry.status,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.detectionReason ? { detectionReason: entry.detectionReason } : {}),
      ...(entry.commandSource ? { commandSource: entry.commandSource } : {}),
      ...(entry.commandShape ? { commandShape: entry.commandShape } : {}),
      ...(entry.versionProbe ? { versionProbe: entry.versionProbe } : {}),
      ...(entry.authProbe ? { authProbe: entry.authProbe } : {}),
    }));
}

function summarizeAiCli(providers: SetupProviderState[]): SetupToolState {
  const connected = providers.filter((provider) => provider.status === 'connected');
  if (connected.length > 0) {
    return {
      status: 'ready',
      reasonCode: null,
      message: `${connected.map((provider) => provider.displayName).join(', ')} ready.`,
      version: connected[0]?.version,
    };
  }

  const needsLogin = providers.filter((provider) => provider.status === 'needs_login');
  if (needsLogin.length > 0) {
    return {
      status: 'needs_login',
      reasonCode: 'ai_cli_needs_login',
      message: `${needsLogin.map((provider) => provider.displayName).join(', ')} needs login.`,
    };
  }

  return {
    status: 'missing',
    reasonCode: 'ai_cli_missing',
    message: 'Install Claude Code, Codex, or OpenCode to create chat and task sessions.',
    installUrl: SETUP_INSTALL_LINKS.claudeCode,
  };
}

async function checkGit(
  run: typeof execCli,
  environment: CliEnvironment,
): Promise<SetupToolState> {
  const version = await run('git', ['--version'], environment, 5000);
  if (!version.ok) {
    return missingGitState();
  }

  const [name, email] = await Promise.all([
    run('git', ['config', '--global', 'user.name'], environment, 5000),
    run('git', ['config', '--global', 'user.email'], environment, 5000),
  ]);

  if (!name.stdout.trim() || !email.stdout.trim()) {
    return {
      status: 'needs_config',
      reasonCode: 'git_identity_missing',
      message: 'Git is installed, but commit identity is not configured.',
      version: normalizeVersionOutput(version),
    };
  }

  return {
    status: 'ready',
    reasonCode: null,
    message: 'Git is ready for managed worktrees.',
    version: normalizeVersionOutput(version),
  };
}

async function checkGh(
  run: typeof execCli,
  environment: CliEnvironment,
): Promise<SetupToolState> {
  const version = await run('gh', ['--version'], environment, 5000);
  if (!version.ok) {
    return missingGhState();
  }

  const auth = await run('gh', ['auth', 'status'], environment, 5000);
  if (!auth.ok) {
    return {
      status: 'needs_login',
      reasonCode: 'gh_needs_login',
      message: 'GitHub CLI is installed, but it is not logged in.',
      version: normalizeVersionOutput(version),
      loginCommand: 'gh auth login',
    };
  }

  return {
    status: 'ready',
    reasonCode: null,
    message: 'GitHub CLI is ready for pull requests.',
    version: normalizeVersionOutput(version),
  };
}

function missingGitState(): SetupToolState {
  return {
    status: 'missing',
    reasonCode: 'git_missing',
    message: 'Git is required to create managed worktrees.',
    installUrl: SETUP_INSTALL_LINKS.git,
  };
}

function missingGhState(): SetupToolState {
  return {
    status: 'missing',
    reasonCode: 'gh_missing',
    message: 'GitHub CLI is needed to create and merge pull requests.',
    installUrl: SETUP_INSTALL_LINKS.gh,
  };
}

function normalizeVersionOutput(result: ExecResult): string | undefined {
  return result.stdout.trim().split('\n')[0]?.trim() || undefined;
}

function buildSuggestions(
  activeEnvironment: CliEnvironment,
  environments: Partial<Record<CliEnvironment, SetupEnvironmentState>>,
): SetupEnvironmentSuggestion[] {
  const active = environments[activeEnvironment];
  const otherEnvironment = activeEnvironment === 'native' ? 'wsl' : 'native';
  const other = environments[otherEnvironment];
  if (!active || !other) return [];

  const suggestions: SetupEnvironmentSuggestion[] = [];
  for (const tool of ['aiCli', 'git', 'gh'] as const) {
    if (active[tool].status === 'ready') continue;
    if (other[tool].status !== 'ready') continue;
    suggestions.push({
      tool,
      activeEnvironment,
      availableEnvironment: otherEnvironment,
    });
  }
  return suggestions;
}
