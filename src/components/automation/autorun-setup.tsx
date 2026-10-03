'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useI18n } from '@/lib/i18n';
import { sameSupervisorSelection, validateAutomationInputV2, type AutorunPreview, type AutorunInput, type SupervisorSelection, type AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { AutomationStoreApi } from '@/stores/automation-store';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { automationButton, automationPrimaryButton } from './ownership-actions';
import { localDateInput } from './automation-form';
import { SavedSelection } from './automation-history';
import { SupervisorPicker } from './supervisor-picker';
import { AutomationPreflight } from './automation-preflight';
import { AutomationField, AutomationFacts, AutomationTime, AutomationViewport, automationField, automationDisclosure, revealAutomationField } from './automation-layout';

export function AutorunPreviewView({ preview, objectiveOverride, objectiveEdited = Boolean(objectiveOverride.trim()), readOnly = false, onObjective }: {
  preview: AutorunPreview; objectiveOverride: string; objectiveEdited?: boolean; readOnly?: boolean; onObjective: (text: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const objective = objectiveEdited ? objectiveOverride : preview.objective?.text ?? '';
  const source = objectiveEdited || preview.objective?.kind === 'explicit' ? 'automation.explicitGoal' : preview.objective?.kind === 'verified-human' ? 'automation.verifiedGoal' : 'automation.unverifiedGoal';
  return <section className="grid gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('automation.goal')}</h3>
      {(preview.objective || (objectiveEdited && objective.trim())) && <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.autorun.sources', 'automation')} className="cursor-pointer">{t(source)}</summary>
        <div className="mt-2 grid gap-2"><p className="whitespace-pre-wrap break-words">{objective}</p>{!objectiveEdited && preview.objective?.kind === 'verified-human' && preview.objective.sources.map(source => <blockquote key={source.recordId} className="whitespace-pre-wrap border-l pl-2">{source.excerpt}</blockquote>)}</div>
      </details>}
    </div>
    {readOnly ? <><p className="whitespace-pre-wrap break-words">{objective}</p><button type="button" className={`${automationButton} justify-self-start`} {...telemetryClickAttributes('automation.autorun.objective_edit', 'automation')} onClick={() => onObjective(objective)}>{t('automation.edit')}</button></>
      : <textarea name="objective" aria-label={t('automation.goal')} required className={automationField} rows={3} value={objective} placeholder={t('automation.objectivePlaceholder')} {...telemetryIgnoreAttributes('non_action')} onChange={event => onObjective(event.target.value)} />}
    {preview.newHumanInstructions.length > 0 && <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.autorun.sources', 'automation')} className="cursor-pointer">{t('automation.newInstructionsCount', { count: preview.newHumanInstructions.length })}</summary>{preview.newHumanInstructions.map(source => <blockquote key={source.recordId} className="mt-2 whitespace-pre-wrap">{source.excerpt}</blockquote>)}</details>}
  </section>;
}

export function autorunCanStart(preview: AutorunPreview, selection: SupervisorSelection | null, objective: string, expiresAt: number, now: number) {
  return preview.supervisorCheck?.status === 'available' && selection !== null && preview.supervisorCheck.selection !== null && sameSupervisorSelection(preview.supervisorCheck.selection, selection)
    && ['completed', 'running'].includes(preview.readiness.kind) && Boolean(objective.trim() || preview.objective)
    && selection !== null && preview.supervisorOptions.some(option => option.available && sameSupervisorSelection(option.selection, selection))
    && preview.remaining.dispatches > 0 && preview.remaining.analyses > 0 && expiresAt > now;
}

export function AutorunSetup({ preview, store, previous, intent = 'start', onDone, onOpenSession, defaultName, intro, footnote }: {
  preview: AutorunPreview; store: AutomationStoreApi; previous?: AutomationV2;
  intro?: ReactNode; footnote?: ReactNode; defaultName?: string; intent?: 'start' | 'resume' | 'edit' | 'replace'; onDone: (id: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const old = previous?.mode === 'autorun' ? previous : undefined;
  const draftKey = old ? `${old.id}:${intent}` : 'autorun:new';
  const draftFields = (store.getState().drafts[`${draftKey}:fields`] ?? {}) as Record<string, string>;
  const draft = store.getState().drafts[draftKey] as Partial<AutorunInput> | undefined;
  const [objectiveEdited, setObjectiveEdited] = useState(Boolean(draftFields.objectiveEdited === 'yes' || (draftFields.objectiveEdited !== 'no' && draftFields.objective !== undefined) || draft?.autorun?.objective?.kind === 'explicit' || old?.autorun.objective.kind === 'explicit'));
  const [override, setOverride] = useState((draftFields.objectiveEdited !== 'no' ? draftFields.objective : undefined) ?? (draft?.autorun?.objective?.kind === 'explicit' ? draft.autorun.objective.text : old?.autorun.objective.kind === 'explicit' ? old.autorun.objective.text : ''));
  const savedSupervisorDraft = store.getState().drafts[`${draftKey}:supervisor`] as Partial<SupervisorSelection> | undefined;
  const selection = savedSupervisorDraft ? savedSupervisorDraft.provider && savedSupervisorDraft.model && savedSupervisorDraft.reasoningEffort ? savedSupervisorDraft as SupervisorSelection : null : chooseAutorunSupervisor(preview, draft?.autorun?.supervisor ?? old?.autorun.supervisor);
  const [supervisor, setSupervisor] = useState<SupervisorSelection | null>(selection);
  const [supervisorDraft, setSupervisorDraft] = useState<Partial<SupervisorSelection>>(savedSupervisorDraft ?? selection ?? { provider: 'codex', model: '', reasoningEffort: '', serviceTier: 'default' });
  const { previewLoading, previewError } = useStore(store);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [fieldsSummary, setFieldsSummary] = useState(draftFields);
  const [expiresAt, setExpiresAt] = useState(draftFields.expiry ? new Date(draftFields.expiry).getTime() : old?.limits.expiresAt ?? draft?.limits?.expiresAt ?? preview.defaults.expiresAt);
  const confirmedSelection = !previewLoading && !previewError && supervisor && preview.supervisorCheck?.status === 'available' && preview.supervisorCheck.selection && sameSupervisorSelection(supervisor, preview.supervisorCheck.selection) && preview.supervisorOptions.some(option => option.available && sameSupervisorSelection(option.selection, supervisor)) ? supervisor : null;
  const ready = Boolean(confirmedSelection && (!objectiveEdited || override.trim()) && autorunCanStart(preview, confirmedSelection, override, expiresAt, now));
  const retry = () => void store.getState().previewAutorun(supervisor ? { supervisor } : {});
  const changeSupervisor = (value: Partial<SupervisorSelection>) => {
    setSupervisorDraft(value);
    const selected = value.provider && value.model && value.reasoningEffort ? value as SupervisorSelection : null;
    setSupervisor(selected);
    store.setState(state => ({ drafts: { ...state.drafts, [`${draftKey}:supervisor`]: value } }));
    if (selected) void store.getState().previewAutorun({ supervisor: selected });
  };
  const saveDraft = (text: string) => {
    setOverride(text); setObjectiveEdited(true);
    store.setState(state => ({ drafts: { ...state.drafts, [draftKey]: { ...draft, autorun: { objective: { kind: 'explicit', text }, supervisor } } } }));
  };
  return <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onInvalidCapture={revealAutomationField} onChange={event => {
    const fields = { ...Object.fromEntries([...new FormData(event.currentTarget)].map(([key,value]) => [key, String(value)])), objectiveEdited: objectiveEdited || (event.target instanceof HTMLTextAreaElement && event.target.name === 'objective') ? 'yes' : 'no' };
    setFieldsSummary(fields);
    store.setState(state => ({ drafts: { ...state.drafts, [`${draftKey}:fields`]: fields } }));
  }} onSubmit={async event => {
    event.preventDefault();
    if (!confirmedSelection || (objectiveEdited && !override.trim())) { setInvalid(true); return; }
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
    <AutomationViewport footerNote={<>
      <AutomationPreflight loading={previewLoading} error={previewError} onRetry={retry} />
      {!previewLoading && !previewError && !ready && (preview.readiness.kind === 'idle' || preview.readiness.kind === 'unavailable') ? <div className="flex flex-wrap items-center gap-2"><p>{t(preview.readiness.kind === 'idle' ? 'automation.idleFresh' : 'automation.contextMissing')}</p><button type="button" className={automationButton} {...telemetryClickAttributes('automation.history.open_session', 'automation')} onClick={onOpenSession}>{t(preview.readiness.kind === 'idle' ? 'automation.writeInstruction' : 'automation.openSession')}</button></div>
        : !previewLoading && !previewError && !confirmedSelection ? <p>{t(supervisor ? 'automation.supervisorUnavailable' : 'automation.chooseSupervisor')}</p> : !previewLoading && !previewError && (expiresAt <= now || preview.remaining.dispatches <= 0 || preview.remaining.analyses <= 0) ? <p>{t('automation.reasonLimit')}</p> : null}
    </>} footer={<>

      <button {...telemetryClickAttributes('automation.autorun.start', 'automation')} className={automationPrimaryButton} type="submit" disabled={saving || !confirmedSelection || (objectiveEdited && !override.trim()) || (intent !== 'edit' && !ready)}>{t(intent === 'resume' ? 'automation.resume' : intent === 'edit' ? 'automation.saveChanges' : intent === 'replace' ? 'automation.replace' : 'automation.start')}</button>
      {intent === 'start' && <button {...telemetryClickAttributes('automation.form.save', 'automation')} className={automationButton} type="submit" name="saveLater" value="yes" disabled={saving || !confirmedSelection}>{t('automation.save')}</button>}

    </>}>
    {intro}
    <AutorunPreviewView preview={preview} objectiveOverride={override} objectiveEdited={objectiveEdited} onObjective={saveDraft} onOpenSession={onOpenSession} />
    <SupervisorPicker candidates={preview.supervisorDiscovery?.candidates ?? []} value={supervisorDraft} onChange={changeSupervisor} />
    <details className={automationDisclosure} open={invalid}><summary {...telemetryClickAttributes('automation.form.advanced', 'automation')}>{t('automation.optionsLimits')} <span className="font-normal text-xs">· {t('automation.limitsSummary', { seconds: fieldsSummary.delay ?? (old?.trigger.delayMs ?? preview.defaults.delayMs)/1000, max: fieldsSummary.max ?? old?.limits.maxDispatches ?? preview.defaults.maxDispatches })}</span></summary><div className="grid gap-3 sm:grid-cols-2">
      <AutomationField className="sm:col-span-2" label={t('automation.constraints')}><textarea className={automationField} {...telemetryIgnoreAttributes('non_action')} name="constraints" rows={2} defaultValue={draftFields.constraints ?? (draft?.autorun?.constraints ?? old?.autorun.constraints ?? preview.constraints).join('\n')} /></AutomationField>
      <AutomationField className="sm:col-span-2" label={t('automation.criteria')}><textarea className={automationField} {...telemetryIgnoreAttributes('non_action')} name="criteria" rows={2} defaultValue={draftFields.criteria ?? (draft?.autorun?.criteria ?? old?.autorun.criteria ?? (preview.criterionOrigin === 'system-objective' ? [] : preview.criteria)).map(c => c.text).join('\n')} /></AutomationField>
      <div className="sm:col-span-2"><h4 className="mb-2 text-xs">{t('automation.remaining')}</h4><AutomationFacts items={[{ label: t('automation.remainingDispatches'), value: preview.remaining.dispatches }, { label: t('automation.remainingAnalyses'), value: preview.remaining.analyses }, { label: t('automation.budgetExpiry'), value: <AutomationTime at={expiresAt} /> }]} /></div>
      <details className={`${automationDisclosure} sm:col-span-2`}><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')}>{t('automation.diagnostics')}</summary><SavedSelection selection={preview.workerSelection} />{preview.readiness.kind === 'unavailable' && <p>{preview.readiness.code} · {preview.readiness.reason}</p>}<button type="button" className={automationButton} disabled={previewLoading} {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} onClick={retry}>{t('automation.checkAgain')}</button></details>
      <AutomationField className="sm:col-span-2" label={t('automation.name')}><input className={automationField} {...telemetryIgnoreAttributes('non_action')} name="name" defaultValue={draftFields.name ?? draft?.name ?? old?.name ?? defaultName ?? t('automation.continueWork')} required maxLength={120} /></AutomationField>
      <AutomationField label={t('automation.delay')}><input className={automationField} {...telemetryClickAttributes('automation.form.delay', 'automation')} name="delay" type="number" min={30} max={86400} defaultValue={draftFields.delay ?? (old?.trigger.delayMs ?? preview.defaults.delayMs)/1000} /></AutomationField>
      <AutomationField label={t('automation.max')}><input className={automationField} {...telemetryClickAttributes('automation.form.max', 'automation')} name="max" type="number" min={1} max={100} defaultValue={draftFields.max ?? old?.limits.maxDispatches ?? preview.defaults.maxDispatches} /></AutomationField>
      <AutomationField label={t('automation.analysisMax')}><input className={automationField} {...telemetryClickAttributes('automation.autorun.analyses', 'automation')} name="analyses" type="number" min={1} max={100} defaultValue={draftFields.analyses ?? old?.autorun.maxAnalyses ?? preview.defaults.maxAnalyses} /></AutomationField>
      <AutomationField label={t('automation.analysisTimeout')}><input className={automationField} {...telemetryClickAttributes('automation.autorun.timeout', 'automation')} name="timeout" type="number" min={30} max={300} defaultValue={draftFields.timeout ?? (old?.autorun.analysisTimeoutMs ?? preview.defaults.analysisTimeoutMs)/1000} /></AutomationField>
      <AutomationField className="sm:col-span-2" label={t('automation.expiry')}><input className={automationField} {...telemetryClickAttributes('automation.form.expiry', 'automation')} name="expiry" type="datetime-local" defaultValue={draftFields.expiry ?? localDateInput(expiresAt)} onChange={e => setExpiresAt(new Date(e.target.value).getTime())} /></AutomationField>
    </div></details>
    {intent === 'replace' && <p>{t('automation.replaceHelp')}</p>}
    {invalid && <p role="alert">{t('automation.invalid')}</p>}

    {footnote && <div className="grid gap-1 text-xs text-(--text-secondary)">{footnote}</div>}
    </AutomationViewport>
  </form>;
}

export function chooseAutorunSupervisor(preview: AutorunPreview, saved?: SupervisorSelection): SupervisorSelection | null {
  if (saved) return saved;
  if (preview.supervisorCheck.selection) return preview.supervisorCheck.selection;
  const worker = preview.workerSelection;
  if (worker.model && worker.reasoningEffort) {
    const option = preview.supervisorOptions.find(o => o.available && sameSupervisorSelection(o.selection, { provider: worker.provider, model: worker.model!, reasoningEffort: worker.reasoningEffort!, serviceTier: worker.serviceTier }));
    if (option && option.selection.serviceTier !== 'fast') return option.selection;
  }
  return preview.recommendedSupervisor;
}
