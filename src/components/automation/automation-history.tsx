'use client';

import type { AutomationRun, SessionSelectionSnapshot } from '@/lib/automation/contracts';
import { useI18n } from '@/lib/i18n';
import { localDue } from './automation-form';
import { automationButton } from './ownership-actions';

export function SavedSelection({ selection }: { selection: SessionSelectionSnapshot }) {
  const { t } = useI18n();
  return <p className="break-words text-xs text-(--text-muted)">{t('automation.saved')}: {selection.provider} · {selection.model ?? t('automation.inherited')} · {selection.reasoningEffort ?? t('automation.inherited')} · {selection.serviceTier ?? t('automation.inherited')}</p>;
}

export function AutomationHistory({ runs, onResolve, onOpenSession }: {
  runs: AutomationRun[];
  onResolve: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  return <section className="grid gap-3" aria-label={t('automation.history')}>
    <p className="text-xs text-(--text-muted)">{t('automation.noSuccess')}</p>
    {runs.length === 0 && <p>{t('automation.noRuns')}</p>}
    {runs.map(run => <article key={run.id} className="grid gap-2 border-l-2 border-(--divider) pl-3 text-sm">
      <p><strong>{run.state === 'delivered' ? t('automation.sent') : run.state}</strong> · <time dateTime={new Date(run.dueAt).toISOString()}>{localDue(run.dueAt)}</time></p>
      <p>{t('automation.runtime')}: {run.observedRuntime}</p>
      {run.reason && <p>{t('automation.reason')}: {run.reason}</p>}
      <SavedSelection selection={run.effectiveSelection} />
      {run.sessionId && <button type="button" className={`${automationButton} justify-self-start underline`} onClick={() => onOpenSession(run.sessionId!)}>{t('automation.openSession')} · {run.sessionId}</button>}
      {run.state === 'unknown' && <>
        <p className="text-xs">{t('automation.recovery')}</p>
        <button className={`${automationButton} justify-self-start`} type="button" onClick={() => onResolve(run.id)}>{t('automation.recover')}</button>
      </>}
    </article>)}
  </section>;
}
