'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import type { AutomationRun, SessionSelectionSnapshot } from '@/lib/automation/contracts';
import { useI18n } from '@/lib/i18n';
import { localDue } from './automation-form';
import { AutomationReason } from './automation-reason';
import { useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import { automationButton } from './ownership-actions';
import { automationDisclosure } from './automation-layout';

export function SavedSelection({ selection }: { selection: SessionSelectionSnapshot }) {
  const { t } = useI18n();
  return <p className="break-words text-xs text-(--text-secondary)">{t('automation.saved')}: {selection.provider} · {selection.model ?? t('automation.inherited')} · {selection.reasoningEffort ?? t('automation.inherited')} · {selection.serviceTier ?? t('automation.inherited')}</p>;
}

export function AutomationHistory({ runs, onResolve, onOpenSession, deliveredLabel }: {
  runs: AutomationRun[]; deliveredLabel?: string;
  onResolve: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  return <section className="grid gap-3" aria-label={t('automation.history')}>
    <p className="text-xs text-(--text-secondary)">{t('automation.noSuccess')}</p>
    {runs.length === 0 && <p>{t('automation.noRuns')}</p>}
    {runs.map(run => <article key={run.id} className="grid gap-2 rounded-lg border border-(--divider) bg-(--chat-header-bg) p-3 text-sm leading-relaxed">
      <p><strong>{run.state === 'delivered' ? deliveredLabel ?? t('automation.sent') : t(`automation.delivery_${run.state}`)}</strong> · <time dateTime={new Date(run.dueAt).toISOString()}>{localDue(run.dueAt)}</time></p>
      <p>{t('automation.runtime')}: {run.observedRuntime === 'turn-complete' ? t('automation.workerEnded') : run.observedRuntime}</p>
      {run.coalescedCount > 0 && <p>{t('automation.coalesced')}: {run.coalescedCount}</p>}
      <AutomationReason reason={run.reason} />
      <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')}>{t('automation.diagnostics')}</summary><SavedSelection selection={run.effectiveSelection} /></details>
      {run.sessionId && <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} type="button" className={`${automationButton} justify-self-start underline`} onClick={() => onOpenSession(run.sessionId!)}><SessionLinkLabel sessionId={run.sessionId!} /></button>}
      {run.state === 'unknown' && <>
        <p className="text-xs">{t('automation.recovery')}</p>
        <button {...telemetryClickAttributes('automation.history.recover', 'automation')} className={`${automationButton} justify-self-start`} type="button" onClick={() => onResolve(run.id)}>{t('automation.recover')}</button>
      </>}
    </article>)}
  </section>;
}

function SessionLinkLabel({ sessionId }: { sessionId: string }) {
  const session = useProjectViewSession(sessionId); const { t } = useI18n();
  return <>{t('automation.openSession')} · {session?.title ?? t('automation.target')}</>;
}
