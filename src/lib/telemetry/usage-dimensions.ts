/** Privacy-safe, closed dimensions shared by browser and server usage beacons. */
export type TelemetryProvider = 'claude-code' | 'codex' | 'opencode' | 'unknown';

const TELEMETRY_PROVIDERS = new Set<TelemetryProvider>([
  'claude-code',
  'codex',
  'opencode',
  'unknown',
]);

export function normalizeTelemetryProvider(value: unknown): TelemetryProvider {
  return typeof value === 'string' && TELEMETRY_PROVIDERS.has(value as TelemetryProvider)
    ? value as TelemetryProvider
    : 'unknown';
}
