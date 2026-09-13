/** Count new cards after the initial incremental transcript sync has finished.
 * IDs stay local and are retained across status updates and temporary omissions.
 */
export function createImageGenerationCardTracker() {
  const seen = new Set<string>();
  let initialized = false;

  return (cards: readonly { id: string }[], syncComplete: boolean): number => {
    let added = 0;
    for (const card of cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      if (initialized) added += 1;
    }
    if (syncComplete) initialized = true;
    return added;
  };
}
