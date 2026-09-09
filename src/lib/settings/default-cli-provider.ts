export const DEFAULT_CLI_PROVIDER_IDS = [
  'claude-code',
  'codex',
  'opencode',
] as const;

export type DefaultCliProvider = (typeof DEFAULT_CLI_PROVIDER_IDS)[number];

export function isDefaultCliProvider(value: unknown): value is DefaultCliProvider {
  return typeof value === 'string'
    && DEFAULT_CLI_PROVIDER_IDS.some((providerId) => providerId === value);
}
