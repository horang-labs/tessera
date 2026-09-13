/** Restore again as lazily loaded folders grow the tree; user input takes over. */
export function restoreWorkspaceFileScroll(
  viewport: HTMLDivElement,
  savedTop: number,
  save: (scrollTop: number) => void,
): () => void {
  let restoring = true;
  let lastTop = savedTop;
  const restore = () => {
    if (!restoring) return;
    viewport.scrollTop = savedTop;
    if (Math.abs(viewport.scrollTop - savedTop) < 1) {
      restoring = false;
      lastTop = viewport.scrollTop;
    }
  };
  const onScroll = () => {
    if (!restoring && viewport.clientHeight > 0) lastTop = viewport.scrollTop;
  };
  const onInteraction = () => {
    restoring = false;
    lastTop = viewport.scrollTop;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      onInteraction();
    }
  };
  const observer = new ResizeObserver(restore);
  observer.observe(viewport);
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
  viewport.addEventListener('scroll', onScroll, { passive: true });
  viewport.addEventListener('wheel', onInteraction, { passive: true });
  viewport.addEventListener('pointerdown', onInteraction, { passive: true });
  viewport.addEventListener('touchstart', onInteraction, { passive: true });
  viewport.addEventListener('keydown', onKeyDown);
  restore();
  return () => {
    observer.disconnect();
    viewport.removeEventListener('scroll', onScroll);
    viewport.removeEventListener('wheel', onInteraction);
    viewport.removeEventListener('pointerdown', onInteraction);
    viewport.removeEventListener('touchstart', onInteraction);
    viewport.removeEventListener('keydown', onKeyDown);
    // Keep the requested offset if the user leaves before folder loading ends.
    // A hidden/unmounted viewport can already have been clamped to zero.
    save(!restoring && viewport.clientHeight > 0 ? viewport.scrollTop : lastTop);
  };
}
