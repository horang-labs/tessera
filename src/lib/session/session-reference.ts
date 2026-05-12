export async function exportSessionReference(sessionId: string): Promise<string> {
  const response = await fetch(`/api/sessions/${sessionId}/export`, { method: 'POST' });
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
