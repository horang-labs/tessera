export type GitActionId =
  | 'commit'
  | 'push'
  | 'pull'
  | 'merge'
  | 'createPr'
  | 'mergePr';

export const GIT_ACTION_IDS: readonly GitActionId[] = [
  'commit',
  'push',
  'pull',
  'merge',
  'createPr',
  'mergePr',
];

export interface GitActionDefinition {
  id: GitActionId;
  /** Variables exposed inside the template via `{{name}}` syntax. */
  vars: readonly string[];
  /** Whether the user-provided hint (from the action modal) is appended below
   *  the rendered template. */
  acceptsHint: boolean;
  defaultTemplate: string;
}

export const DEFAULT_COMMIT_TEMPLATE =
  'Stage all current changes (run `git add -A` first if needed) and create a commit. Write a clear, concise commit message based on the diff.';

export const DEFAULT_PUSH_TEMPLATE =
  'Push the current branch "{{branch}}" to the remote.\n' +
  'If the upstream is missing, run `git push -u origin HEAD`. ' +
  'If the push is rejected as non-fast-forward, stop and report — do not force-push.';

export const DEFAULT_PULL_TEMPLATE =
  'Pull updates for the current branch "{{branch}}" from the remote.\n' +
  'If conflicts arise, stop and report them — do not auto-resolve unless asked.';

export const DEFAULT_MERGE_TEMPLATE =
  'Merge the branch "{{source}}" into the current branch "{{current}}". ' +
  'Handle any conflicts carefully and explain each resolution.';

export const DEFAULT_CREATE_PR_TEMPLATE =
  'Create a GitHub Pull Request for branch "{{branch}}" targeting base "{{base}}".\n' +
  '- If there are uncommitted changes, commit them first with an appropriate message.\n' +
  '- If the branch has not been pushed yet, push it with `git push -u origin HEAD`.\n' +
  '- Use `gh pr create --base {{base}}`. Generate a good title and description from the commits.';

export const DEFAULT_MERGE_PR_TEMPLATE =
  'Merge open pull request #{{prNumber}} for branch "{{branch}}" using ' +
  '`gh pr merge --squash --delete-branch`. ' +
  'If checks are not passing, stop and report — do not force-merge.';

export const GIT_ACTION_DEFINITIONS: Record<GitActionId, GitActionDefinition> = {
  commit: {
    id: 'commit',
    vars: [],
    acceptsHint: true,
    defaultTemplate: DEFAULT_COMMIT_TEMPLATE,
  },
  push: {
    id: 'push',
    vars: ['branch'],
    acceptsHint: false,
    defaultTemplate: DEFAULT_PUSH_TEMPLATE,
  },
  pull: {
    id: 'pull',
    vars: ['branch'],
    acceptsHint: false,
    defaultTemplate: DEFAULT_PULL_TEMPLATE,
  },
  merge: {
    id: 'merge',
    vars: ['source', 'current'],
    acceptsHint: false,
    defaultTemplate: DEFAULT_MERGE_TEMPLATE,
  },
  createPr: {
    id: 'createPr',
    vars: ['branch', 'base'],
    acceptsHint: true,
    defaultTemplate: DEFAULT_CREATE_PR_TEMPLATE,
  },
  mergePr: {
    id: 'mergePr',
    vars: ['branch', 'prNumber'],
    acceptsHint: false,
    defaultTemplate: DEFAULT_MERGE_PR_TEMPLATE,
  },
};

export function getDefaultTemplate(action: GitActionId): string {
  return GIT_ACTION_DEFINITIONS[action].defaultTemplate;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
  );
}
