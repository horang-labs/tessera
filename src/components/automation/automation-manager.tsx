'use client';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import type { AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
import { AutomationForm, localDue } from './automation-form';
import { AutomationHistory, SavedSelection } from './automation-history';
import { AutomationError } from './automation-error';
import { AutomationReason } from './automation-reason';
import { useAutomationOwnership } from './use-automation';
import { automationButton } from './ownership-actions';
import { ContinuationResume, heartbeatCanResume } from './continuation-resume';
import { AutorunSetup } from './autorun-setup';
import { AutorunHistory, AutorunEvidence } from './autorun-history';
import { useAutomationContext } from './automation-context';

type SetupIntent = 'start' | 'resume' | 'edit' | 'replace';
export function AutomationManager({ scope, store, onClose, onOpenSession, supported = true, initialId, initialResume = false }: {
  scope: AutomationScope; store: AutomationStoreApi; onClose: () => void; onOpenSession: (id: string) => void; supported?: boolean; initialId?: string; initialResume?: boolean;
}) {
  const { t } = useI18n();
  const state = useStore(store);
  const { items, loading, error, busy, runs, details, decisions, decisionDetails, preview, previewLoading, view } = state;
  const sessionId = 'sessionId' in scope ? scope.sessionId : '';
  const context = useAutomationContext(scope);
  const ownership = useAutomationOwnership(sessionId);
  const [intent, setIntent] = useState<SetupIntent>(initialResume ? 'resume' : 'start');
  const [method, setMethod] = useState<'autorun' | 'heartbeat'>('autorun');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const rule = view.selectedId ? details[view.selectedId]?.automation : undefined;
  const updateView = (patch: Partial<typeof view>) => store.setState({ view: { ...store.getState().view, ...patch } });
  const select = (id: string) => { updateView({ selectedId: id, setup: false }); void store.getState().inspect(id); };
  const done = (id: string) => { select(id); setIntent('start'); };
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    if (initialId) {
      store.setState({ view: { ...store.getState().view, selectedId: initialId, setup: initialResume } });
      if (initialResume) void store.getState().previewAutorun();
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
  const previewPrevious = rule?.mode === 'autorun' ? rule : undefined;
  async function setup(nextIntent: SetupIntent, current?: AutomationV2) {
    setIntent(nextIntent); setEvidenceId(null);
    setMethod(nextIntent === 'replace' ? current?.mode === 'autorun' ? 'heartbeat' : 'autorun' : current?.mode === 'heartbeat' ? 'heartbeat' : 'autorun');
    updateView({ selectedId: current?.id ?? null, setup: true });
    if (sessionId) await store.getState().previewAutorun();
  }
  async function pauseAndEdit(current: AutomationV2, nextIntent: SetupIntent) {
    if (current.state === 'enabled' && !await store.getState().pause(current.id)) return;
    const receipt = await store.getState().inspect(current.id);
    if (!receipt || receipt.inFlightRunId || (receipt.inputOwnership && receipt.inputOwnership.mode !== 'human') || (sessionId && ownership.mode !== 'human')) {
      store.setState({ error: 'PAUSE_REQUIRED' }); return;
    }
    await setup(nextIntent, receipt.automation);
  }
  const emptySetup = !loading && items.filter(item => item.state !== 'deleted').length === 0 && !view.selectedId;
  const showSetup = view.setup || emptySetup;
  useEffect(() => {
    if (emptySetup && sessionId && !preview && !previewLoading && !error) void store.getState().previewAutorun();
  }, [emptySetup, sessionId, preview, previewLoading, error, store]);
  const visible = items.filter(item => includeDeleted || item.state !== 'deleted').sort((a,b) => {
    const priority = (item: typeof a) => item.attention ? 0 : item.state === 'enabled' ? 1 : 2;
    return priority(a)-priority(b);
  });
  const fixedDraftKey = `${sessionId ? 'heartbeat' : 'schedule'}:${view.selectedId ?? 'new'}:${intent}`;
  const retryAt = rule?.mode === 'autorun' ? decisions[rule.id]?.items[0]?.retryAt : null;
  const timing = rule?.nextDueAt ? `${t('automation.next')}: ${localDue(rule.nextDueAt)}`
    : retryAt ? `${t('automation.retryAt')}: ${localDue(retryAt)}` : rule?.mode === 'autorun' ? null : t('automation.notScheduled');
  const heldId = ownership.automationId ?? (rule && rule.state !== 'deleted' ? rule.id : null);
  return createPortal(<dialog {...telemetryIgnoreAttributes('event_boundary')} data-automation-dialog ref={dialog} aria-label={t('automation.title')}
    className="m-auto max-h-[94dvh] w-[min(96vw,42rem)] overflow-auto rounded-xl border border-(--divider) bg-(--chat-bg) p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-(--text-primary) shadow-xl backdrop:bg-black/50"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (evidenceId) setEvidenceId(null); else onClose(); }}
    onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <header className="sticky top-0 z-10 mb-4 flex flex-wrap items-center justify-between gap-2 bg-(--chat-bg) py-2">
      <div><h2 className="font-semibold">{context.title}</h2><p className="text-xs">{context.subtitle} · {t('automation.title')}</p></div>
      <button {...telemetryClickAttributes('automation.manager.close', 'automation')} className={automationButton} type="button" onClick={onClose}>{t('automation.close')}</button>
      {rule && rule.state !== 'deleted' && (showSetup || evidenceId) && <button {...telemetryClickAttributes('automation.delete','automation')} className={automationButton} type="button" onClick={() => setDeleteConfirm(true)}>{t('automation.delete')}</button>}
      {heldId && <button {...telemetryClickAttributes('automation.pause', 'automation')} className={automationButton} type="button" onClick={() => void store.getState().pause(heldId)}>{t(sessionId ? 'automation.pause' : 'automation.schedulePause')}</button>}
    </header>
    {(view.selectedId || view.setup || evidenceId) && <button {...telemetryClickAttributes('automation.manager.back', 'automation')} className={automationButton} type="button" onClick={() => { if (evidenceId) setEvidenceId(null); else { updateView({ setup: false, selectedId: null }); } }}>{t('automation.back')}</button>}
    <AutomationError code={error} />
    {deleteConfirm && rule && (showSetup || evidenceId) && <div role="alert"><p>{t('automation.deleteConfirm')}</p><button {...telemetryClickAttributes('automation.delete.confirm','automation')} className={automationButton} onClick={async () => { await store.getState().remove(rule.id); await store.getState().inspect(rule.id); setDeleteConfirm(false); }}>{t('automation.confirmDelete')}</button><button {...telemetryClickAttributes('automation.delete.cancel','automation')} className={automationButton} onClick={() => setDeleteConfirm(false)}>{t('automation.cancel')}</button></div>}
    {sessionId && <p role="status" className="my-2 text-xs">{t(`automation.${ownership.mode}`)}</p>}
    {showSetup ? <section className="grid gap-3">
      <p className="text-xs">{t('automation.local')}</p>{sessionId && <p className="text-xs">{t('automation.safety')}</p>}
      {!supported ? <p>{t('automation.unsupported')}</p> : <>
        {sessionId && intent === 'start' && <div className="flex flex-wrap gap-2">
          <button {...telemetryClickAttributes('automation.setup.autorun', 'automation')} className={automationButton} type="button" aria-pressed={method === 'autorun'} onClick={() => { setMethod('autorun'); if (!preview) void store.getState().previewAutorun(); }}>{t('automation.continueWork')}</button>
          <button {...telemetryClickAttributes('automation.setup.heartbeat', 'automation')} className={automationButton} type="button" aria-pressed={method === 'heartbeat'} onClick={() => setMethod('heartbeat')}>{t('automation.heartbeat')}</button>
        </div>}
        {intent === 'resume' && rule ? <ContinuationResume preview={preview} loading={previewLoading} rule={rule} store={store} onDone={done} onOpenSession={() => onOpenSession(sessionId)} onEdit={() => void setup('edit', rule)} /> : sessionId && method === 'autorun' ? <>
          {previewLoading && <p role="status">{t('automation.checking')}</p>}
          <button {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} className="min-h-9 max-sm:min-h-11 justify-self-start text-xs text-(--text-muted) underline hover:text-(--text-primary)" type="button" onClick={() => void store.getState().previewAutorun()}>{t('automation.checkAgain')}</button>
          {preview && <AutorunSetup key={`${preview.previewId}:${view.selectedId}:${intent}`} preview={preview} store={store} previous={intent === 'replace' ? rule : previewPrevious} intent={intent} defaultName={`${context.title} · Autorun`} onDone={done} onOpenSession={() => onOpenSession(sessionId)} />}
        </> : <>
          {sessionId && <p>{t('automation.fixedHelp')}</p>}
          <AutomationForm key={`${view.selectedId}:${intent}`} scope={scope} previous={intent === 'edit' && rule?.mode !== 'autorun' ? rule : undefined}
            defaultName={`${context.title} · ${sessionId ? 'Heartbeat' : t('automation.schedule')}`} replacing={intent === 'replace'} draft={state.drafts[fixedDraftKey]} onDraft={draft => store.setState(s => ({ drafts: { ...s.drafts, [fixedDraftKey]: draft } }))}
            onSave={async (input, previous) => {
              if (intent === 'replace' && rule) {
                if (!heartbeatCanResume(preview, previewLoading)) { store.setState({ error: 'INPUT_BOUNDARY_UNPROVEN' }); return false; }
                if (!await store.getState().remove(rule.id)) return false;
              }
              const success = await store.getState().save(input, previous);
              const id = store.getState().lastControl?.body.automation.id;
              if (success && id) done(id);
              return success;
            }} onCancel={() => updateView({ setup: false })} />
        </>}
      </>}
    </section> : rule ? <section className="grid gap-3">
      {evidenceId ? decisionDetails[evidenceId] ? <AutorunEvidence detail={decisionDetails[evidenceId]} onOpenSession={onOpenSession} /> : <p>{t('automation.loading')}</p> : <>
        <h3>{rule.name}</h3><p className="text-xs text-(--text-muted)">{t(rule.mode === 'autorun' ? 'automation.continueWork' : rule.mode === 'heartbeat' ? 'automation.heartbeat' : 'automation.schedule')}</p>
        <p role="status">{t(`automation.state_${rule.state}`)}{rule.mode === 'autorun' && ` · ${t(`automation.phase_${rule.autorunStatus}`)}`}</p>
        <AutomationReason reason={rule.pauseReason} />
        {rule.mode === 'autorun' && rule.attention && <p className="whitespace-pre-wrap">{rule.attention.summary}</p>}
        <p>{t('automation.instructionAttempts')}: {rule.dispatchCount}/{rule.limits.maxDispatches}{rule.mode === 'autorun' && ` · ${t('automation.analysisAttempts')}: ${rule.analysisCount}/${rule.autorun.maxAnalyses}`}</p>
        <p>{t('automation.expiry')}: {localDue(rule.limits.expiresAt)}</p>
        {timing && <p>{timing}</p>}
        <div className="flex flex-wrap gap-2">
          {rule.state !== 'deleted' && <>
            {rule.state !== 'enabled' && <button {...telemetryClickAttributes('automation.manager.enable', 'automation')} className={automationButton} disabled={busy > 0 || Boolean(sessionId && ownership.mode !== 'human')} onClick={() => { if (rule.mode === 'autorun') void setup('resume', rule); else if (sessionId) void setup('resume', rule); else void store.getState().enable(rule); }}>{t('automation.resume')}</button>}
            <button {...telemetryClickAttributes('automation.delete', 'automation')} className={automationButton} onClick={() => setDeleteConfirm(true)}>{t('automation.delete')}</button>
            {deleteConfirm && <div role="alert"><p>{t('automation.deleteConfirm')}</p><button {...telemetryClickAttributes('automation.delete.confirm', 'automation')} className={automationButton} onClick={async () => { await store.getState().remove(rule.id); await store.getState().inspect(rule.id); setDeleteConfirm(false); }}>{t('automation.confirmDelete')}</button><button {...telemetryClickAttributes('automation.delete.cancel', 'automation')} className={automationButton} onClick={() => setDeleteConfirm(false)}>{t('automation.cancel')}</button></div>}
            <details><summary {...telemetryClickAttributes('automation.manager.options', 'automation')}>{t('automation.manage')}</summary>
              <button {...telemetryClickAttributes('automation.manager.edit', 'automation')} className={automationButton} onClick={() => void pauseAndEdit(rule, 'edit')}>{t(rule.state === 'enabled' ? 'automation.pauseEdit' : 'automation.edit')}</button>
              {sessionId && <button {...telemetryClickAttributes('automation.manager.method', 'automation')} className={automationButton} onClick={() => void pauseAndEdit(rule, 'replace')}>{t('automation.changeMethod')}</button>}
            </details>
          </>}
        </div>
        <div className="flex gap-2" role="tablist"><button {...telemetryClickAttributes('automation.manager.overview', 'automation')} role="tab" aria-selected={view.tab === 'overview'} className={automationButton} onClick={() => updateView({ tab: 'overview' })}>{t('automation.overview')}</button><button {...telemetryClickAttributes('automation.manager.history', 'automation')} role="tab" aria-selected={view.tab === 'history'} className={automationButton} onClick={() => updateView({ tab: 'history' })}>{t('automation.history')}</button></div>
        {view.tab === 'overview' && <details><summary {...telemetryClickAttributes('automation.manager.configuration', 'automation')}>{t('automation.configuration')}</summary>
          {rule.mode === 'autorun' ? <><p className="whitespace-pre-wrap">{rule.autorun.objective.text}</p><p>{t(rule.autorun.objective.kind === 'verified-human' ? 'automation.verifiedGoal' : 'automation.explicitGoal')}</p><p>{rule.autorun.supervisor.provider} · {rule.autorun.supervisor.model}</p></> : <p className="whitespace-pre-wrap">{rule.prompt}</p>}
          <SavedSelection selection={rule.savedSelection} />
        </details>}
        {rule.mode === 'autorun' && state.newDecisionCount[rule.id] > 0 && <button {...telemetryClickAttributes('automation.history.new', 'automation')} className={automationButton} onClick={() => store.getState().showNewDecisions(rule.id)}>{state.newDecisionCount[rule.id]} {t('automation.newEntries')}</button>}
        {rule.mode === 'autorun' ? <AutorunHistory details={decisionDetails} onResolve={id => void store.getState().resolve(rule.id,id)} onOpenSession={onOpenSession} decisions={(decisions[rule.id]?.items ?? []).slice(0, view.tab === 'overview' ? 3 : undefined)} onEvidence={id => { setEvidenceId(id); void store.getState().inspectDecision(rule.id,id); }} /> : <AutomationHistory runs={(runs[rule.id]?.items ?? []).slice(0, view.tab === 'overview' ? 3 : undefined)} onResolve={id => void store.getState().resolve(rule.id,id)} onOpenSession={onOpenSession} />}
        {view.tab === 'history' && (rule.mode === 'autorun' ? decisions[rule.id]?.nextCursor : runs[rule.id]?.nextCursor) && <button {...telemetryClickAttributes('automation.manager.more', 'automation')} className={automationButton} onClick={() => void (rule.mode === 'autorun' ? store.getState().loadDecisions(rule.id,true) : store.getState().loadRuns(rule.id,true))}>{t('automation.more')}</button>}
      </>}
    </section> : <>
      <div className="my-4 flex flex-wrap gap-3"><button {...telemetryClickAttributes('automation.manager.new', 'automation')} className={automationButton} onClick={() => void setup('start')}>{t('automation.new')}</button><label><input {...telemetryClickAttributes('automation.manager.include_deleted', 'automation')} type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} />{t('automation.deleted')}</label><button {...telemetryClickAttributes('automation.manager.refresh', 'automation')} className={automationButton} onClick={() => void store.getState().refresh()}>{t('automation.retry')}</button></div>
      {loading && <p role="status">{t('automation.loading')}</p>}
      {visible.map((item,index) => <article className="grid gap-2 rounded border border-(--divider) p-3 my-2" key={item.id}>
        {(index === 0 || Boolean(visible[index-1].attention) !== Boolean(item.attention) || (visible[index-1].state === 'enabled') !== (item.state === 'enabled')) && <h3>{t(item.attention ? 'automation.needsAttention' : item.state === 'enabled' ? 'automation.activeGroup' : 'automation.endedGroup')}</h3>}
        <button {...telemetryClickAttributes('automation.manager.detail', 'automation')} className={`${automationButton} text-left`} onClick={() => select(item.id)}>{item.name} · {t(`automation.state_${item.state}`)}</button>
        <p className="text-xs">{t(item.mode === 'autorun' ? 'automation.continueWork' : item.mode === 'heartbeat' ? 'automation.heartbeat' : 'automation.schedule')} · {t('automation.instructionAttempts')}: {item.dispatchCount}</p>
        <AutomationReason reason={item.pauseReason} />
        {item.nextDueAt && <p>{t('automation.next')}: {localDue(item.nextDueAt)}</p>}
        {item.state === 'enabled' && <button {...telemetryClickAttributes('automation.pause', 'automation')} className={automationButton} onClick={() => void store.getState().pause(item.id)}>{t(sessionId ? 'automation.pause' : 'automation.schedulePause')}</button>}
      </article>)}
    </>}
    {sessionId && <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} className={`${automationButton} mt-4`} onClick={() => onOpenSession(sessionId)}>{t('automation.backSession')}</button>}
  </dialog>, document.body);
}
