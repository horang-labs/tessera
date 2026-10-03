'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useI18n } from '@/lib/i18n';
import { getAutorunSetupDefaults, supervisorSelectionSchema, sameSupervisorSelection, validateAutomationInputV2, type AutorunPreview, type AutorunInput, type SupervisorSelection, type AutomationV2 } from '@/lib/automation/autorun-contracts';
import type { AutomationStoreApi } from '@/stores/automation-store';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { automationButton, automationPrimaryButton } from './ownership-actions';
import { localDateInput } from './automation-form';
import { useSettingsStore } from '@/stores/settings-store';
import { SavedSelection } from './automation-history';
import { AutomationPreflight } from './automation-preflight';
import { SupervisorPicker } from './supervisor-picker';
import { AutomationField, AutomationSettingRow, AutomationViewport, automationField, automationNumberField, automationDisclosure, revealAutomationField } from './automation-layout';

export function AutorunPreviewView({ preview, objectiveOverride, objectiveEdited = Boolean(objectiveOverride.trim()), readOnly = false, onObjective, objectiveSnapshot }: {
  objectiveSnapshot?: AutorunPreview['objective']; preview: AutorunPreview | null; objectiveOverride: string; objectiveEdited?: boolean; readOnly?: boolean; onObjective: (text: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const displayedObjective = objectiveSnapshot ?? preview?.objective;
  const objective = objectiveEdited ? objectiveOverride : displayedObjective?.text ?? '';
  const source = objectiveEdited || displayedObjective?.kind === 'explicit' ? 'automation.explicitGoal' : displayedObjective?.kind === 'verified-human' ? 'automation.verifiedGoal' : 'automation.unverifiedGoal';
  return <section className="grid gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('automation.goal')}</h3>
      {(displayedObjective || (objectiveEdited && objective.trim())) && <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.autorun.sources', 'automation')} className="cursor-pointer">{t(source)}</summary>
        <div className="mt-2 grid gap-2"><p className="whitespace-pre-wrap break-words">{objective}</p>{!objectiveEdited && displayedObjective?.kind === 'verified-human' && displayedObjective.sources.map(source => <blockquote key={source.recordId} className="whitespace-pre-wrap border-l pl-2">{source.excerpt}</blockquote>)}</div>
      </details>}
    </div>
    {readOnly ? <p className="whitespace-pre-wrap break-words">{objective}</p>
      : <textarea name="objective" aria-label={t('automation.goal')} required className={automationField} rows={3} value={objective} placeholder={t('automation.objectivePlaceholder')} {...telemetryIgnoreAttributes('non_action')} onChange={event => onObjective(event.target.value)} />}
    {Boolean(preview?.newHumanInstructions.length) && <details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.autorun.sources', 'automation')} className="cursor-pointer">{t('automation.newInstructionsCount', { count: preview?.newHumanInstructions.length })}</summary>{preview?.newHumanInstructions.map(source => <blockquote key={source.recordId} className="mt-2 whitespace-pre-wrap">{source.excerpt}</blockquote>)}</details>}
  </section>;
}

/** Enable intent validates configuration; inference capability is rechecked by the runtime. */
export function autorunCanStart(preview: AutorunPreview | null, selection: SupervisorSelection | null, objective: string, expiresAt: number, now: number) {
  return supervisorSelectionSchema.safeParse(selection).success && Boolean(objective.trim() || preview?.objective?.text.trim()) && expiresAt > now;
}

/** Public setup submit path: configuration is complete before any native preview arrives. */
export async function submitAutorunSetup({ fields, supervisor, objective, preview, sessionId, intent, previous, name, criterion, saveLater, store }: {
  fields: FormData; supervisor: SupervisorSelection; objective: string; preview: AutorunPreview | null;
  sessionId: string; intent: 'start' | 'resume' | 'edit' | 'replace'; previous?: AutomationV2;
  name: string; criterion: string; saveLater: boolean; store: AutomationStoreApi;
}) {
  const old = previous?.mode === 'autorun' ? previous : undefined;
  const lines = (field: string) => String(fields.get(field) ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  const criterionLines = lines('criteria');
  if (!objective.trim() && !preview?.objective) return { invalid: true, success: false };
  const input: AutorunInput = { version: 2, mode: 'autorun', name: String(fields.get('name') ?? old?.name ?? name), enabled: intent !== 'edit' && !saveLater,
    target: { kind: 'wake-session', sessionId }, trigger: { kind: 'turn-complete', delayMs: Number(fields.get('delay')) * 1000 },
    limits: { maxDispatches: Number(fields.get('max')), expiresAt: new Date(String(fields.get('expiry'))).getTime() },
    autorun: { objective: objective.trim() ? { kind: 'explicit', text: objective } : { kind: 'preview', previewId: preview!.previewId, goalRevision: preview!.goalRevision },
      constraints: lines('constraints'), criteria: criterionLines.length ? criterionLines.map((text, i) => ({ id: `criterion-${i+1}`, text })) : old?.autorun.criteria ?? preview?.criteria ?? [{ id: 'goal', text: criterion }],
      supervisor, maxAnalyses: Number(fields.get('analyses')), analysisTimeoutMs: Number(fields.get('timeout')) * 1000 } };
  const valid = validateAutomationInputV2(input, { now: Date.now() });
  if (!valid.success || (input.enabled && !autorunCanStart(preview, supervisor, objective, input.limits.expiresAt, Date.now()))) return { invalid: true, success: false };
  if (intent === 'replace' && previous && !await store.getState().remove(previous.id)) return { invalid: false, success: false };
  const success = await store.getState().save(input, intent === 'edit' ? old : undefined);
  return { invalid: false, success, id: success ? store.getState().lastControl?.body.automation.id : undefined };
}

export function AutorunSetup({ preview, store, previous, intent = 'start', onDone, onOpenSession, defaultName, intro, footnote, requestErrorNotice, sessionId }: {
  sessionId?: string; preview: AutorunPreview | null; store: AutomationStoreApi; previous?: AutomationV2;
  requestErrorNotice?: ReactNode; onDraftObjective?: (text: string) => void; intro?: ReactNode; footnote?: ReactNode; defaultName?: string; intent?: 'start' | 'resume' | 'edit' | 'replace'; onDone: (id: string) => void; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const [defaults] = useState(() => getAutorunSetupDefaults(Date.now()));
  const settings = useSettingsStore(state => state.settings);
  const targetSessionId = sessionId ?? preview?.sessionId ?? (previous?.target.kind === 'wake-session' ? previous.target.sessionId : null);
  const old = previous?.mode === 'autorun' ? previous : undefined;
  const draftKey = old ? `${old.id}:${intent}` : 'autorun:new';
  const draftFields = (store.getState().drafts[`${draftKey}:fields`] ?? {}) as Record<string, string>;
  const [draft] = useState(() => store.getState().drafts[draftKey] as Partial<AutorunInput> | undefined);
  const [objectiveEdited, setObjectiveEdited] = useState(Boolean(draftFields.objectiveEdited === 'yes' || (draftFields.objectiveEdited !== 'no' && draftFields.objective !== undefined) || draft?.autorun?.objective?.kind === 'explicit' || old?.autorun.objective.kind === 'explicit'));
  const [override, setOverride] = useState((draftFields.objectiveEdited !== 'no' ? draftFields.objective : undefined) ?? (draft?.autorun?.objective?.kind === 'explicit' ? draft.autorun.objective.text : old?.autorun.objective.kind === 'explicit' ? old.autorun.objective.text : ''));
  const savedSupervisorDraft = store.getState().drafts[`${draftKey}:supervisor`] as Partial<SupervisorSelection> | undefined;
  const configured = settings.providerDefaults.codex;
  const configuredSelection: SupervisorSelection | undefined = configured?.model && configured.reasoningEffort && configured.reasoningEffort !== 'auto' ? { provider: 'codex', model: configured.model, reasoningEffort: configured.reasoningEffort, serviceTier: 'default' } : undefined;
  const selection = savedSupervisorDraft ? savedSupervisorDraft.provider && savedSupervisorDraft.model && savedSupervisorDraft.reasoningEffort ? savedSupervisorDraft as SupervisorSelection : null : chooseAutorunSupervisor(preview, draft?.autorun?.supervisor ?? old?.autorun.supervisor) ?? configuredSelection ?? null;
  const [initialSelection] = useState(selection);
  useEffect(() => {
    const state = store.getState();
    if (!state.preview && !state.previewLoading && !state.previewError) void state.previewAutorun(initialSelection ? { supervisor: initialSelection } : {});
  }, [store, initialSelection]); // Mount starts one check; later choice changes explicitly supersede it.
  const [supervisor, setSupervisor] = useState<SupervisorSelection | null>(selection);
  const [supervisorEdited, setSupervisorEdited] = useState(Boolean(savedSupervisorDraft));
  const [supervisorDraft, setSupervisorDraft] = useState<Partial<SupervisorSelection>>(savedSupervisorDraft ?? selection ?? { provider: 'codex', model: settings.providerDefaults.codex?.model ?? '', reasoningEffort: settings.providerDefaults.codex?.reasoningEffort ?? '', serviceTier: 'default' });
  const { previewLoading, previewError, previewRejection } = useStore(store);
  useEffect(() => {
    if (!preview || supervisorEdited) return;
    const initial = chooseAutorunSupervisor(preview, draft?.autorun?.supervisor ?? old?.autorun.supervisor);
    if (initial) { setSupervisor(initial); setSupervisorDraft(initial); }
  }, [preview, supervisorEdited, draft, old]);
  const [objectiveSnapshot, setObjectiveSnapshot] = useState(old?.autorun.objective ?? preview?.objective);
  useEffect(() => { if (preview?.objective && !old) setObjectiveSnapshot(preview.objective); }, [preview, old]);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [fieldsSummary, setFieldsSummary] = useState(draftFields);
  const [expiresAt, setExpiresAt] = useState(draftFields.expiry ? new Date(draftFields.expiry).getTime() : old?.limits.expiresAt ?? draft?.limits?.expiresAt ?? defaults.expiresAt);
  const configuredSelectionResult = supervisorSelectionSchema.safeParse(supervisor);
  const configuredSupervisor = configuredSelectionResult.success ? configuredSelectionResult.data : null;
  const ready = Boolean(targetSessionId && configuredSupervisor && (!objectiveEdited || override.trim()) && autorunCanStart(preview, configuredSupervisor, override, expiresAt, now)
    && (!old || (old.dispatchCount < old.limits.maxDispatches && old.analysisCount < old.autorun.maxAnalyses)));
  const retry = () => void store.getState().previewAutorun(supervisor ? { supervisor } : {});
  const changeSupervisor = (value: Partial<SupervisorSelection>) => {
    setSupervisorEdited(true);
    setSupervisorDraft(value);
    const selected = value.provider && value.model && value.reasoningEffort ? value as SupervisorSelection : null;
    setSupervisor(selected);
    store.setState(state => ({ drafts: { ...state.drafts, [`${draftKey}:supervisor`]: value } }));
    if (selected) void store.getState().previewAutorun({ supervisor: selected });
    else store.getState().invalidateAutorunPreview();
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
    if (!targetSessionId || !configuredSupervisor || (!override.trim() && !preview?.objective) || (objectiveEdited && !override.trim())) { setInvalid(true); return; }
    const fields = new FormData(event.currentTarget);
    setSaving(true); setInvalid(false);
    try {
      const result = await submitAutorunSetup({ fields, supervisor: configuredSupervisor, objective: override, preview, sessionId: targetSessionId,
        intent, previous, name: defaultName ?? t('automation.continueWork'), criterion: t('automation.criterionDefault'),
        saveLater: (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'yes', store });
      setInvalid(result.invalid);
      if (result.success && result.id) onDone(result.id);
    } finally { setSaving(false); }
  }}>
    <AutomationViewport footerNote={requestErrorNotice ?? (!ready ? <p>{t(!configuredSupervisor ? 'automation.chooseSupervisor' : !override.trim() && !objectiveSnapshot ? 'automation.goalMissing' : 'automation.reasonLimit')}</p> : null)} footer={<>

      <button {...telemetryClickAttributes('automation.autorun.start', 'automation')} className={automationPrimaryButton} type="submit" disabled={saving || !configuredSupervisor || (objectiveEdited && !override.trim()) || (intent !== 'edit' && !ready)}>{t(intent === 'resume' ? 'automation.resume' : intent === 'edit' ? 'automation.saveChanges' : intent === 'replace' ? 'automation.replace' : 'automation.start')}</button>
      {intent === 'start' && <button {...telemetryClickAttributes('automation.form.save', 'automation')} className={automationButton} type="submit" name="saveLater" value="yes" disabled={saving || !configuredSupervisor}>{t('automation.save')}</button>}

    </>}>
    {intro}
    <AutorunPreviewView preview={preview} objectiveSnapshot={objectiveSnapshot} objectiveOverride={override} objectiveEdited={objectiveEdited} onObjective={saveDraft} onOpenSession={onOpenSession} />
    <SupervisorPicker value={supervisorDraft} onChange={changeSupervisor} />
    <details className={automationDisclosure} open={invalid}><summary {...telemetryClickAttributes('automation.form.advanced', 'automation')}>{t('automation.optionsLimits')} <span className="font-normal text-xs">· {t('automation.limitsSummary', { seconds: fieldsSummary.delay ?? (old?.trigger.delayMs ?? defaults.delayMs)/1000, max: fieldsSummary.max ?? old?.limits.maxDispatches ?? defaults.maxDispatches })}</span></summary>
      <div className="grid gap-4">
        <fieldset className="grid gap-2"><legend className="mb-2 text-xs font-medium">{t('automation.guidance')}</legend><div className="grid gap-3 sm:grid-cols-2">
          <AutomationField label={t('automation.constraintsShort')}><textarea className={`${automationField} resize-y [field-sizing:content] max-h-32`} {...telemetryIgnoreAttributes('non_action')} name="constraints" rows={1} defaultValue={draftFields.constraints ?? (draft?.autorun?.constraints ?? old?.autorun.constraints ?? preview?.constraints ?? []).join('\n')} /></AutomationField>
          <AutomationField label={t('automation.doneWhen')}><textarea className={`${automationField} resize-y [field-sizing:content] max-h-32`} {...telemetryIgnoreAttributes('non_action')} name="criteria" rows={1} defaultValue={draftFields.criteria ?? (draft?.autorun?.criteria ?? old?.autorun.criteria ?? (preview?.criterionOrigin === 'system-objective' ? [] : (preview?.criteria ?? []))).map(c => c.text).join('\n')} /></AutomationField>
        </div></fieldset>
        <fieldset className="grid gap-3 border-t border-(--divider) pt-3"><legend className="px-1 text-xs font-medium">{t('automation.limitsTiming')}</legend>
          <AutomationSettingRow label={t('automation.waitAfterTurn')} unit={t('automation.seconds')}><input className={automationNumberField} {...telemetryClickAttributes('automation.form.delay', 'automation')} name="delay" type="number" required min={30} max={86400} defaultValue={draftFields.delay ?? (old?.trigger.delayMs ?? defaults.delayMs)/1000} /></AutomationSettingRow>
          <p className="text-xs font-medium">{t('automation.stopAfter')}</p>
          <AutomationSettingRow label={t('automation.instructionAttempts')} hint={old && t('automation.usedRemaining', { used: old.dispatchCount, remaining: Math.max(0, Number(fieldsSummary.max ?? old.limits.maxDispatches) - old.dispatchCount) })}><input className={automationNumberField} {...telemetryClickAttributes('automation.form.max', 'automation')} name="max" type="number" required min={1} max={100} defaultValue={draftFields.max ?? old?.limits.maxDispatches ?? defaults.maxDispatches} /></AutomationSettingRow>
          <AutomationSettingRow label={t('automation.supervisorChecks')} hint={old && t('automation.usedRemaining', { used: old.analysisCount, remaining: Math.max(0, Number(fieldsSummary.analyses ?? old.autorun.maxAnalyses) - old.analysisCount) })}><input className={automationNumberField} {...telemetryClickAttributes('automation.autorun.analyses', 'automation')} name="analyses" type="number" required min={1} max={100} defaultValue={draftFields.analyses ?? old?.autorun.maxAnalyses ?? defaults.maxAnalyses} /></AutomationSettingRow>
          <AutomationField label={t('automation.expiry')}><input className={automationField} {...telemetryClickAttributes('automation.form.expiry', 'automation')} name="expiry" type="datetime-local" required defaultValue={draftFields.expiry ?? localDateInput(expiresAt)} onChange={e => setExpiresAt(new Date(e.target.value).getTime())} /><span className="text-[11px] font-normal">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></AutomationField>
          <AutomationSettingRow label={t('automation.checkTimeout')} unit={t('automation.seconds')}><input className={automationNumberField} {...telemetryClickAttributes('automation.autorun.timeout', 'automation')} name="timeout" type="number" required min={30} max={300} defaultValue={draftFields.timeout ?? (old?.autorun.analysisTimeoutMs ?? defaults.analysisTimeoutMs)/1000} /></AutomationSettingRow>
        </fieldset>
        <AutomationField className="border-t border-(--divider) pt-3" label={t('automation.name')}><input className={automationField} {...telemetryIgnoreAttributes('non_action')} name="name" defaultValue={draftFields.name ?? draft?.name ?? old?.name ?? defaultName ?? t('automation.continueWork')} required maxLength={120} /></AutomationField>
      </div>
    </details>
    {(preview || previewRejection || previewLoading || previewError) && <details data-supervisor-details className="text-xs text-(--text-secondary)"><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')} className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-(--accent)">{t('automation.technicalDetails')}</summary><div className="mt-2 grid gap-2">
      <AutomationPreflight loading={previewLoading} error={previewError} onRetry={retry} />
      {preview?.supervisorCheck.status === 'unavailable' && <p>{t(preview.supervisorCheck.reason === 'selection' ? 'automation.selectionUnsupported' : 'automation.supervisorSetupFailed')}</p>}
      {preview && <SavedSelection selection={preview.workerSelection} />}{preview?.readiness.kind === 'unavailable' && <p>{preview.readiness.code} · {preview.readiness.reason}</p>}{preview?.readiness.kind === 'idle' && <p>{preview.readiness.reason}</p>}{previewRejection && <p>{previewRejection}</p>}
      {!previewLoading && !previewError && <button type="button" className={`${automationButton} justify-self-start`} {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} onClick={retry}>{t('automation.checkAgain')}</button>}
    </div></details>}
    {intent === 'replace' && <p>{t('automation.replaceHelp')}</p>}
    {invalid && <p role="alert">{t('automation.invalid')}</p>}

    {footnote && <div className="grid gap-1 text-xs text-(--text-secondary)">{footnote}</div>}
    </AutomationViewport>
  </form>;
}

export function chooseAutorunSupervisor(preview: AutorunPreview | null, saved?: SupervisorSelection): SupervisorSelection | null {
  if (saved) return saved;
  if (!preview) return null;
  if (preview.supervisorCheck.selection) return preview.supervisorCheck.selection;
  const worker = preview.workerSelection;
  if (worker.model && worker.reasoningEffort) {
    const option = preview.supervisorOptions.find(o => o.available && sameSupervisorSelection(o.selection, { provider: worker.provider, model: worker.model!, reasoningEffort: worker.reasoningEffort!, serviceTier: worker.serviceTier }));
    if (option && option.selection.serviceTier !== 'fast') return option.selection;
  }
  return preview.recommendedSupervisor;
}
