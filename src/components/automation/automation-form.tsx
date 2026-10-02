'use client';

import { useState, type ReactNode } from 'react';
import { getAutomationDefaults, validateAutomationInput, type Automation, type AutomationInput, type Provider, type Selection } from '@/lib/automation/contracts';
import type { AutomationScope } from '@/stores/automation-store';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { useI18n } from '@/lib/i18n';
import { automationButton } from './ownership-actions';

export function localDateInput(at: number) {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function localDue(at: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at);
}
const fieldClass = 'w-full rounded border border-(--divider) bg-(--input-bg) p-2 text-sm';
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-xs">{label}{children}</label>;
}

export function AutomationForm({ scope, previous, onSave, onCancel }: {
  scope: AutomationScope;
  previous?: Automation;
  onSave: (input: AutomationInput, previous?: Automation) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const wake = 'sessionId' in scope;
  const [now] = useState(() => Date.now());
  const [kind, setKind] = useState(previous?.trigger.kind ?? (wake ? 'turn-complete' : 'once'));
  const defaults = getAutomationDefaults(kind, now);
  const oldSelection = previous?.target.kind === 'create-session' ? previous.target.selection : null;
  const [provider, setProvider] = useState<Provider>(oldSelection?.provider ?? 'claude-code');
  const [model, setModel] = useState(oldSelection?.model ?? '');
  const [effort, setEffort] = useState(oldSelection?.reasoningEffort ?? '');
  const [tier, setTier] = useState(oldSelection?.serviceTier ?? 'default');
  const options = useProviderSessionOptions(wake ? undefined : provider);
  const chosen = options.data?.modelOptions.find(option => option.value === model);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const oldAt = previous?.trigger.kind === 'once' ? previous.trigger.at : previous?.trigger.kind === 'interval' ? previous.trigger.anchorAt : null;
  const [atValue, setAtValue] = useState(oldAt === null ? '' : localDateInput(oldAt));
  const [everyValue, setEveryValue] = useState(previous?.trigger.kind === 'interval' ? String(previous.trigger.everyMs / 60_000) : '');
  const everyMs = Number(everyValue) * 60_000;
  const selectedAt = oldAt !== null && atValue === localDateInput(oldAt) ? oldAt : new Date(atValue).getTime();
  const retainedInterval = previous?.trigger.kind === 'interval' && kind === 'interval' && selectedAt === previous.trigger.anchorAt;
  const previewAt = retainedInterval && selectedAt <= now ? everyMs > 0 ? selectedAt + (Math.floor((now - selectedAt) / everyMs) + 1) * everyMs : NaN : selectedAt;
  const expiry = previous?.limits.expiresAt ?? defaults.limits.expiresAt;
  function supported(selection: Selection) {
    return Boolean(chosen && chosen.supportedReasoningEfforts.some(e => e.value === selection.reasoningEffort && e.value !== 'auto')
      && (provider === 'claude-code' ? selection.serviceTier === null : selection.serviceTier === 'default' || chosen.serviceTiers?.some(t => t.value === selection.serviceTier)));
  }
  return <form className="grid gap-4" onSubmit={async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? '');
    const instant = (key: string, original: number | null) => original !== null && text(key) === localDateInput(original) ? original : new Date(text(key)).getTime();
    const selection: Selection = { provider, model, reasoningEffort: effort, serviceTier: provider === 'codex' ? tier as 'default' | 'fast' : null, settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
    const input: AutomationInput = {
      name: text('name'), enabled: false, prompt: text('prompt'),
      target: wake ? { kind: 'wake-session', sessionId: scope.sessionId } : { kind: 'create-session', worktreeId: scope.worktreeId, title: text('title'), selection },
      trigger: kind === 'turn-complete' ? { kind, delayMs: Number(text('delay')) * 1000 }
        : kind === 'once' ? { kind, at: instant('at', oldAt) } : { kind, anchorAt: instant('at', oldAt), everyMs: Number(text('every')) * 60_000 },
      limits: { maxDispatches: kind === 'once' ? 1 : Number(text('max')), expiresAt: instant('expiry', expiry) },
    };
    const result = validateAutomationInput(input, { now: Date.now(), previousInput: previous ? { ...input, trigger: previous.trigger } : undefined, isSelectionSupported: supported });
    if (!result.success) { setError(true); return; }
    setError(false); setSaving(true);
    try { if (await onSave(result.data, previous)) onCancel(); } finally { setSaving(false); }
  }}>
    <p className="text-xs text-(--text-muted)">{t('automation.target')}: {'sessionId' in scope ? scope.sessionId : scope.worktreeId}</p>
    <Field label={t('automation.name')}><input className={fieldClass} name="name" required maxLength={120} defaultValue={previous?.name ?? ''} /></Field>
    <Field label={t('automation.prompt')}><textarea className={fieldClass} name="prompt" required rows={4} defaultValue={previous?.prompt ?? ''} /></Field>
    {!wake && <>
      <Field label={t('automation.sessionTitle')}><input className={fieldClass} name="title" required maxLength={120} defaultValue={previous?.target.kind === 'create-session' ? previous.target.title : ''} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('automation.provider')}><select className={fieldClass} value={provider} onChange={e => { setProvider(e.target.value as Provider); setModel(''); setEffort(''); setTier('default'); }}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></Field>
        <Field label={t('automation.model')}><select className={fieldClass} required value={model} onChange={e => { setModel(e.target.value); setEffort(''); setTier('default'); }}><option value="">{t('automation.choose')}</option>{options.data?.modelOptions.filter(m => m.value !== 'auto').map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label={t('automation.effort')}><select className={fieldClass} required value={effort} onChange={e => setEffort(e.target.value)}><option value="">{t('automation.choose')}</option>{chosen?.supportedReasoningEfforts.filter(e => e.value !== 'auto').map(e => <option key={e.value} value={e.value}>{e.label}</option>)}</select></Field>
        {provider === 'codex' && <Field label={t('automation.tier')}><select className={fieldClass} value={tier} onChange={e => setTier(e.target.value as 'default' | 'fast')}><option value="default">Default</option>{chosen?.serviceTiers?.filter(t => t.value === 'fast').map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>}
      </div>
      {options.isLoading && <p role="status">{t('automation.loading')}</p>}
      {options.error && <p role="alert">{t('automation.adapter')}</p>}
      <Field label={t('automation.trigger')}><select className={fieldClass} value={kind} onChange={e => setKind(e.target.value as 'once' | 'interval')}><option value="once">{t('automation.once')}</option><option value="interval">{t('automation.interval')}</option></select></Field>
      <Field label={t('automation.at')}><input className={fieldClass} type="datetime-local" name="at" required value={atValue} onChange={e => setAtValue(e.target.value)} /></Field>
      {Number.isFinite(previewAt) && <p className="break-words text-xs" role="status">{t('automation.next')}: {localDue(previewAt)} · UTC: <time dateTime={new Date(previewAt).toISOString()}>{new Date(previewAt).toISOString()}</time></p>}
      {kind === 'interval' && <Field label={t('automation.every')}><input className={fieldClass} name="every" type="number" min={1} max={43200} required value={everyValue} onChange={e => setEveryValue(e.target.value)} /></Field>}
    </>}
    {wake && <Field label={t('automation.delay')}><input className={fieldClass} name="delay" type="number" min={30} max={86400} required defaultValue={previous?.trigger.kind === 'turn-complete' ? previous.trigger.delayMs / 1000 : 120} /></Field>}
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('automation.max')}><input key={kind} className={fieldClass} name="max" type="number" min={1} max={100} required readOnly={kind === 'once'} defaultValue={kind === 'once' ? 1 : previous?.limits.maxDispatches ?? defaults.limits.maxDispatches} /></Field>
      <Field label={t('automation.expiry')}><input className={fieldClass} name="expiry" type="datetime-local" required defaultValue={localDateInput(expiry)} /></Field>
    </div>
    <p className="text-xs text-(--text-muted)">{t('automation.permissions')}</p>
    {error && <p role="alert">{t('automation.invalid')}</p>}
    <div className="flex gap-2"><button className={automationButton} disabled={saving || (!wake && (!chosen || Boolean(options.error)))} type="submit">{t('automation.save')}</button><button className={automationButton} type="button" onClick={onCancel}>{t('automation.cancel')}</button></div>
  </form>;
}
