'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import type { Automation } from '@/lib/automation/contracts';
import type { AutomationScope, AutomationStoreApi } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
import { AutomationForm, localDue } from './automation-form';
import { AutomationHistory, SavedSelection } from './automation-history';
import { AutomationError } from './automation-error';
import { useAutomationOwnership } from './use-automation';
import { automationButton } from './ownership-actions';

export function AutomationManager({ scope, store, onClose, onOpenSession, supported = true }: {
  scope: AutomationScope;
  store: AutomationStoreApi;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  supported?: boolean;
}) {
  const { t } = useI18n();
  const { items, loading, error, busy, runs } = useStore(store);
  const [edit, setEdit] = useState<Automation | 'new' | null>(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const ownership = useAutomationOwnership('sessionId' in scope ? scope.sessionId : '');
  const locked = 'sessionId' in scope && ownership.mode !== 'human';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!historyId) return;
    void store.getState().loadRuns(historyId);
    const timer = setInterval(() => void store.getState().loadRuns(historyId), 5000);
    return () => clearInterval(timer);
  }, [historyId, store]);
  const visible = items.filter(rule => includeDeleted || rule.state !== 'deleted');
  return createPortal(<dialog ref={dialog} aria-label={t('automation.title')} className="m-auto max-h-[90dvh] w-[min(94vw,42rem)] overflow-auto rounded-xl border border-(--divider) bg-(--chat-bg) p-5 text-(--text-primary) shadow-xl backdrop:bg-black/50"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
    onClick={event => event.stopPropagation()}>
    <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">{t('automation.title')}</h2><button type="button" className={automationButton} onClick={onClose}>{t('automation.close')}</button></div>
    <p className="mb-3 text-xs text-(--text-muted)">{t('automation.local')}</p>
    {'sessionId' in scope && <p className="mb-3 text-xs">{t('automation.safety')}</p>}
    <AutomationError code={error} />
    {edit ? <>
      <p className="my-3 text-xs">{t('automation.pausedEdit')}</p>
      <AutomationForm key={edit === 'new' ? 'new' : `${edit.id}:${edit.revision}`} scope={scope} previous={edit === 'new' ? undefined : edit} onSave={store.getState().save} onCancel={() => setEdit(null)} />
    </> : <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        {supported ? <button className={automationButton} type="button" disabled={busy > 0} onClick={() => setEdit('new')}>{t('automation.new')}</button> : <p>{t('automation.unsupported')}</p>}
        <label className="text-xs"><input type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} /> {t('automation.deleted')}</label>
        <button className={automationButton} type="button" onClick={() => { store.setState({ error: null }); void store.getState().refresh(); }}>{t('automation.retry')}</button>
      </div>
      {loading && <p role="status">{t('automation.loading')}</p>}
      {!loading && !error && visible.length === 0 && <p>{t('automation.empty')}</p>}
      <div className="grid gap-4">{visible.map(rule => <article key={rule.id} className="grid gap-2 rounded border border-(--divider) p-3">
        <h3 className="font-medium">{rule.name}</h3>
        <p className="text-xs">{t('automation.state')}: {rule.state} · {t('automation.count')}: {rule.dispatchCount}/{rule.limits.maxDispatches}</p>
        <p className="text-xs">{t('automation.expiry')}: {localDue(rule.limits.expiresAt)}</p>
        <p className="text-xs">{rule.nextDueAt !== null ? `${t('automation.next')}: ${localDue(rule.nextDueAt)}` : rule.state === 'enabled' && rule.trigger.kind === 'turn-complete' ? t('automation.waiting') : t('automation.notScheduled')}</p>
        <p className="text-xs">{t('automation.trigger')}: {rule.trigger.kind === 'turn-complete' ? `${t('automation.delay')}: ${rule.trigger.delayMs / 1000}` : rule.trigger.kind === 'once' ? `${t('automation.once')}: ${localDue(rule.trigger.at)}` : `${t('automation.every')}: ${rule.trigger.everyMs / 60000} · ${localDue(rule.trigger.anchorAt)}`}</p>
        {rule.pauseReason && <p className="text-xs">{t('automation.reason')}: {rule.pauseReason}</p>}
        <SavedSelection selection={rule.savedSelection} />
        <div className="flex flex-wrap gap-2">
          {rule.state !== 'deleted' && <>
            {rule.state !== 'enabled' && <button className={automationButton} type="button" disabled={busy > 0} onClick={() => void store.getState().enable(rule)}>{t('automation.arm')}</button>}
            <button className={automationButton} type="button" onClick={() => void store.getState().pause(rule.id)}>{t('automation.pause')}</button>
            <button className={automationButton} type="button" onClick={() => void store.getState().remove(rule.id)}>{t('automation.delete')}</button>
            <button className={automationButton} type="button" disabled={rule.state === 'enabled' || locked || busy > 0} onClick={async () => {
              const current = await store.getState().inspect(rule.id);
              if (!current) return;
              if (current.automation.state === 'enabled' || current.automation.state === 'deleted' || current.inFlightRunId || (current.inputOwnership && current.inputOwnership.mode !== 'human')) {
                store.setState({ error: 'PAUSE_REQUIRED' }); return;
              }
              setEdit(current.automation);
            }}>{t('automation.edit')}</button>
          </>}
          <button className={automationButton} type="button" aria-expanded={historyId === rule.id} onClick={() => setHistoryId(historyId === rule.id ? null : rule.id)}>{t('automation.history')}</button>
        </div>
        {historyId === rule.id && <>
          {!runs[rule.id] ? <p role="status">{t('automation.loading')}</p> : <AutomationHistory runs={runs[rule.id].items} onResolve={runId => void store.getState().resolve(rule.id, runId)} onOpenSession={onOpenSession} />}
          {runs[rule.id]?.nextCursor && <button className={automationButton} type="button" onClick={() => void store.getState().loadRuns(rule.id, true)}>{t('automation.more')}</button>}
        </>}
      </article>)}</div>
    </>}
  </dialog>, document.body);
}
