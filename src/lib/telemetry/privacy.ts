const SENSITIVE_PROPERTY_NAME_PATTERN =
  /(?:^|_)(?:prompt|message|content|text|title|path|url|repo_name|project_name|worktree_name|raw_log|trace_jsonl|output)(?:_|$)/;

/**
 * Server telemetry has no DOM masking layer. This is the fail-closed backstop
 * for free-form property bags supplied by diagnostics and background jobs.
 */
export function isSensitiveTelemetryPropertyName(key: string): boolean {
  const normalizedKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  return SENSITIVE_PROPERTY_NAME_PATTERN.test(normalizedKey);
}
