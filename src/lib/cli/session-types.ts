export interface SessionInfo {
  id: string;
  createdAt: Date;
  lastModified: Date;
  messageCount: number;
  firstPrompt?: string;
  /** Encoded project directory name (e.g. "-home-work-Source-foo") */
  projectDir: string;
  /** Human-readable project path (e.g. "~/Source/foo") */
  project: string;
  /** Last user prompt from session (for session title) -- UNIT-05 */
  lastUserPrompt?: string;
  /** Whether the title was explicitly set by user */
  hasCustomTitle?: boolean;
}
