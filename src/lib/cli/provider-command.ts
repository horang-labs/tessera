import { SettingsManager } from '@/lib/settings/manager';
import type { AgentEnvironment, UserSettings } from '@/lib/settings/types';
import type { CliCommandShape, CliCommandSource, CliCommandTelemetry } from './providers/provider-contract';

export interface ResolvedProviderCliCommand extends CliCommandTelemetry {
  command: string;
}

export function getProviderCliCommandFromSettings(
  settings: Pick<UserSettings, 'cliCommandOverrides'>,
  providerId: string,
  environment: AgentEnvironment,
  fallbackCommand: string,
): string {
  return settings.cliCommandOverrides?.[providerId]?.[environment] || fallbackCommand;
}

export async function resolveProviderCliCommand(
  providerId: string,
  fallbackCommand: string,
  environment: AgentEnvironment,
  userId?: string,
): Promise<string> {
  const resolved = await resolveProviderCliCommandWithMetadata(
    providerId,
    fallbackCommand,
    environment,
    userId,
  );
  return resolved.command;
}

export async function resolveProviderCliCommandWithMetadata(
  providerId: string,
  fallbackCommand: string,
  environment: AgentEnvironment,
  userId?: string,
): Promise<ResolvedProviderCliCommand> {
  if (!userId) {
    return {
      command: fallbackCommand,
      commandSource: 'default',
      commandShape: getCommandShape(fallbackCommand),
    };
  }

  const settings = await SettingsManager.load(userId, { silent: true });
  const override = settings.cliCommandOverrides?.[providerId]?.[environment];
  const command = override || fallbackCommand;

  return {
    command,
    commandSource: override ? 'override' : 'default',
    commandShape: getCommandShape(command),
  };
}

function getCommandShape(command: string): CliCommandShape {
  const trimmed = command.trim();
  if (!trimmed) return 'other';
  if (isAbsoluteExecutablePath(trimmed)) return 'absolute_path';
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'relative_path';
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return 'bare_command';
  return 'other';
}

function isAbsoluteExecutablePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value);
}
