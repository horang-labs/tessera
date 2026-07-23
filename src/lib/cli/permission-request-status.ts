const MAX_PERMISSION_PREVIEW_LENGTH = 240;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_PERMISSION_PREVIEW_LENGTH) return value;
  return `${value.slice(0, MAX_PERMISSION_PREVIEW_LENGTH - 1)}…`;
}

function readToolSummary(payload: Record<string, unknown>): string {
  const inputValue = payload.tool_input ?? payload.toolInput ?? payload.input;
  const directInput = readString(inputValue);
  if (directInput) return directInput;

  const input = readRecord(inputValue);
  if (!input) return '';
  return readString(input.command)
    || readString(input.description)
    || readString(input.file_path)
    || readString(input.filePath)
    || readString(input.path);
}

/** Claude Code/Codex PermissionRequest payload를 PTY의 입력 대기 상태로 정규화한다. */
export function classifyPermissionRequestEvent(
  event: string,
  payload: Record<string, unknown>,
): { status: 'input_required'; preview?: string } | null {
  if (event !== 'PermissionRequest') return null;

  const toolName = readString(payload.tool_name) || readString(payload.toolName);
  const summary = readToolSummary(payload);
  const preview = toolName && summary
    ? `${toolName}: ${summary}`
    : toolName || summary;

  return {
    status: 'input_required',
    preview: preview ? truncatePreview(preview) : undefined,
  };
}
