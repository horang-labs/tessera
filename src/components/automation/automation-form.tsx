'use client';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import { useState, type ReactNode } from 'react';
import { getAutomationDefaults, validateAutomationInput, type Automation, type AutomationInput, type Provider, type Selection } from '@/lib/automation/contracts';
import type { AutomationScope } from '@/stores/automation-store';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { useI18n } from '@/lib/i18n';
import { automationButton, automationPrimaryButton } from './ownership-actions';

export function localDateInput(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function localDue(at: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at);
}
export function suggestSessionTitle(prompt: string) { return prompt.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0,120); }
const fieldClass = 'w-full rounded border border-(--divider) bg-(--input-bg) p-2 text-sm';
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-1 text-xs">{label}{children}</label>; }

export function AutomationForm({ scope, previous, onSave, onCancel, defaultName, draft, onDraft, replacing = false }: {
  scope: AutomationScope; previous?: Automation; defaultName?: string; draft?: unknown; onDraft?: (draft: Record<string,string>) => void;
  replacing?: boolean; onSave: (input: AutomationInput, previous?: Automation) => Promise<boolean>; onCancel: () => void;
}) {
  const { t } = useI18n();
  const wake = 'sessionId' in scope;
  const saved = (draft ?? {}) as Record<string,string>;
  const [now] = useState(() => Date.now());
  const [kind,setKind] = useState(saved.trigger as AutomationInput['trigger']['kind'] ?? previous?.trigger.kind ?? (wake ? 'turn-complete' : 'once'));
  const defaults = getAutomationDefaults(kind,now);
  const oldSelection = previous?.target.kind === 'create-session' ? previous.target.selection : null;
  const [provider,setProvider] = useState<Provider>(saved.provider as Provider ?? oldSelection?.provider ?? 'claude-code');
  const [model,setModel] = useState(saved.model ?? oldSelection?.model ?? '');
  const [effort,setEffort] = useState(saved.effort ?? oldSelection?.reasoningEffort ?? '');
  const [tier,setTier] = useState(saved.tier ?? oldSelection?.serviceTier ?? '');
  const options = useProviderSessionOptions(wake ? undefined : provider);
  const resolvedModel = model || options.data?.modelOptions.find(m => m.isDefault && m.value !== 'auto')?.value || '';
  const chosen = options.data?.modelOptions.find(m => m.value === resolvedModel);
  const resolvedEffort = effort || chosen?.defaultReasoningEffort || '';
  const resolvedTier = provider === 'claude-code' ? null : tier || chosen?.defaultServiceTier || 'default';
  const selection: Selection = { provider, model: resolvedModel, reasoningEffort: resolvedEffort, serviceTier: resolvedTier as 'default'|'fast'|null, settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
  const selectionSupported = Boolean(chosen && chosen.supportedReasoningEfforts.some(e => e.value === resolvedEffort && e.value !== 'auto') && (provider === 'claude-code' ? resolvedTier === null : resolvedTier === 'default' || chosen.serviceTiers?.some(tier => tier.value === resolvedTier)));
  const [prompt,setPrompt] = useState(saved.prompt ?? previous?.prompt ?? '');
  const [title,setTitle] = useState<string | null>(saved.title ?? (previous?.target.kind === 'create-session' ? previous.target.title : null));
  const suggestedTitle = title ?? suggestSessionTitle(prompt);
  const oldAt = previous?.trigger.kind === 'once' ? previous.trigger.at : previous?.trigger.kind === 'interval' ? previous.trigger.anchorAt : null;
  const [atValue,setAtValue] = useState(saved.at ?? (oldAt === null ? '' : localDateInput(oldAt)));
  const [everyValue,setEveryValue] = useState(saved.every ?? (previous?.trigger.kind === 'interval' ? String(previous.trigger.everyMs/60000) : ''));
  const selectedAt = oldAt !== null && atValue === localDateInput(oldAt) ? oldAt : new Date(atValue).getTime();
  const everyMs = Number(everyValue)*60000;
  const retained = previous?.trigger.kind === 'interval' && kind === 'interval' && selectedAt === previous.trigger.anchorAt;
  const previewAt = retained && selectedAt <= now ? everyMs > 0 ? selectedAt + (Math.floor((now-selectedAt)/everyMs)+1)*everyMs : NaN : selectedAt;
  const expiry = previous?.limits.expiresAt ?? defaults.limits.expiresAt;
  const [error,setError] = useState(false);
  const [saving,setSaving] = useState(false);
  return <form className="grid gap-4" onChange={event => onDraft?.(Object.fromEntries([...new FormData(event.currentTarget)].map(([key,value]) => [key,String(value)])))} onSubmit={async event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const text = (key: string) => String(fields.get(key) ?? '');
    const instant = (key: string, original: number|null) => original !== null && text(key) === localDateInput(original) ? original : new Date(text(key)).getTime();
    const input: AutomationInput = { name: text('name'), prompt, enabled: !previous && (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'later',
      target: wake ? { kind:'wake-session',sessionId:scope.sessionId } : { kind:'create-session',worktreeId:scope.worktreeId,title:suggestedTitle,selection },
      trigger: kind === 'turn-complete' ? {kind,delayMs:Number(text('delay'))*1000} : kind === 'once' ? {kind,at:instant('at',oldAt)} : {kind,anchorAt:instant('at',oldAt),everyMs},
      limits:{maxDispatches:kind === 'once' ? 1 : Number(text('max')), expiresAt:instant('expiry',expiry)} };
    const valid = validateAutomationInput(input,{now:Date.now(),previousInput:previous ? {...input,trigger:previous.trigger} : undefined,isSelectionSupported:()=>selectionSupported});
    if(!valid.success){setError(true);return;}
    setSaving(true);setError(false);try { await onSave(valid.data,previous); } finally {setSaving(false);}
  }}>
    <Field label={t('automation.prompt')}><textarea {...telemetryIgnoreAttributes('non_action')} className={fieldClass} name="prompt" rows={4} required value={prompt} onChange={e=>setPrompt(e.target.value)} /></Field>
    {!wake && <>
      <Field label={t('automation.sessionTitle')}><input {...telemetryIgnoreAttributes('non_action')} className={fieldClass} name="title" required maxLength={120} value={suggestedTitle} onChange={e=>setTitle(e.target.value)} /></Field>
      <Field label={t('automation.trigger')}><select {...telemetryClickAttributes('automation.form.trigger','automation')} className={fieldClass} name="trigger" value={kind} onChange={e=>setKind(e.target.value as 'once'|'interval')}><option value="once">{t('automation.once')}</option><option value="interval">{t('automation.interval')}</option></select></Field>
      <Field label={t('automation.at')}><input {...telemetryClickAttributes('automation.form.at','automation')} className={fieldClass} name="at" type="datetime-local" required value={atValue} onChange={e=>setAtValue(e.target.value)} /></Field>
      {Number.isFinite(previewAt) && <p className="text-xs break-words" role="status">{t('automation.next')}: {localDue(previewAt)} · UTC: <time dateTime={new Date(previewAt).toISOString()}>{new Date(previewAt).toISOString()}</time></p>}
      {kind === 'interval' && <Field label={t('automation.every')}><input {...telemetryClickAttributes('automation.form.every','automation')} className={fieldClass} name="every" type="number" min={1} max={43200} required value={everyValue} onChange={e=>setEveryValue(e.target.value)} /></Field>}
      <p className="text-xs break-words">{t('automation.saved')}: {provider} · {resolvedModel || t('automation.choose')} · {resolvedEffort || t('automation.choose')} · {resolvedTier ?? ''}</p>
    </>}
    <details open={!wake && !selectionSupported}><summary {...telemetryClickAttributes('automation.form.advanced','automation')}>{t('automation.advanced')}</summary><div className="grid gap-3 mt-2">
      <Field label={t('automation.name')}><input {...telemetryIgnoreAttributes('non_action')} className={fieldClass} name="name" required maxLength={120} defaultValue={saved.name ?? previous?.name ?? defaultName ?? t('automation.new')} /></Field>
      {!wake && <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('automation.provider')}><select {...telemetryClickAttributes('automation.form.provider','automation')} className={fieldClass} name="provider" value={provider} onChange={e=>{setProvider(e.target.value as Provider);setModel('');setEffort('');setTier('');}}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></Field>
        <Field label={t('automation.model')}><select {...telemetryClickAttributes('automation.form.model','automation')} className={fieldClass} name="model" value={resolvedModel} onChange={e=>{setModel(e.target.value);setEffort('');setTier('');}}><option value="">{t('automation.choose')}</option>{options.data?.modelOptions.filter(m=>m.value !== 'auto').map(m=><option value={m.value} key={m.value}>{m.label}</option>)}</select></Field>
        <Field label={t('automation.effort')}><select {...telemetryClickAttributes('automation.form.effort','automation')} className={fieldClass} name="effort" value={resolvedEffort} onChange={e=>setEffort(e.target.value)}><option value="">{t('automation.choose')}</option>{chosen?.supportedReasoningEfforts.filter(e=>e.value !== 'auto').map(e=><option key={e.value} value={e.value}>{e.label}</option>)}</select></Field>
        {provider==='codex' && <Field label={t('automation.tier')}><select {...telemetryClickAttributes('automation.form.tier','automation')} className={fieldClass} name="tier" value={resolvedTier ?? ''} onChange={e=>setTier(e.target.value)}><option value="default">Default</option>{chosen?.serviceTiers?.filter(t=>t.value==='fast').map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>}
      </div>}
      {wake && <Field label={t('automation.delay')}><input {...telemetryClickAttributes('automation.form.delay','automation')} className={fieldClass} name="delay" type="number" min={30} max={86400} required defaultValue={saved.delay ?? (previous?.trigger.kind==='turn-complete' ? previous.trigger.delayMs/1000 : 120)} /></Field>}
      <Field label={t('automation.max')}><input {...telemetryClickAttributes('automation.form.max','automation')} className={fieldClass} key={kind} name="max" type="number" min={1} max={100} readOnly={kind==='once'} required defaultValue={kind==='once' ? 1 : saved.max ?? previous?.limits.maxDispatches ?? defaults.limits.maxDispatches} /></Field>
      <Field label={t('automation.expiry')}><input {...telemetryClickAttributes('automation.form.expiry','automation')} className={fieldClass} name="expiry" type="datetime-local" required defaultValue={saved.expiry ?? localDateInput(expiry)} /></Field>
    </div></details>
    {options.isLoading && !wake && <p role="status">{t('automation.loading')}</p>}
    {options.error && !wake && <p role="alert">{t('automation.adapter')}</p>}
    <p className="text-xs">{t('automation.permissions')}</p>{error && <p role="alert">{t('automation.invalid')}</p>}
    {replacing && <p>{t('automation.replaceHelp')}</p>}
    <div className="sticky bottom-0 flex flex-wrap gap-2 bg-(--chat-bg) py-2">
      <button {...telemetryClickAttributes('automation.form.save','automation')} className={automationPrimaryButton} type="submit" disabled={saving || (!wake && !selectionSupported)}>{t(replacing ? 'automation.replace' : previous ? 'automation.saveChanges' : wake ? 'automation.start' : 'automation.startSchedule')}</button>
      {!previous && !replacing && <button {...telemetryClickAttributes('automation.form.save','automation')} className={automationButton} type="submit" value="later" disabled={saving || (!wake && !selectionSupported)}>{t('automation.save')}</button>}
      <button {...telemetryClickAttributes('automation.form.cancel','automation')} className={automationButton} type="button" onClick={onCancel}>{t('automation.cancel')}</button>
    </div>
  </form>;
}
