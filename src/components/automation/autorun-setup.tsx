'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { sameSupervisorSelection, validateAutomationInputV2, type AutorunPreview, type AutorunInput, type SupervisorSelection, type AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { AutomationStoreApi } from '@/stores/automation-store';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { automationButton, automationPrimaryButton } from './ownership-actions';
import { localDateInput, localDue } from './automation-form';
import { SavedSelection } from './automation-history';

export function AutorunPreviewView({ preview, objectiveOverride, onObjective, onOpenSession }: {
  preview: AutorunPreview; objectiveOverride: string; onObjective: (text: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(!preview.objective || Boolean(objectiveOverride));
  return <section className="grid gap-3">
    <p className="text-sm">{t('automation.goal')} · {t(objectiveOverride.trim() || preview.objective?.kind === 'explicit' ? 'automation.explicitGoal' : preview.objective?.kind === 'verified-human' ? 'automation.verifiedGoal' : 'automation.unverifiedGoal')}</p>
    {preview.objective ? <>
      <p className="whitespace-pre-wrap line-clamp-3">{objectiveOverride.trim() || preview.objective.text}</p>
      <details><summary {...telemetryClickAttributes('automation.autorun.sources', 'automation')}>{t('automation.viewSource')}</summary>
        <p className="whitespace-pre-wrap break-words">{objectiveOverride.trim() || preview.objective.text}</p>
        {preview.objective.kind === 'verified-human' && preview.objective.sources.map(source => <blockquote key={source.recordId} className="whitespace-pre-wrap border-l pl-2">{source.excerpt}</blockquote>)}
      </details>
    </> : <p>{t('automation.goalMissing')}</p>}
    <button {...telemetryClickAttributes('automation.autorun.objective_edit', 'automation')} type="button" className={automationButton} onClick={() => setEditing(!editing)}>{t('automation.edit')}</button>
    {editing && <label className="grid gap-1 text-sm">{t('automation.edit')} · {t('automation.explicitGoal')}<textarea {...telemetryIgnoreAttributes('non_action')} name="objective" className="rounded border border-(--divider) p-2" rows={3} value={objectiveOverride} onChange={e => onObjective(e.target.value)} /></label>}
    {preview.newHumanInstructions.length > 0 && <section><h4>{t('automation.newInstructions')}</h4>{preview.newHumanInstructions.map(source => <blockquote className="whitespace-pre-wrap" key={source.recordId}>{source.excerpt}</blockquote>)}</section>}
    <p>{preview.criterionOrigin === 'system-objective' ? t('automation.criterionDefault') : preview.criteria.map(c => c.text).join(' · ')}</p>
    <p role="status">{t(preview.readiness.kind === 'idle' ? 'automation.idleFresh' : preview.readiness.kind === 'unavailable' ? 'automation.contextMissing' : preview.readiness.kind === 'running' ? 'automation.runningReady' : 'automation.completedReady')}</p>
    {preview.readiness.kind === 'unavailable' && <details><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')}>{t('automation.diagnostics')}</summary>{preview.readiness.code} · {preview.readiness.reason}</details>}
    {['idle', 'unavailable'].includes(preview.readiness.kind) && <button {...telemetryClickAttributes('automation.history.open_session', 'automation')} type="button" className={automationButton} onClick={onOpenSession}>{t(preview.readiness.kind === 'idle' ? 'automation.writeInstruction' : 'automation.openSession')}</button>}
  </section>;
}

export function autorunCanStart(preview: AutorunPreview, selection: SupervisorSelection | null, objective: string, expiresAt: number, now: number) {
  return ['completed', 'running'].includes(preview.readiness.kind) && Boolean(objective.trim() || preview.objective)
    && selection !== null && preview.supervisorOptions.some(option => option.available && sameSupervisorSelection(option.selection, selection))
    && preview.remaining.dispatches > 0 && preview.remaining.analyses > 0 && expiresAt > now;
}

export function AutorunSetup({ preview, store, previous, intent = 'start', onDone, onOpenSession, defaultName }: {
  preview: AutorunPreview; store: AutomationStoreApi; previous?: AutomationV2;
  defaultName?: string; intent?: 'start' | 'resume' | 'edit' | 'replace'; onDone: (id: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const old = previous?.mode === 'autorun' ? previous : undefined;
  const draftKey = old ? `${old.id}:${intent}` : 'autorun:new';
  const draftFields = (store.getState().drafts[`${draftKey}:fields`] ?? {}) as Record<string, string>;
  const draft = store.getState().drafts[draftKey] as Partial<AutorunInput> | undefined;
  const [override, setOverride] = useState(draftFields.objective ?? (draft?.autorun?.objective.kind === 'explicit' ? draft.autorun.objective.text : old?.autorun.objective.kind === 'explicit' ? old.autorun.objective.text : ''));
  const selection = chooseAutorunSupervisor(preview, old?.autorun.supervisor ?? draft?.autorun?.supervisor);
  const [supervisor, setSupervisor] = useState<SupervisorSelection | null>(selection);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [expiresAt, setExpiresAt] = useState(old?.limits.expiresAt ?? draft?.limits?.expiresAt ?? preview.defaults.expiresAt);
  const options = preview.supervisorOptions.filter(option => option.available);
  const selectedIndex = options.findIndex(option => supervisor && sameSupervisorSelection(option.selection, supervisor));
  const confirmedSelection = selectedIndex >= 0 ? supervisor : null;
  const ready = autorunCanStart(preview, confirmedSelection, override, expiresAt, now);
  const saveDraft = (text: string) => {
    setOverride(text);
    store.setState(state => ({ drafts: { ...state.drafts, [draftKey]: { ...draft, autorun: { objective: { kind: 'explicit', text }, supervisor } } } }));
  };
  return <form className="grid gap-4" onChange={event => {
    const fields = Object.fromEntries([...new FormData(event.currentTarget)].map(([key,value]) => [key, String(value)]));
    store.setState(state => ({ drafts: { ...state.drafts, [`${draftKey}:fields`]: fields } }));
  }} onSubmit={async event => {
    event.preventDefault();
    if (!confirmedSelection) { setInvalid(true); return; }
    const fields = new FormData(event.currentTarget);
    const lines = (name: string) => String(fields.get(name) ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    const constraints = lines('constraints');
    const criterionLines = lines('criteria');
    const input: AutorunInput = { version: 2, mode: 'autorun', name: String(fields.get('name') ?? old?.name ?? defaultName ?? t('automation.continueWork')), enabled: intent !== 'edit' && (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'yes',
      target: { kind: 'wake-session', sessionId: preview.sessionId }, trigger: { kind: 'turn-complete', delayMs: Number(fields.get('delay')) * 1000 },
      limits: { maxDispatches: Number(fields.get('max')), expiresAt: new Date(String(fields.get('expiry'))).getTime() },
      autorun: { objective: override.trim() ? { kind: 'explicit', text: override } : { kind: 'preview', previewId: preview.previewId, goalRevision: preview.goalRevision },
        constraints, criteria: criterionLines.length ? criterionLines.map((text, i) => ({ id: `criterion-${i+1}`, text })) : preview.criteria,
        supervisor: confirmedSelection, maxAnalyses: Number(fields.get('analyses')), analysisTimeoutMs: Number(fields.get('timeout')) * 1000 } };
    store.setState(state => ({ drafts: { ...state.drafts, [draftKey]: input } }));
    const valid = validateAutomationInputV2(input, { now: Date.now() });
    if (!valid.success || (input.enabled && !autorunCanStart(preview, confirmedSelection, override, input.limits.expiresAt, Date.now()))) { setInvalid(true); return; }
    setSaving(true); setInvalid(false);
    try {
      if (intent === 'replace' && previous && !await store.getState().remove(previous.id)) return;
      if (await store.getState().save(input, intent === 'edit' ? old : undefined)) {
        const id = store.getState().lastControl?.body.automation.id;
        if (id) onDone(id);
      }
    } finally { setSaving(false); }
  }}>
    <AutorunPreviewView preview={preview} objectiveOverride={override} onObjective={saveDraft} onOpenSession={onOpenSession} />
    <details><summary {...telemetryClickAttributes('automation.autorun.criteria', 'automation')}>{t('automation.optionalCriteria')}</summary>
      <label className="grid gap-1">{t('automation.constraints')}<textarea {...telemetryIgnoreAttributes('non_action')} name="constraints" rows={2} defaultValue={draftFields.constraints ?? (draft?.autorun?.constraints ?? old?.autorun.constraints ?? preview.constraints).join('\n')} /></label>
      <label className="grid gap-1">{t('automation.criteria')}<textarea {...telemetryIgnoreAttributes('non_action')} name="criteria" rows={2} defaultValue={draftFields.criteria ?? (draft?.autorun?.criteria ?? old?.autorun.criteria ?? (preview.criterionOrigin === 'system-objective' ? [] : preview.criteria)).map(c => c.text).join('\n')} /></label>
    </details>
    <p className="break-words">{t('automation.supervisor')}: {supervisor ? `${supervisor.provider} · ${supervisor.model} · ${supervisor.reasoningEffort} · ${supervisor.serviceTier ?? ''}` : t('automation.unsupported')}</p>
    <p className="text-xs">{t('automation.supervisorHelp')}</p>
    <p>{t('automation.remaining')}: {t('automation.remainingDispatches')}: {preview.remaining.dispatches} · {t('automation.remainingAnalyses')}: {preview.remaining.analyses} · {t('automation.budgetExpiry')}: {Number.isFinite(expiresAt) ? localDue(expiresAt) : t('automation.invalid')}</p>
    <details><summary {...telemetryClickAttributes('automation.form.advanced', 'automation')}>{t('automation.advanced')}</summary><div className="grid gap-3">
      <SavedSelection selection={preview.workerSelection} />
      <label>{t('automation.supervisor')}<select {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')} className="w-full" value={selectedIndex} onChange={e => setSupervisor(options[Number(e.target.value)]?.selection ?? null)}><option value={-1}>{t('automation.choose')}</option>{options.map((option, i) => <option key={i} value={i}>{option.selection.provider} · {option.selection.model} · {option.selection.reasoningEffort} · {option.selection.serviceTier}</option>)}</select></label>
      <label>{t('automation.name')}<input {...telemetryIgnoreAttributes('non_action')} name="name" defaultValue={draftFields.name ?? draft?.name ?? old?.name ?? defaultName ?? t('automation.continueWork')} required maxLength={120} /></label>
      <label>{t('automation.delay')}<input {...telemetryClickAttributes('automation.form.delay', 'automation')} name="delay" type="number" min={30} max={86400} defaultValue={draftFields.delay ?? (old?.trigger.delayMs ?? preview.defaults.delayMs)/1000} /></label>
      <label>{t('automation.max')}<input {...telemetryClickAttributes('automation.form.max', 'automation')} name="max" type="number" min={1} max={100} defaultValue={draftFields.max ?? old?.limits.maxDispatches ?? preview.defaults.maxDispatches} /></label>
      <label>{t('automation.analysisMax')}<input {...telemetryClickAttributes('automation.autorun.analyses', 'automation')} name="analyses" type="number" min={1} max={100} defaultValue={draftFields.analyses ?? old?.autorun.maxAnalyses ?? preview.defaults.maxAnalyses} /></label>
      <label>{t('automation.analysisTimeout')}<input {...telemetryClickAttributes('automation.autorun.timeout', 'automation')} name="timeout" type="number" min={30} max={300} defaultValue={draftFields.timeout ?? (old?.autorun.analysisTimeoutMs ?? preview.defaults.analysisTimeoutMs)/1000} /></label>
      <label>{t('automation.expiry')}<input {...telemetryClickAttributes('automation.form.expiry', 'automation')} name="expiry" type="datetime-local" defaultValue={draftFields.expiry ?? localDateInput(expiresAt)} onChange={e => setExpiresAt(new Date(e.target.value).getTime())} /></label>
    </div></details>
    {intent === 'replace' && <p>{t('automation.replaceHelp')}</p>}
    {invalid && <p role="alert">{t('automation.invalid')}</p>}
    <div className="sticky bottom-0 flex flex-wrap gap-2 bg-(--chat-bg) py-2">
      <button {...telemetryClickAttributes('automation.autorun.start', 'automation')} className={automationPrimaryButton} type="submit" disabled={saving || (intent !== 'edit' && !ready)}>{t(intent === 'resume' ? 'automation.resume' : intent === 'edit' ? 'automation.saveChanges' : intent === 'replace' ? 'automation.replace' : 'automation.start')}</button>
      {intent === 'start' && <button {...telemetryClickAttributes('automation.form.save', 'automation')} className={automationButton} type="submit" name="saveLater" value="yes" disabled={saving || !confirmedSelection}>{t('automation.save')}</button>}
    </div>
  </form>;
}

export function chooseAutorunSupervisor(preview: AutorunPreview, saved?: SupervisorSelection): SupervisorSelection | null {
  if (saved) return saved;
  const worker = preview.workerSelection;
  if (worker.model && worker.reasoningEffort) {
    const option = preview.supervisorOptions.find(o => o.available && sameSupervisorSelection(o.selection, { provider: worker.provider, model: worker.model!, reasoningEffort: worker.reasoningEffort!, serviceTier: worker.serviceTier }));
    if (option && option.selection.serviceTier !== 'fast') return option.selection;
  }
  return preview.recommendedSupervisor;
}
