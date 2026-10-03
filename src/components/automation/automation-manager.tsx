'use client';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { AutomationPreflight, AutomationReadinessRecovery } from './automation-preflight';
import type { Automation, AutomationInput } from '@/lib/automation/contracts';
import type { AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useTerminalSessionStore } from '@/stores/terminal-session-store';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AutomationForm, localDue } from './automation-form';
import { AutomationHistory, SavedSelection } from './automation-history';
import { AutomationError } from './automation-error';
import { AutomationReason, automationReasonKey } from './automation-reason';
import { useAutomationOwnership } from './use-automation';
import { automationButton } from './ownership-actions';
import { ContinuationResume, heartbeatCanResume, AutomationPauseAction, AutomationResumeAction, automationNeedsLimitReview } from './continuation-resume';
import { AutorunSetup } from './autorun-setup';
import { AutorunHistory, AutorunEvidence } from './autorun-history';
import { useAutomationContext } from './automation-context';
import { AutomationViewport, AutomationFacts, AutomationTime, automationDisclosure, automationNotice } from './automation-layout';

const selectedAutomationButton = cn(automationButton, 'border-(--accent) bg-(--accent)/10 text-(--accent) font-semibold');

type SetupIntent = 'start' | 'resume' | 'edit' | 'replace';
/** Keep the rendered Heartbeat action and its guarded control path together. */
export function heartbeatSetupSubmission(store: AutomationStoreApi, intent: SetupIntent, sessionId: string, rule: AutomationV2 | undefined, onDone: (id: string) => void) {
  const { preview, previewLoading, previewError, previewRejection } = store.getState();
  return {
    submitBlocked: Boolean(intent !== 'edit' && sessionId && (intent === 'replace' || previewRejection) && !heartbeatCanResume(preview, previewLoading, previewError)),
    onSave: async (input: AutomationInput, previous?: Automation) => {
      if (intent === 'replace' && rule) {
        if (!heartbeatCanResume(preview, previewLoading, previewError)) { store.setState({ error: 'INPUT_BOUNDARY_UNPROVEN' }); return false; }
        if (!await store.getState().remove(rule.id)) return false;
      }
      const success = await store.getState().save(input, previous);
      const id = store.getState().lastControl?.body.automation.id;
      if (success && id) onDone(id);
      return success;
    },
  };
}

