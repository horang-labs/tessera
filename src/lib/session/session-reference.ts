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
  return `[${exportPath}]\n\nContinue the conversation from the session above.`;
}
