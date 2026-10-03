'use client';
import { useI18n } from '@/lib/i18n';
import type { AutorunDecisionSummary, AutorunDecisionDetail } from '@/lib/automation/autorun-contracts';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { localDue } from './automation-form';
import { AutomationReason } from './automation-reason';
import { automationButton } from './ownership-actions';
import { automationDisclosure } from './automation-layout';

export function AutorunHistory({ decisions, details = {}, onResolve, onOpenSession, onEvidence }: { decisions: AutorunDecisionSummary[]; details?: Record<string, AutorunDecisionDetail>; onResolve: (runId: string) => void; onOpenSession: (sessionId: string) => void; onEvidence: (id: string) => void }) {
  const { t } = useI18n();
  return <section className="grid gap-3" aria-label={t('automation.history')}>
    {decisions.length === 0 && <p>{t('automation.noRuns')}</p>}
    {decisions.map(item => <article className="grid gap-2 rounded-lg border border-(--divider) bg-(--chat-header-bg) p-3 text-sm leading-relaxed" key={item.id}>
      <time dateTime={new Date(item.createdAt).toISOString()}>{localDue(item.createdAt)}</time>
      <strong>{item.outcome ? t(`automation.outcome_${item.outcome}`) : t(item.phase === 'analysing' ? 'automation.phase_analysing' : item.phase === 'reserved' ? 'automation.phase_waiting' : 'automation.phase_error')}</strong>
      <p className="text-xs">{t('automation.supervisor')}: {item.supervisorSelection.provider} · {item.supervisorSelection.model}</p>
      {details[item.id]?.decision && <p className="whitespace-pre-wrap line-clamp-2">{details[item.id].decision!.explanation}</p>}
      <p>{t('automation.coverage')}: {t(`automation.coverage_${item.coverage.kind}`)}</p>
      {item.coverage.omittedBytes > 0 && <p>{t('automation.omitted')}: {item.coverage.omittedBytes} bytes</p>}
      <p>{t('automation.analysisAttempts')}: {item.analysisAttempts}</p>
      {item.retryAt && <p role="status">{t('automation.retryAt')}: {localDue(item.retryAt)}</p>}
      <AutomationReason reason={item.reason} />
      {item.runId && <p>{t(`automation.delivery_${item.delivery}`)}</p>}
      {item.delivery === 'unknown' && item.runId && <UnknownDelivery runId={item.runId} sessionId={details[item.id]?.packet.context.boundary.sessionId} onResolve={onResolve} onOpenSession={onOpenSession} />}
      <button {...telemetryClickAttributes('automation.autorun.evidence', 'automation')} type="button" className={automationButton} onClick={() => onEvidence(item.id)}>{t('automation.evidence')}</button>
    </article>)}
  </section>;
}

export function AutorunEvidence({ detail, onOpenSession }: { detail: AutorunDecisionDetail; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const context = detail.packet.context;
  const evidence = new Set(detail.decision?.evidenceIds ?? []);
  for (const criterion of detail.decision?.criterionResults ?? []) for (const id of criterion.evidenceIds) evidence.add(id);
  return <section className="grid gap-3 break-words">
    <p>{t('automation.judgment')}</p>
    <p>{detail.supervisorSelection.provider} · {detail.supervisorSelection.model} · {detail.supervisorSelection.reasoningEffort} · {detail.supervisorSelection.serviceTier}</p>
    <p>{t(detail.effectiveSelection?.kind === 'verified' ? 'automation.verifiedSelection' : 'automation.requestedOnly')}</p>
    <p>{t('automation.workerEnded')}: {localDue(context.boundary.completedAt)}</p>
    <p>{t('automation.coverage')}: {t(`automation.coverage_${context.coverage.kind}`)}</p>
    {context.coverage.omittedBytes > 0 && <section><p>{t('automation.omitted')}: {context.coverage.omittedBytes} bytes</p>{context.coverage.omittedRanges.map((range, i) => <p key={i}>{range.startByte}–{range.endByte}</p>)}</section>}
    {context.coverage.toolTruncation && <p>{t('automation.toolTruncation')}</p>}
    <AutomationReason reason={detail.reason} />
    {detail.decision && <>
      <h3 className="font-semibold">{t(`automation.outcome_${detail.decision.outcome}`)}</h3>
      <p className="whitespace-pre-wrap">{detail.decision.explanation}</p>
      <h4>{t('automation.progress')}</h4><p className="whitespace-pre-wrap">{detail.decision.progress}</p>
      {detail.decision.blocker && <p className="whitespace-pre-wrap">{detail.decision.blocker}</p>}
      {detail.decision.proposedPrompt && <><h4>{t('automation.proposal')}</h4><p className="whitespace-pre-wrap">{detail.decision.proposedPrompt}</p><p>{t(`automation.delivery_${detail.delivery}`)}</p></>}
      {detail.decision.criterionResults.map(result => <article key={result.criterionId}>
        <p>{detail.packet.criteria.find(c => c.id === result.criterionId)?.text} · {result.status}</p>
        {result.evidenceIds.map(id => <blockquote key={id} className="whitespace-pre-wrap border-l pl-2">{context.items.find(item => item.id === id)?.text}</blockquote>)}
      </article>)}
      {context.items.filter(item => evidence.has(item.id)).map(item => <blockquote className="whitespace-pre-wrap border-l pl-2" key={item.id}>{item.text}</blockquote>)}
    </>}
    <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.autorun.attempts', 'automation')}>{t('automation.attempts')}</summary>{detail.attempts.map(attempt => <article key={attempt.ordinal}>
      <p>{attempt.ordinal} · {localDue(attempt.startedAt)} · {attempt.finishedAt ? localDue(attempt.finishedAt) : t('automation.phase_analysing')}</p>
      <AutomationReason reason={attempt.failureCode} />{attempt.retryAt && <p>{t('automation.retryAt')}: {localDue(attempt.retryAt)}</p>}
    </article>)}</details>
    <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} className={automationButton} type="button" onClick={() => onOpenSession(context.boundary.sessionId)}>{t('automation.openSession')}</button>
  </section>;
}

function UnknownDelivery({ runId, sessionId, onResolve, onOpenSession }: { runId: string; sessionId?: string; onResolve: (id: string) => void; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  return <section><p>{t('automation.recovery')}</p>
    {sessionId && <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} className={automationButton} type="button" onClick={() => onOpenSession(sessionId)}>{t('automation.openSession')}</button>}
    <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.history.recover', 'automation')}>{t('automation.recover')}</summary><p>{t('automation.recovery')}</p>
      <button {...telemetryClickAttributes('automation.history.recover_confirm', 'automation')} className={automationButton} type="button" onClick={() => onResolve(runId)}>{t('automation.recover')}</button>
    </details></section>;
}