export function AutomationManager({ scope, store, onClose, onOpenSession, supported = true, initialId, initialResume = false }: {
  scope: AutomationScope; store: AutomationStoreApi; onClose: () => void; onOpenSession: (id: string, objective?: string) => void; supported?: boolean; initialId?: string; initialResume?: boolean;
}) {
  const { t } = useI18n();
  const state = useStore(store);
  const { items, loading, error, busy, runs, details, decisions, decisionDetails, preview, previewLoading, previewError, view } = state;
  const sessionId = 'sessionId' in scope ? scope.sessionId : '';
  const context = useAutomationContext(scope);
  const ownership = useAutomationOwnership(sessionId);
  const terminal = useTerminalSessionStore(state => state.bySessionId[sessionId]);
  const gateIdentity = [ownership.mode, ownership.epoch, ownership.automationId, terminal?.terminalId, terminal?.status, terminal?.automationGateStateAt, terminal?.runtimeExited].join(':');
  const previousGate = useRef(gateIdentity);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const [intent, setIntent] = useState<SetupIntent>(initialResume ? 'resume' : 'start');
  const [method, setMethod] = useState<'autorun' | 'heartbeat'>('autorun');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const rule = view.selectedId ? details[view.selectedId]?.automation : undefined;
  const updateView = (patch: Partial<typeof view>) => store.setState({ view: { ...store.getState().view, ...patch } });
  const returnToList = () => { setIntent('start'); setEvidenceId(null); setDeleteConfirm(false); updateView({ setup: false, selectedId: null }); };
  const select = (id: string) => { setIntent('start'); setEvidenceId(null); setDeleteConfirm(false); updateView({ selectedId: id, setup: false }); void store.getState().inspect(id); };
  const done = select;
  async function deleteRule(current: AutomationV2) {
    if (!await store.getState().remove(current.id)) return;
    await store.getState().inspect(current.id);
    if (store.getState().view.selectedId !== current.id) return;
    setIntent('start'); setEvidenceId(null); setDeleteConfirm(false);
    updateView({ selectedId: current.id, setup: false });
  }
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    if (initialId) {
      store.setState({ view: { ...store.getState().view, selectedId: initialId, setup: initialResume } });
      if (initialResume) { const saved = store.getState().details[initialId]?.automation; void store.getState().previewAutorun(saved?.mode === 'autorun' ? { supervisor: saved.autorun.supervisor } : {}); }
    }
    return () => { const target = returnFocus.current; if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true }); };
  }, [store, initialId, initialResume]);
  useEffect(() => {
    if (!view.selectedId) return;
    const refresh = () => {
      void store.getState().inspect(view.selectedId!);
      void store.getState().loadRuns(view.selectedId!);
      if (store.getState().items.find(item => item.id === view.selectedId)?.mode === 'autorun') void store.getState().loadDecisions(view.selectedId!).then(() => {
        for (const item of (store.getState().decisions[view.selectedId!]?.items ?? []).slice(0,3)) void store.getState().inspectDecision(view.selectedId!, item.id);
      });
    };
    refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer);
  }, [store, view.selectedId]);
  const reviewLimits = rule ? automationNeedsLimitReview(rule, now) : false;
  const previewPrevious = rule?.mode === 'autorun' ? rule : undefined;
  async function setup(nextIntent: SetupIntent, current?: AutomationV2) {
    setIntent(nextIntent); setEvidenceId(null);
    setMethod(nextIntent === 'replace' ? current?.mode === 'autorun' ? 'heartbeat' : 'autorun' : current?.mode === 'heartbeat' ? 'heartbeat' : 'autorun');
    updateView({ selectedId: current?.id ?? null, setup: true });
    if (sessionId) await store.getState().previewAutorun(current?.mode === 'autorun' && nextIntent !== 'replace' ? { supervisor: current.autorun.supervisor } : {});
  }
  async function pauseAndEdit(current: AutomationV2, nextIntent: SetupIntent) {
    if (current.state === 'enabled' && !await store.getState().pause(current.id)) return;
    const receipt = await store.getState().inspect(current.id);
    if (!receipt || receipt.inFlightRunId || (receipt.inputOwnership && receipt.inputOwnership.mode !== 'human') || (sessionId && ownership.mode !== 'human')) {
      store.setState({ error: 'PAUSE_REQUIRED' }); return;
    }
    await setup(nextIntent, receipt.automation);
  }
  const emptySetup = !loading && items.filter(item => item.state !== 'deleted').length === 0 && !view.selectedId && !includeDeleted;
  const showSetup = rule?.state !== 'deleted' && (view.setup || emptySetup);
  useEffect(() => {
    const changed = previousGate.current !== gateIdentity;
    previousGate.current = gateIdentity;
    if (!changed || !showSetup || !sessionId) return;
    const state = store.getState();
    if (!state.preview && !state.previewLoading) return;
    if (ownership.mode === 'human') void state.recheckAutorunPreview();
    else state.invalidateAutorunPreview();
  }, [gateIdentity, showSetup, sessionId, store, ownership.mode]);
  const visible = items.filter(item => includeDeleted || item.state !== 'deleted').sort((a,b) => {
    const priority = (item: typeof a) => item.attention ? 0 : item.state === 'enabled' ? 1 : 2;
    return priority(a)-priority(b);
  });
  const fixedDraftKey = `${sessionId ? 'heartbeat' : 'schedule'}:${view.selectedId ?? 'new'}:${intent}`;
  const retryAt = rule?.mode === 'autorun' ? decisions[rule.id]?.items[0]?.retryAt : null;
  const timing = rule?.nextDueAt ? `${t('automation.next')}: ${localDue(rule.nextDueAt)}`
    : retryAt ? `${t('automation.retryAt')}: ${localDue(retryAt)}` : rule?.mode === 'autorun' ? null : t('automation.notScheduled');
  const setupIntro = sessionId && intent === 'start' && <div className="flex flex-wrap gap-2">
    <button {...telemetryClickAttributes('automation.setup.autorun', 'automation')} className={method === 'autorun' ? selectedAutomationButton : automationButton} type="button" title={t('automation.continueWork')} aria-pressed={method === 'autorun'} onClick={() => { setMethod('autorun'); if (!preview) void store.getState().previewAutorun(); }}>{t('automation.autorunMethod')}</button>
    <button {...telemetryClickAttributes('automation.setup.heartbeat', 'automation')} className={method === 'heartbeat' ? selectedAutomationButton : automationButton} type="button" title={t('automation.heartbeat')} aria-pressed={method === 'heartbeat'} onClick={() => setMethod('heartbeat')}>{t('automation.heartbeatMethod')}</button>
  </div>;
  const setupFootnote = <p>{t('automation.setupNote')}</p>;
  const requestErrorCode = showSetup && state.previewRejection === error ? null : error;
  const sessionRecovery = Boolean(sessionId && requestErrorCode && ['reasonContext', 'reasonApproval', 'reasonUnknown'].includes(automationReasonKey(requestErrorCode, 'request')));
  const requestErrorNotice = requestErrorCode ? <AutomationError code={requestErrorCode} recovery={
    <button type="button" className={automationButton} {...telemetryClickAttributes(sessionRecovery ? 'automation.history.open_session' : 'automation.manager.refresh', 'automation')} onClick={() => {
      if (sessionRecovery) onOpenSession(sessionId);
      else { void store.getState().refresh(); if (view.selectedId) void store.getState().inspect(view.selectedId); }
    }}>{t(sessionRecovery ? 'automation.openSession' : 'automation.retry')}</button>
  } /> : undefined;
  return createPortal(<dialog {...telemetryIgnoreAttributes('event_boundary')} data-automation-dialog ref={dialog} aria-label={t('automation.title')}
    className="m-auto max-h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),42rem)] overflow-hidden rounded-xl border border-(--divider) bg-(--chat-bg) p-0 text-(--text-primary) shadow-xl backdrop:bg-black/50 open:flex open:flex-col"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (evidenceId) setEvidenceId(null); else onClose(); }}
    onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <header className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-(--divider) bg-(--chat-bg) px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{t('automation.title')}</h2><p className="line-clamp-1 break-words text-xs text-(--text-secondary)">{context.title} · {context.subtitle}</p></div>
      <button {...telemetryClickAttributes('automation.manager.close', 'automation')} className={automationButton} type="button" onClick={onClose}>{t('automation.close')}</button>
      {rule && rule.state !== 'deleted' && (showSetup || evidenceId) && <button {...telemetryClickAttributes('automation.delete','automation')} className={automationButton} type="button" onClick={() => setDeleteConfirm(true)}>{t('automation.delete')}</button>}
      <AutomationPauseAction rule={rule} ownership={ownership} surface="automation" schedule={!sessionId} onPause={id => void store.getState().pause(id)} />
    </header>
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 pt-2 text-xs">
    {(view.selectedId || view.setup || evidenceId) && <button {...telemetryClickAttributes('automation.manager.back', 'automation')} className={automationButton} type="button" onClick={() => { if (evidenceId) setEvidenceId(null); else returnToList(); }}>{t('automation.back')}</button>}
    {deleteConfirm && rule && (showSetup || evidenceId) && <div role="alert"><p>{t('automation.deleteConfirm')}</p><button {...telemetryClickAttributes('automation.delete.confirm','automation')} className={automationButton} onClick={() => void deleteRule(rule)}>{t('automation.confirmDelete')}</button><button {...telemetryClickAttributes('automation.delete.cancel','automation')} className={automationButton} onClick={() => setDeleteConfirm(false)}>{t('automation.cancel')}</button></div>}
    {sessionId && !showSetup && <p role="status" className="text-xs text-(--text-secondary)">{t(`automation.${ownership.mode}`)}</p>}
    </div>
    {showSetup ? <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {items.some(item => item.state === 'deleted') && <button {...telemetryClickAttributes('automation.manager.include_deleted', 'automation')} className={automationButton} type="button" onClick={() => { setIncludeDeleted(true); returnToList(); }}>{t('automation.deleted')}</button>}
      {!supported ? <p className="px-4">{t('automation.unsupported')}</p> : <>
        {intent === 'resume' && rule ? <ContinuationResume requestErrorNotice={requestErrorNotice} preview={preview} loading={previewLoading} rule={rule} store={store} onDone={done} onOpenSession={() => onOpenSession(sessionId)} onDraftObjective={ownership.mode === 'human' ? text => onOpenSession(sessionId, text) : undefined} onEdit={() => void setup('edit', rule)} /> : sessionId && method === 'autorun' ? <>
          {<AutorunSetup requestErrorNotice={requestErrorNotice} key={`${view.selectedId}:${intent}`} preview={preview} store={store} previous={intent === 'replace' ? rule : previewPrevious} intent={intent} intro={setupIntro} footnote={setupFootnote} defaultName={`${context.title} · Autorun`} onDone={done} onOpenSession={() => onOpenSession(sessionId)} onDraftObjective={ownership.mode === 'human' ? text => onOpenSession(sessionId, text) : undefined} />}
        </> : <>
          <AutomationForm {...heartbeatSetupSubmission(store, intent, sessionId, rule, done)} footerNote={(previewLoading || previewError) && requestErrorNotice ? <AutomationPreflight loading={previewLoading} error={previewError} onRetry={() => void store.getState().recheckAutorunPreview()} /> : requestErrorNotice ?? (sessionId && (intent === 'replace' || state.previewRejection) ? <><AutomationPreflight loading={previewLoading} error={previewError} onRetry={() => void store.getState().recheckAutorunPreview()} />{!previewLoading && !previewError && <AutomationReadinessRecovery preview={preview} method="heartbeat" onOpenSession={() => onOpenSession(sessionId)} objective={String((state.drafts[fixedDraftKey] as Record<string,string> | undefined)?.prompt ?? '')} onDraftObjective={ownership.mode === 'human' ? text => onOpenSession(sessionId,text) : undefined} />}</> : undefined)} intro={setupIntro} footnote={<>{setupFootnote}{sessionId && state.previewRejection && <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.diagnostics','automation')} className="cursor-pointer">{t('automation.technicalDetails')}</summary><p>{state.previewRejection}</p>{preview && (preview.readiness.kind === 'idle' || preview.readiness.kind === 'unavailable') && <p>{preview.readiness.reason}</p>}</details>}</>} key={`${view.selectedId}:${intent}`} scope={scope} previous={intent === 'edit' && rule?.mode !== 'autorun' ? rule : undefined}
            defaultName={`${context.title} · ${sessionId ? 'Heartbeat' : t('automation.schedule')}`} replacing={intent === 'replace'} draft={state.drafts[fixedDraftKey]} onDraft={draft => store.setState(s => ({ drafts: { ...s.drafts, [fixedDraftKey]: draft } }))}
            onCancel={() => updateView({ setup: false })} />
        </>}
      </>}
    </section> : rule ? <section className="flex min-h-0 flex-1 flex-col overflow-hidden"><AutomationViewport>
      {requestErrorNotice}
      {evidenceId ? decisionDetails[evidenceId] ? <AutorunEvidence detail={decisionDetails[evidenceId]} onOpenSession={onOpenSession} /> : <p>{t('automation.loading')}</p> : <>
        <h3 className="text-base font-semibold break-words">{rule.name}</h3><p className="text-xs text-(--text-muted)">{t(rule.mode === 'autorun' ? 'automation.continueWork' : rule.mode === 'heartbeat' ? 'automation.heartbeat' : 'automation.schedule')}</p>
        <p className={automationNotice} role="status">{t(`automation.state_${rule.state}`)}{rule.mode === 'autorun' && ` · ${t(`automation.phase_${rule.autorunStatus}`)}`}</p>
        <AutomationReason reason={rule.pauseReason} />
        {rule.mode === 'autorun' && rule.attention && <p className="whitespace-pre-wrap">{rule.attention.summary}</p>}
        <AutomationFacts items={[{ label: t('automation.instructionAttempts'), value: `${rule.dispatchCount}/${rule.limits.maxDispatches}` }, ...(rule.mode === 'autorun' ? [{ label: t('automation.analysisAttempts'), value: `${rule.analysisCount}/${rule.autorun.maxAnalyses}` }] : []), { label: t('automation.expiry'), value: <AutomationTime at={rule.limits.expiresAt} /> }]} />
        {timing && <p>{timing}</p>}
        <div className="flex flex-wrap gap-2">
          {rule.state !== 'deleted' && <>
            {rule.state !== 'enabled' && <AutomationResumeAction reviewLimits={reviewLimits} disabled={busy > 0 || Boolean(sessionId && ownership.mode !== 'human')} onReviewLimits={() => void pauseAndEdit(rule, 'edit')} onResume={() => { if (sessionId) void setup('resume', rule); else void store.getState().enable(rule); }} />}
            <button {...telemetryClickAttributes('automation.delete', 'automation')} className={automationButton} onClick={() => setDeleteConfirm(true)}>{t('automation.delete')}</button>
            {deleteConfirm && <div role="alert"><p>{t('automation.deleteConfirm')}</p><button {...telemetryClickAttributes('automation.delete.confirm', 'automation')} className={automationButton} onClick={() => void deleteRule(rule)}>{t('automation.confirmDelete')}</button><button {...telemetryClickAttributes('automation.delete.cancel', 'automation')} className={automationButton} onClick={() => setDeleteConfirm(false)}>{t('automation.cancel')}</button></div>}
            <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.manager.options', 'automation')}>{t('automation.manage')}</summary>
              <button {...telemetryClickAttributes('automation.manager.edit', 'automation')} className={automationButton} onClick={() => void pauseAndEdit(rule, 'edit')}>{t(rule.state === 'enabled' ? 'automation.pauseEdit' : 'automation.edit')}</button>
              {sessionId && <button {...telemetryClickAttributes('automation.manager.method', 'automation')} className={automationButton} onClick={() => void pauseAndEdit(rule, 'replace')}>{t('automation.changeMethod')}</button>}
            </details>
          </>}
        </div>
        <div className="flex gap-2" role="tablist"><button {...telemetryClickAttributes('automation.manager.overview', 'automation')} role="tab" aria-selected={view.tab === 'overview'} className={view.tab === 'overview' ? selectedAutomationButton : automationButton} onClick={() => updateView({ tab: 'overview' })}>{t('automation.overview')}</button><button {...telemetryClickAttributes('automation.manager.history', 'automation')} role="tab" aria-selected={view.tab === 'history'} className={view.tab === 'history' ? selectedAutomationButton : automationButton} onClick={() => updateView({ tab: 'history' })}>{t('automation.history')}</button></div>
        {view.tab === 'overview' && <details className={automationDisclosure}><summary {...telemetryClickAttributes('automation.manager.configuration', 'automation')}>{t('automation.configuration')}</summary>
          {rule.mode === 'autorun' ? <><p className="whitespace-pre-wrap">{rule.autorun.objective.text}</p><p>{t(rule.autorun.objective.kind === 'verified-human' ? 'automation.verifiedGoal' : 'automation.explicitGoal')}</p><p>{rule.autorun.supervisor.provider} · {rule.autorun.supervisor.model}</p></> : <p className="whitespace-pre-wrap">{rule.prompt}</p>}
          <SavedSelection selection={rule.savedSelection} />
        </details>}
        {rule.mode === 'autorun' && state.newDecisionCount[rule.id] > 0 && <button {...telemetryClickAttributes('automation.history.new', 'automation')} className={automationButton} onClick={() => store.getState().showNewDecisions(rule.id)}>{state.newDecisionCount[rule.id]} {t('automation.newEntries')}</button>}
        {rule.mode === 'autorun' ? <AutorunHistory details={decisionDetails} onResolve={id => void store.getState().resolve(rule.id,id)} onOpenSession={onOpenSession} decisions={(decisions[rule.id]?.items ?? []).slice(0, view.tab === 'overview' ? 3 : undefined)} onEvidence={id => { setEvidenceId(id); void store.getState().inspectDecision(rule.id,id); }} /> : <AutomationHistory runs={(runs[rule.id]?.items ?? []).slice(0, view.tab === 'overview' ? 3 : undefined)} onResolve={id => void store.getState().resolve(rule.id,id)} onOpenSession={onOpenSession} />}
        {view.tab === 'history' && (rule.mode === 'autorun' ? decisions[rule.id]?.nextCursor : runs[rule.id]?.nextCursor) && <button {...telemetryClickAttributes('automation.manager.more', 'automation')} className={automationButton} onClick={() => void (rule.mode === 'autorun' ? store.getState().loadDecisions(rule.id,true) : store.getState().loadRuns(rule.id,true))}>{t('automation.more')}</button>}
      </>}
    </AutomationViewport></section> : <AutomationViewport>
      {requestErrorNotice}
      <div className="my-4 flex flex-wrap gap-3"><button {...telemetryClickAttributes('automation.manager.new', 'automation')} className={automationButton} onClick={() => void setup('start')}>{t('automation.new')}</button><label><input {...telemetryClickAttributes('automation.manager.include_deleted', 'automation')} type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} />{t('automation.deleted')}</label><button {...telemetryClickAttributes('automation.manager.refresh', 'automation')} className={automationButton} onClick={() => void store.getState().refresh()}>{t('automation.retry')}</button></div>
      {loading && <p role="status">{t('automation.loading')}</p>}
      {visible.map((item,index) => <article className="grid gap-2 rounded-lg border border-(--divider) bg-(--chat-header-bg) p-3" key={item.id}>
        {(index === 0 || Boolean(visible[index-1].attention) !== Boolean(item.attention) || (visible[index-1].state === 'enabled') !== (item.state === 'enabled')) && <h3>{t(item.attention ? 'automation.needsAttention' : item.state === 'enabled' ? 'automation.activeGroup' : 'automation.endedGroup')}</h3>}
        <button {...telemetryClickAttributes('automation.manager.detail', 'automation')} className={`${automationButton} text-left`} onClick={() => select(item.id)}>{item.name} · {t(`automation.state_${item.state}`)}</button>
        <p className="text-xs">{t(item.mode === 'autorun' ? 'automation.continueWork' : item.mode === 'heartbeat' ? 'automation.heartbeat' : 'automation.schedule')} · {t('automation.instructionAttempts')}: {item.dispatchCount}</p>
        <AutomationReason reason={item.pauseReason} />
        {item.nextDueAt && <p>{t('automation.next')}: {localDue(item.nextDueAt)}</p>}
        {item.state === 'enabled' && <button {...telemetryClickAttributes('automation.pause', 'automation')} className={automationButton} onClick={() => void store.getState().pause(item.id)}>{t(sessionId ? 'automation.pause' : 'automation.schedulePause')}</button>}
      </article>)}
    </AutomationViewport>}
    {sessionId && !showSetup && <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} className={`${automationButton} shrink-0 self-start mx-4 my-2`} onClick={() => onOpenSession(sessionId)}>{t('automation.backSession')}</button>}
  </dialog>, document.body);
}
