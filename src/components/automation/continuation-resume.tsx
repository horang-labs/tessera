'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { AutomationPreflight, AutomationReadinessRecovery } from './automation-preflight';
import { Pause } from 'lucide-react';
import { sameSupervisorSelection } from '@/lib/automation/autorun-contracts';
import type { AutorunPreview, AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { InputOwnership } from '@/lib/automation/contracts';
import type { AutomationStoreApi } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { AutorunPreviewView, autorunCanStart } from './autorun-setup';
import { automationButton, automationPrimaryButton, automationToolbarButton } from './ownership-actions';
import { useAutomationOwnership } from './use-automation';
import { SavedSelection } from './automation-history';
import { AutomationViewport, AutomationFacts, AutomationTime, automationDisclosure } from './automation-layout';
export function ContinuationResume({ preview, loading, rule, store, onDone, onOpenSession, onEdit, onDraftObjective, requestErrorNotice }: {
  requestErrorNotice?: ReactNode; preview: AutorunPreview | null; loading: boolean; rule: AutomationV2; store: AutomationStoreApi;
  onDraftObjective?: (text: string) => void; onDone: (id: string) => void; onOpenSession: () => void; onEdit: () => void;
}) {
  const { t } = useI18n();
  const { previewError, previewRejection } = useStore(store);
  const retry = () => void store.getState().previewAutorun(rule.mode === 'autorun' ? { supervisor: rule.autorun.supervisor } : {});
  const ownership = useAutomationOwnership(rule.target.kind === 'wake-session' ? rule.target.sessionId : '');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const supervisorBlocked = preview?.readiness.kind === 'unavailable' && preview.readiness.code === 'SUPERVISOR_UNSUPPORTED' && preview.supervisorCheck.status === 'unavailable';
  const counts = rule.dispatchCount < rule.limits.maxDispatches && rule.limits.expiresAt > now;
  const reviewLimits = automationNeedsLimitReview(rule, now);
  const ready = !loading && !previewError && counts && ownership.mode === 'human' && (rule.mode !== 'autorun'
    ? heartbeatCanResume(preview, loading, previewError)
    : Boolean(preview && rule.analysisCount < rule.autorun.maxAnalyses && autorunCanStart(preview, rule.autorun.supervisor,
      rule.autorun.objective.kind === 'explicit' ? rule.autorun.objective.text : '', rule.limits.expiresAt, now)));
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden"><AutomationViewport footerNote={!loading && !previewError && requestErrorNotice ? requestErrorNotice : <>
    <AutomationPreflight loading={loading} error={previewError} onRetry={retry} />
    {!loading && !previewError && preview && !supervisorBlocked && ['idle','unavailable'].includes(preview.readiness.kind) && <AutomationReadinessRecovery preview={preview} resume method={rule.mode === 'autorun' ? 'autorun' : 'heartbeat'} onOpenSession={onOpenSession} objective={rule.mode === 'autorun' ? rule.autorun.objective.text : rule.prompt} onDraftObjective={onDraftObjective} />}
    {!loading && !previewError && rule.mode === 'autorun' && preview && (supervisorBlocked || ['running','completed'].includes(preview.readiness.kind)) && (preview.supervisorCheck.status !== 'available' || !preview.supervisorCheck.selection || !sameSupervisorSelection(preview.supervisorCheck.selection, rule.autorun.supervisor)) && <p>{t(preview.supervisorCheck.reason === 'selection' ? 'automation.selectionUnsupported' : 'automation.supervisorSetupFailed')}</p>}
  </>} footer={<>
    <AutomationResumeAction reviewLimits={reviewLimits} disabled={store.getState().busy > 0 || (reviewLimits ? ownership.mode !== 'human' : !ready)} onReviewLimits={onEdit} onResume={async () => { if (await store.getState().enable(rule)) onDone(rule.id); }} />
    {!reviewLimits && <button {...telemetryClickAttributes('automation.manager.edit', 'automation')} className={automationButton} type="button" onClick={onEdit}>{t('automation.edit')}</button>}
  </>}>
    {rule.mode === 'autorun' && <AutorunPreviewView preview={preview} objectiveSnapshot={rule.autorun.objective} readOnly objectiveOverride={rule.autorun.objective.kind === 'explicit' ? rule.autorun.objective.text : ''} onObjective={onEdit} onOpenSession={onOpenSession} />}
    {rule.mode === 'autorun' ? <>
      <p className="text-sm break-words"><span className="mr-2 text-xs text-(--text-secondary)">{t('automation.supervisor')}</span> {rule.autorun.supervisor.provider} · {rule.autorun.supervisor.model} · {rule.autorun.supervisor.reasoningEffort} · {rule.autorun.supervisor.serviceTier}</p>
    </> : <p className="whitespace-pre-wrap">{rule.prompt}</p>}
    <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.form.advanced', 'automation')}>{t('automation.optionsLimits')}</summary>
      <AutomationFacts items={[{ label: t('automation.instructionAttempts'), value: `${rule.dispatchCount}/${rule.limits.maxDispatches}` }, ...(rule.mode === 'autorun' ? [{ label: t('automation.supervisorChecks'), value: `${rule.analysisCount}/${rule.autorun.maxAnalyses}` }] : []), { label: t('automation.expiry'), value: <AutomationTime at={rule.limits.expiresAt} /> }]} />
    </details>
    <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')} className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-(--accent)">{t('automation.technicalDetails')}</summary><div className="mt-2 grid gap-2"><SavedSelection selection={rule.savedSelection} />{previewRejection && <p>{previewRejection}</p>}{preview?.readiness.kind === 'unavailable' && <p>{preview.readiness.code} · {preview.readiness.reason}</p>}{preview?.readiness.kind === 'idle' && <p>{preview.readiness.reason}</p>}{!loading && <button type="button" className={`${automationButton} justify-self-start`} {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} onClick={retry}>{t('automation.checkAgain')}</button>}</div></details>
  </AutomationViewport></section>;
}

