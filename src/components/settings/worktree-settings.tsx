'use client';

import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';

const WORKTREE_PATH_TEMPLATE_EXAMPLES = [
  {
    labelKey: 'settings.worktree.pathTemplateDefaultLocation',
    value: '~/.tessera/worktrees/{projectSlug}/{branchName}',
  },
  {
    labelKey: 'settings.worktree.pathTemplateExampleSibling',
    value: '{projectParent}/.worktrees/{projectSlug}/{branchName}',
  },
  {
    labelKey: 'settings.worktree.pathTemplateExampleInsideProject',
    value: '{projectPath}/.worktrees/{branchName}',
  },
] as const;

const WORKTREE_PATH_TEMPLATE_TOKENS = [
  {
    token: '{projectPath}',
    example: '/home/work/Source/My App',
    descriptionKey: 'settings.worktree.pathTemplateTokenProjectPath',
  },
  {
    token: '{projectParent}',
    example: '/home/work/Source',
    descriptionKey: 'settings.worktree.pathTemplateTokenProjectParent',
  },
  {
    token: '{projectName}',
    example: 'My App',
    descriptionKey: 'settings.worktree.pathTemplateTokenProjectName',
  },
  {
    token: '{projectSlug}',
    example: 'my-app',
    descriptionKey: 'settings.worktree.pathTemplateTokenProjectSlug',
  },
  {
    token: '{branchName}',
    example: 'feature/0508-1x',
    descriptionKey: 'settings.worktree.pathTemplateTokenBranchName',
  },
  {
    token: '{branchSlug}',
    example: 'feature-0508-1x',
    descriptionKey: 'settings.worktree.pathTemplateTokenBranchSlug',
  },
] as const;

export default function WorktreeSettings() {
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const managedWorktreePathTemplate = settings.managedWorktreePathTemplate ?? '';

  return (
    <div className="space-y-4">
        <h3 className="font-medium text-(--text-primary)">{t('settings.worktree.title')}</h3>

        <div className="space-y-2">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="managedWorktreePathTemplate" className="text-sm text-(--text-secondary)">
              {t('settings.worktree.pathTemplate')}
            </label>
            <span className="text-[11px] text-(--text-tertiary)">
              {t('settings.worktree.pathTemplateDesc')}
            </span>
            {settings.agentEnvironment === 'wsl' && (
              <span className="text-[11px] text-(--status-warning-text)">
                {t('settings.worktree.pathTemplateWslWarning')}
              </span>
            )}
          </div>
          <input
            id="managedWorktreePathTemplate"
            type="text"
            value={managedWorktreePathTemplate}
            placeholder={t('settings.worktree.pathTemplatePlaceholder')}
            onChange={(event) => void updateSettings({ managedWorktreePathTemplate: event.target.value })}
            className="w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 font-mono text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
          />
          <div className="space-y-1.5 text-[11px]">
            {WORKTREE_PATH_TEMPLATE_EXAMPLES.map((example) => (
              <div key={example.labelKey} className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
                <span className="text-(--text-muted)">
                  {t(example.labelKey)}
                </span>
                <code className="min-w-0 truncate rounded bg-(--sidebar-hover) px-2 py-1 font-mono text-(--text-secondary)">
                  {example.value}
                </code>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-(--text-muted)">
              {t('settings.worktree.pathTemplateTokens')}
            </p>
            <div className="overflow-hidden rounded-md border border-(--divider) text-[11px]">
              {WORKTREE_PATH_TEMPLATE_TOKENS.map((token, index) => (
                <div
                  key={token.token}
                  className={[
                    'grid gap-1.5 px-2 py-2 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]',
                    index === 0 ? '' : 'border-t border-(--divider)',
                  ].filter(Boolean).join(' ')}
                >
                  <code className="min-w-0 break-all font-mono text-(--accent)">
                    {token.token}
                  </code>
                  <code className="min-w-0 break-all font-mono text-(--text-secondary)">
                    {token.example}
                  </code>
                  <span className="min-w-0 text-(--text-muted)">
                    {t(token.descriptionKey)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

    </div>
  );
}
