/**
 * Metadata about a skill (prompt, command, or script) available to the CLI.
 */
export interface SkillInfo {
  /** Human-readable name of the skill. */
  name: string;
  /** Short description of what the skill does. */
  description: string;
  /** Optional filesystem path to the skill file. */
  path?: string;
}

/**
 * Provides a list of skills available in the current CLI environment.
 * Implementations may read from disk, a config file, or the CLI itself.
 */
export interface SkillSource {
  listSkills(): Promise<SkillInfo[]>;
}
