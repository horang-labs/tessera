/** Privacy-safe, closed dimensions shared by browser and server usage beacons. */
export type TelemetryProvider = 'claude-code' | 'codex' | 'opencode' | 'unknown';
export type TelemetryPromptSource = 'gui' | 'pty_direct' | 'pty_chat_view' | 'unknown';
export type TelemetryFormFactor = 'mobile' | 'desktop' | 'unknown';

const TELEMETRY_PROVIDERS = new Set<TelemetryProvider>([
  'claude-code',
  'codex',
  'opencode',
  'unknown',
]);
const TELEMETRY_PROMPT_SOURCES = new Set<TelemetryPromptSource>([
  'gui',
  'pty_direct',
  'pty_chat_view',
  'unknown',
]);
const TELEMETRY_FORM_FACTORS = new Set<TelemetryFormFactor>([
  'mobile',
  'desktop',
  'unknown',
]);

export function normalizeTelemetryProvider(value: unknown): TelemetryProvider {
  return typeof value === 'string' && TELEMETRY_PROVIDERS.has(value as TelemetryProvider)
    ? value as TelemetryProvider
    : 'unknown';
}

export function normalizeTelemetryPromptSource(value: unknown): TelemetryPromptSource {
  return typeof value === 'string'
    && TELEMETRY_PROMPT_SOURCES.has(value as TelemetryPromptSource)
    ? value as TelemetryPromptSource
    : 'unknown';
}

export function normalizeTelemetryFormFactor(value: unknown): TelemetryFormFactor {
  return typeof value === 'string'
    && TELEMETRY_FORM_FACTORS.has(value as TelemetryFormFactor)
    ? value as TelemetryFormFactor
    : 'unknown';
}
