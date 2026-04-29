/**
 * Collection types for user-defined grouping of sessions and tasks.
 *
 * Collections use 'col_' prefixed IDs.
 */

export interface Collection {
  id: string;        // 'col_<8hex>'
  projectId: string;
  label: string;
  color: string;
  sortOrder: number;
}

/**
 * Generate a unique collection ID with 'col_' prefix.
 */
export function generateCollectionId(): string {
  return 'col_' + Math.random().toString(16).slice(2, 10);
}

/**
 * Check if an ID is a collection ID.
 */
export function isCollection(id: string): boolean {
  return id.startsWith('col_');
}
