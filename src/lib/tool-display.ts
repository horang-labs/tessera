import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';
import type { ShellCommandDisplay, ToolDisplayMetadata } from '@/types/tool-display';

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return value.slice(1, -1);
  }
  return value;
}

function unwrapShellLauncher(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\S*\/)?(?:ba|z|c|fi)?sh\s+-lc\s+([\s\S]+)$/);
  if (!match) return trimmed;
  return stripMatchingQuotes(match[1].trim());
}

function splitDisplayCommand(displayCommand: string): Pick<ShellCommandDisplay, 'commandName' | 'argumentsText'> {
  const trimmed = displayCommand.trim();
  if (!trimmed) return {};

  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { commandName: trimmed };
  }

  return {
    commandName: trimmed.slice(0, firstSpace),
    argumentsText: trimmed.slice(firstSpace).trim() || undefined,
  };
}

export function buildToolDisplay(
  toolName: string,
  toolKind: ToolCallKind | undefined,
  toolParams: Record<string, any>,
): ToolDisplayMetadata | undefined {
  const effectiveKind = toolKind ?? inferToolCallKindFromToolName(toolName);
  if (effectiveKind !== 'shell_command') return undefined;

  const rawCommand = toOptionalString(toolParams.command);
  const commandActions = Array.isArray(toolParams.commandActions)
    ? toolParams.commandActions
    : [];
  const actionCommand = commandActions.find(
    (action): action is { command: string } =>
      !!action && typeof action === 'object' && typeof action.command === 'string' && action.command.length > 0,
  )?.command;

  const displayCommand = actionCommand
    ?? (rawCommand ? unwrapShellLauncher(rawCommand) : undefined)
    ?? rawCommand;

  if (!displayCommand) return undefined;

  return {
    shellCommand: {
      displayCommand,
      ...splitDisplayCommand(displayCommand),
      ...(toOptionalString(toolParams.cwd) ? { cwd: toolParams.cwd } : {}),
      ...(rawCommand ? { rawCommand } : {}),
      ...(toOptionalString(toolParams.processId) ? { processId: toolParams.processId } : {}),
    },
  };
}
