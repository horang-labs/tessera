export interface SessionReferenceExportOptions {
  untilMessageId?: string;
  untilMessageIndex?: number;
}

export async function exportSessionReference(
  sessionId: string,
  options: SessionReferenceExportOptions = {},
): Promise<string> {
  const hasOptions = Boolean(options.untilMessageId) || options.untilMessageIndex !== undefined;
  const response = await fetch(`/api/sessions/${sessionId}/export`, {
    method: 'POST',
    ...(hasOptions
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        }
      : {}),
  });
  if (!response.ok) {
    throw new Error('export failed');
  }

  const data = await response.json() as { exportPath?: string };
  if (!data.exportPath) {
    throw new Error('export path missing');
  }

  return data.exportPath;
}

export function formatSessionReference(title: string, exportPath: string): string {
  return `[Session: "${title}" → ${exportPath}]`;
}

export function formatContinueConversationPrompt(exportPath: string): string {
  return [
    `[${exportPath}]`,
    '',
    'Continue the conversation from the session export above.',
    '',
    'Read the export from the end first so the latest user request is not missed:',
    '- Start with the last 200-300 lines and identify the latest user request, current task state, recent decisions, changed files, verification status, blockers, and next action.',
    '- Treat the latest user request as the source of truth for what to do next.',
    '- Read earlier sections only when the recent tail depends on missing context or prior decisions.',
    '- Do not rely only on the beginning of the file; the end contains the most recent conversation.',
  ].join('\n');
}

export function formatForkConversationPrompt(exportPath: string): string {
  return [
    `[${exportPath}]`,
    '',
    'Start a new conversation from the selected point in the session export above.',
    '',
    'The export is intentionally truncated at the fork point:',
    '- Treat the final user/assistant exchange in the export as the current conversation state.',
    '- Continue from that point only; do not assume later messages from the original conversation exist.',
    '- Read earlier sections only when the final exchange depends on missing context or prior decisions.',
  ].join('\n');
}
