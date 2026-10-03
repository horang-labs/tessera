'use client';

import type { SupervisorCandidate, SupervisorSelection } from '@/lib/automation/autorun-contracts';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { cn } from '@/lib/utils';
import { AutomationField, automationField } from './automation-layout';
import { automationButton } from './ownership-actions';

export function SupervisorPicker({ candidates, value, onChange }: {
  candidates: SupervisorCandidate[]; value: Partial<SupervisorSelection>; onChange: (value: Partial<SupervisorSelection>) => void;
}) {
  const { t } = useI18n();
  const models = candidates.filter(candidate => candidate.provider === value.provider);
  const model = models.find(candidate => candidate.model === value.model);
  const unknownModel = Boolean(value.model && !model);
  const unknownEffort = Boolean(value.reasoningEffort && !model?.reasoningEfforts.includes(value.reasoningEffort));
  return <fieldset className="grid min-w-0 gap-2">
    <legend className="mb-2 text-xs font-medium text-(--text-secondary)">{t('automation.supervisor')}</legend>
    <div className="flex gap-2" role="group" aria-label={t('automation.provider')}>
      {(['claude-code', 'codex'] as const).map(provider => <button key={provider} type="button" {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')} aria-pressed={value.provider === provider}
        className={cn(automationButton, value.provider === provider && 'border-(--accent) bg-(--accent)/10 text-(--accent)')}
        onClick={() => onChange({ provider, model: '', reasoningEffort: '', serviceTier: provider === 'codex' ? 'default' : null })}>{provider === 'codex' ? 'Codex' : 'Claude Code'}</button>)}
    </div>
    <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <AutomationField label={t('automation.model')}><select className={automationField} name="supervisorModel" value={value.model ?? ''} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
        onChange={event => onChange({ ...value, model: event.target.value, reasoningEffort: '' })}>
        <option value="">{t('automation.choose')}</option>{unknownModel && <option value={value.model}>{value.model}</option>}
        {models.map(candidate => <option key={candidate.model} value={candidate.model}>{candidate.label}</option>)}
      </select></AutomationField>
      <AutomationField label={t('automation.effort')}><select className={automationField} name="supervisorEffort" value={value.reasoningEffort ?? ''} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
        onChange={event => onChange({ ...value, reasoningEffort: event.target.value })}>
        <option value="">{t('automation.choose')}</option>{unknownEffort && <option value={value.reasoningEffort}>{value.reasoningEffort}</option>}
        {model?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select></AutomationField>
    </div>
    {value.provider === 'codex' && model && (model.serviceTiers.length > 1 || !model.serviceTiers.includes(value.serviceTier ?? null)) && <AutomationField label={t('automation.tier')}><select className={automationField} name="supervisorTier" value={value.serviceTier ?? 'default'} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
      onChange={event => onChange({ ...value, serviceTier: event.target.value as SupervisorSelection['serviceTier'] })}>
      {value.serviceTier && !model.serviceTiers.includes(value.serviceTier) && <option value={value.serviceTier}>{t(value.serviceTier === 'fast' ? 'automation.tierFast' : 'automation.tierDefault')}</option>}
      {model.serviceTiers.filter(tier => tier !== null).map(tier => <option key={tier} value={tier}>{t(tier === 'fast' ? 'automation.tierFast' : 'automation.tierDefault')}</option>)}
    </select></AutomationField>}
  </fieldset>;
}
