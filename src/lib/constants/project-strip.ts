/** Sentinel value for "All Projects" mode in board-store.selectedProjectDir */
export const ALL_PROJECTS_SENTINEL = '__ALL__';

/** MIME type for project strip drag-and-drop reordering */
export const PROJECT_DND_MIME = 'application/x-project-dnd' as const;

/**
 * Curated palette of 12 visually distinct, bold colors for project icons.
 * Each entry is [background, text-safe-bg] — hand-picked for maximum contrast
 * against white text and maximum mutual distinctness.
 * Inspired by Google/Slack avatar color palettes.
 */
const PROJECT_COLORS: string[] = [
  '#E54D42', // red
  '#E8833A', // orange
  '#D4A017', // amber
  '#43A047', // green
  '#00897B', // teal
  '#039BE5', // blue
  '#5C6BC0', // indigo
  '#8E24AA', // purple
  '#D81B60', // pink
  '#6D4C41', // brown
  '#546E7A', // blue-grey
  '#F4511E', // deep-orange
];

/**
 * Returns a deterministic color from the curated palette for a project name.
 * Uses a simple hash → palette index mapping.
 */
export function getProjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}