/** Autorun-only context/capability failures defer to base Heartbeat server admission. */
export function heartbeatCanResume(preview: AutorunPreview | null, loading: boolean, error?: string | null) {
  if (loading || error || !preview || preview.readiness.kind === 'idle') return false;
  return preview.readiness.kind !== 'unavailable' || !['unsafe-runtime', 'binding-mismatch'].includes(preview.readiness.reason);
}

/** Shared outside-input action for manager, Session panel and Session Peek. */
export function AutomationPauseAction({ rule, ownership, onPause, surface, schedule = false, compact = false }: {
  rule?: { id: string; state: AutomationV2['state'] }; ownership: Readonly<InputOwnership>;
  onPause: (id: string) => void; surface: 'automation' | 'chat_header'; schedule?: boolean; compact?: boolean;
}) {
  const { t } = useI18n();
  const id = ownership.mode !== 'human' && ownership.automationId ? ownership.automationId
    : rule?.state === 'enabled' ? rule.id : null;
  if (!id) return null;
  return <button {...telemetryClickAttributes('automation.pause', surface)} className={compact ? automationToolbarButton : automationButton} title={t(schedule ? 'automation.schedulePause' : 'automation.pause')} aria-label={t(schedule ? 'automation.schedulePause' : 'automation.pause')} type="button" onClick={() => onPause(id)}>{compact ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : t(schedule ? 'automation.schedulePause' : 'automation.pause')}</button>;
}

export function automationNeedsLimitReview(rule: AutomationV2, now: number) {
  return rule.state === 'exhausted' || rule.state === 'expired' || rule.dispatchCount >= rule.limits.maxDispatches
    || rule.limits.expiresAt <= now || (rule.mode === 'autorun' && rule.analysisCount >= rule.autorun.maxAnalyses);
}

/** Reviewing a spent budget opens edit; saving never replaces explicit Resume. */
export function AutomationResumeAction({ reviewLimits, disabled, onReviewLimits, onResume }: {
  reviewLimits: boolean; disabled: boolean; onReviewLimits: () => void; onResume: () => void;
}) {
  const { t } = useI18n();
  return <button {...(reviewLimits ? telemetryClickAttributes('automation.manager.edit', 'automation') : telemetryClickAttributes('automation.manager.enable', 'automation'))} className={automationPrimaryButton} type="button" disabled={disabled} onClick={reviewLimits ? onReviewLimits : onResume}>{t(reviewLimits ? 'automation.reviewLimits' : 'automation.resume')}</button>;
}
