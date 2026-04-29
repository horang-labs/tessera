import {
  GIT_ACTION_DEFINITIONS,
  type GitActionId,
  getDefaultTemplate,
  renderTemplate,
} from '@/lib/git/action-templates';

export interface BuildGitActionPromptOptions {
  action: GitActionId;
  globalGuidelines: string;
  /** User-set override for this action. Empty/whitespace falls back to default. */
  override?: string;
  /** Slot values substituted into the template via `{{name}}` markers. */
  vars?: Record<string, string>;
  /** Optional user-provided hint from the action modal. Appended below the
   *  rendered template if the action accepts hints. */
  hint?: string;
}

export function getEffectiveTemplate(
  action: GitActionId,
  override: string | undefined,
): string {
  const trimmed = override?.trim();
  return trimmed ? trimmed : getDefaultTemplate(action);
}

export function buildGitActionPrompt({
  action,
  globalGuidelines,
  override,
  vars = {},
  hint = '',
}: BuildGitActionPromptOptions): string {
  const definition = GIT_ACTION_DEFINITIONS[action];
  const template = getEffectiveTemplate(action, override);
  const rendered = renderTemplate(template, vars).trim();

  const parts: string[] = [];

  const trimmedGlobal = globalGuidelines.trim();
  if (trimmedGlobal) parts.push(trimmedGlobal);

  parts.push(rendered);

  const trimmedHint = hint.trim();
  if (definition.acceptsHint && trimmedHint) {
    parts.push(`User hint: "${trimmedHint}"`);
  }

  return parts.join('\n\n');
}
