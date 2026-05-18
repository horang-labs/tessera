const titleGenerationCountsByUser = new Map<string, Map<string, number>>();

function getUserTitleGenerationCounts(userId: string): Map<string, number> {
  let counts = titleGenerationCountsByUser.get(userId);
  if (!counts) {
    counts = new Map();
    titleGenerationCountsByUser.set(userId, counts);
  }
  return counts;
}

export function beginTitleGeneration(userId: string, sessionId: string): boolean {
  const counts = getUserTitleGenerationCounts(userId);
  const nextCount = (counts.get(sessionId) ?? 0) + 1;
  counts.set(sessionId, nextCount);
  return nextCount === 1;
}

export function endTitleGeneration(userId: string, sessionId: string): boolean {
  const counts = titleGenerationCountsByUser.get(userId);
  if (!counts) return false;

  const nextCount = (counts.get(sessionId) ?? 0) - 1;
  if (nextCount > 0) {
    counts.set(sessionId, nextCount);
    return false;
  }

  const wasGenerating = counts.delete(sessionId);
  if (counts.size === 0) {
    titleGenerationCountsByUser.delete(userId);
  }
  return wasGenerating;
}

export function getGeneratingTitleSessionIds(userId: string): string[] {
  return [...(titleGenerationCountsByUser.get(userId)?.keys() ?? [])];
}
