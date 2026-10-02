'use client';
import { useEffect, useState } from 'react';
import type { AutorunPreview, AutomationV2 } from '@/lib/automation/autorun-contracts';
import { sameSupervisorSelection } from '@/lib/automation/autorun-contracts';
import type { AutomationStoreApi } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { AutorunPreviewView, autorunCanStart } from './autorun-setup';
import { automationButton } from './ownership-actions';
import { localDue } from './automation-form';
import { useAutomationOwnership } from './use-automation';
import { SavedSelection } from './automation-history';
export function ContinuationResume({ preview, loading, rule, store, onDone, onOpenSession, onEdit }: {
  preview: AutorunPreview | null; loading: boolean; rule: AutomationV2; store: AutomationStoreApi;
  onDone: (id: string) => void; onOpenSession: () => void; onEdit: () => void;
}) {
  const { t } = useI18n();
  const ownership = useAutomationOwnership(rule.target.kind === 'wake-session' ? rule.target.sessionId : '');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const counts = rule.dispatchCount < rule.limits.maxDispatches && rule.limits.expiresAt > now;
  const ready = !loading && counts && ownership.mode === 'human' && (rule.mode !== 'autorun'
    ? preview?.readiness.kind !== 'idle'
    : Boolean(preview && rule.analysisCount < rule.autorun.maxAnalyses && autorunCanStart(preview, rule.autorun.supervisor,
      rule.autorun.objective.kind === 'explicit' ? rule.autorun.objective.text : '', rule.limits.expiresAt, now)));
  return <section className="grid gap-3">
    {loading && <p role="status">{t('automation.checking')}</p>}
    {preview && rule.mode === 'autorun' && <AutorunPreviewView preview={preview} objectiveOverride={rule.autorun.objective.kind === 'explicit' ? rule.autorun.objective.text : ''} onObjective={onEdit} onOpenSession={onOpenSession} />}
    {rule.mode !== 'autorun' && <><p>{t('automation.fixedHelp')}</p>{preview?.readiness.kind === 'idle' && <><p>{t('automation.idleFresh')}</p><button {...telemetryClickAttributes('automation.history.open_session','automation')} className={automationButton} onClick={onOpenSession}>{t('automation.writeInstruction')}</button></>}</>}
    {rule.mode === 'autorun' ? <>
      <p className="whitespace-pre-wrap">{rule.autorun.objective.text}</p>
      <p>{t('automation.supervisor')}: {rule.autorun.supervisor.provider} · {rule.autorun.supervisor.model} · {rule.autorun.supervisor.reasoningEffort} · {rule.autorun.supervisor.serviceTier}</p>
      {preview && !preview.supervisorOptions.some(o => o.available && sameSupervisorSelection(o.selection, rule.autorun.supervisor)) && <p>{t('automation.reasonSupervisor')}</p>}
      <p>{t('automation.analysisAttempts')}: {rule.analysisCount}/{rule.autorun.maxAnalyses}</p>
    </> : <p className="whitespace-pre-wrap">{rule.prompt}</p>}
    <SavedSelection selection={rule.savedSelection} />
    <p>{t('automation.instructionAttempts')}: {rule.dispatchCount}/{rule.limits.maxDispatches} · {localDue(rule.limits.expiresAt)}</p>
    <button {...telemetryClickAttributes('automation.manager.enable', 'automation')} className={automationButton} type="button" disabled={!ready || store.getState().busy > 0} onClick={async () => { if (await store.getState().enable(rule)) onDone(rule.id); }}>{t('automation.resume')}</button>
    <button {...telemetryClickAttributes('automation.manager.edit', 'automation')} className={automationButton} type="button" onClick={onEdit}>{t('automation.edit')}</button>
    <button {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} className={automationButton} type="button" onClick={() => void store.getState().previewAutorun()}>{t('automation.checkAgain')}</button>
  </section>;
}
