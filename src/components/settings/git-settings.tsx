'use client';

import { useState } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { GitConfig } from '@/lib/settings/types';
import {
  GIT_ACTION_IDS,
  GIT_ACTION_DEFINITIONS,
  type GitActionId,
} from '@/lib/git/action-templates';

const ACTION_LABEL_KEYS: Record<GitActionId, string> = {
  commit: 'settings.gitConfig.actionLabelCommit',
  push: 'settings.gitConfig.actionLabelPush',
  pull: 'settings.gitConfig.actionLabelPull',
  merge: 'settings.gitConfig.actionLabelMerge',
  createPr: 'settings.gitConfig.actionLabelCreatePr',
  mergePr: 'settings.gitConfig.actionLabelMergePr',
};

export default function GitSettings() {
  const { t } = useI18n();
  const gitConfig = useSettingsStore((state) => state.settings.gitConfig);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const [expandedAction, setExpandedAction] = useState<GitActionId | null>(null);

  const update = (patch: Partial<GitConfig>) => {
    void updateSettings({ gitConfig: { ...gitConfig, ...patch } });
  };

  const setActionTemplate = (action: GitActionId, value: string | undefined) => {
    const next = { ...gitConfig.actionTemplates };
    if (value === undefined) {
      delete next[action];
    } else {
      next[action] = value;
    }
    update({ actionTemplates: next });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">
        {t('settings.gitConfig.label')}
      </h3>

      <div className="rounded-lg border border-(--divider) divide-y divide-(--divider)">
        {/* Branch prefix */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-(--text-primary)">{t('settings.gitConfig.branchPrefix')}</span>
            <span className="text-[11px] text-(--text-tertiary)">{t('settings.gitConfig.branchPrefixDesc')}</span>
          </div>
          <input
            type="text"
            value={gitConfig.branchPrefix}
            onChange={(e) => update({ branchPrefix: e.target.value })}
            placeholder={t('settings.gitConfig.branchPrefixPlaceholder')}
            className="w-40 px-3 py-1.5 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-sm focus:outline-none focus:ring-1 focus:ring-(--accent)"
          />
        </div>

      </div>

      {/* Global git guidelines */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-(--text-primary)">
            {t('settings.gitConfig.globalGuidelines')}
          </label>
          <span className="text-[11px] text-(--text-tertiary)">
            {t('settings.gitConfig.globalGuidelinesDesc')}
          </span>
        </div>
        <textarea
          value={gitConfig.globalGuidelines}
          onChange={(e) => update({ globalGuidelines: e.target.value })}
          placeholder={t('settings.gitConfig.globalGuidelinesPlaceholder')}
          rows={3}
          className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-sm focus:outline-none focus:ring-1 focus:ring-(--accent) resize-y"
        />
      </div>

      {/* Per-action prompt templates */}
      <div className="space-y-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-(--text-primary)">
            {t('settings.gitConfig.actionPromptsHeading')}
          </span>
          <span className="text-[11px] text-(--text-tertiary)">
            {t('settings.gitConfig.actionPromptsDesc')}
          </span>
        </div>

        <div className="rounded-lg border border-(--divider) divide-y divide-(--divider)">
          {GIT_ACTION_IDS.map((action) => {
            const definition = GIT_ACTION_DEFINITIONS[action];
            const override = gitConfig.actionTemplates[action];
            const isCustomized = typeof override === 'string';
            const value = isCustomized ? override : definition.defaultTemplate;
            const isExpanded = expandedAction === action;
            return (
              <div key={action} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setExpandedAction(isExpanded ? null : action)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    <span
                      className={`inline-block w-3 text-(--text-tertiary) text-xs transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    >
                      {'>'}
                    </span>
                    <span className="text-sm text-(--text-primary)">
                      {t(ACTION_LABEL_KEYS[action])}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                        isCustomized
                          ? 'bg-(--accent)/15 text-(--accent)'
                          : 'bg-(--sidebar-hover) text-(--text-tertiary)'
                      }`}
                    >
                      {isCustomized
                        ? t('settings.gitConfig.actionBadgeCustomized')
                        : t('settings.gitConfig.actionBadgeDefault')}
                    </span>
                  </button>
                  {isCustomized ? (
                    <button
                      type="button"
                      onClick={() => setActionTemplate(action, undefined)}
                      title={t('settings.gitConfig.actionResetTitle')}
                      className="text-xs text-(--text-tertiary) hover:text-(--text-primary) px-1.5 py-0.5 rounded"
                    >
                      {'\u21BA'}
                    </button>
                  ) : null}
                </div>

                {isExpanded ? (
                  <div className="mt-2 space-y-1.5">
                    <textarea
                      value={value}
                      onChange={(e) => setActionTemplate(action, e.target.value)}
                      rows={5}
                      className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-xs font-mono focus:outline-none focus:ring-1 focus:ring-(--accent) resize-y"
                    />
                    {definition.vars.length > 0 ? (
                      <div className="text-[11px] text-(--text-tertiary)">
                        {t('settings.gitConfig.availableVariables')}:{' '}
                        {definition.vars.map((v, i) => (
                          <span key={v}>
                            {i > 0 ? ', ' : null}
                            <code className="px-1 py-0.5 rounded bg-(--sidebar-hover) text-(--text-secondary)">
                              {`{{${v}}}`}
                            </code>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {definition.acceptsHint ? (
                      <div className="text-[11px] text-(--text-tertiary)">
                        {t('settings.gitConfig.acceptsHintNote')}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
