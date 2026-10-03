'use client';

import type { SupervisorSelection } from '@/lib/automation/autorun-contracts';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { useSettingsStore } from '@/stores/settings-store';
import { automationTierOptions } from '@/lib/automation/service-tier';
import type { ProviderSessionOptions } from '@/lib/cli/provider-session-options';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { cn } from '@/lib/utils';
import { AutomationField, automationField } from './automation-layout';
import { automationButton } from './ownership-actions';

export function SupervisorPicker({ value, onChange }: {
  value: Partial<SupervisorSelection>; onChange: (value: Partial<SupervisorSelection>) => void;
}) {
  const environment = useSettingsStore(state => state.settings.agentEnvironment);
  const { data, isLoading, error, retry } = useProviderSessionOptions(value.provider, environment);
  const { t } = useI18n();
  return <>
    <SupervisorControls catalog={data} value={value} onChange={onChange} />
    {isLoading && <p role="status" className="text-xs text-(--text-secondary)">{t('automation.catalogLoading')}</p>}
    {error && <div className="flex items-center gap-2 text-xs"><p role="alert">{t('automation.catalogFailed')}</p><button type="button" className={automationButton} {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} onClick={retry}>{t('automation.retry')}</button></div>}
  </>;
}

export function SupervisorControls({ catalog, value, onChange }: {
  catalog: ProviderSessionOptions | null; value: Partial<SupervisorSelection>; onChange: (value: Partial<SupervisorSelection>) => void;
}) {
  const { t } = useI18n();
  const models = catalog?.modelOptions.filter(model => model.value !== 'auto') ?? [];
  const model = models.find(model => model.value === value.model);
  const efforts = model?.supportedReasoningEfforts.filter(effort => effort.value !== 'auto') ?? [];
  const tiers = automationTierOptions(model);
  const unknownModel = Boolean(value.model && !model);
  const unknownEffort = Boolean(value.reasoningEffort && !efforts.some(effort => effort.value === value.reasoningEffort));
  return <fieldset className="grid min-w-0 gap-2">
    <legend className="mb-2 text-xs font-medium text-(--text-secondary)">{t('automation.supervisor')}</legend>
    <div className="flex gap-2" role="group" aria-label={t('automation.provider')}>
      {(['claude-code', 'codex'] as const).map(provider => <button key={provider} type="button" {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')} aria-pressed={value.provider === provider}
        className={cn(automationButton, value.provider === provider && 'border-(--accent) bg-(--accent)/10 text-(--accent)')}
        onClick={() => onChange({ provider, model: '', reasoningEffort: '', serviceTier: provider === 'codex' ? 'default' : null })}>{provider === 'codex' ? 'Codex' : 'Claude Code'}</button>)}
    </div>
    <div className="grid min-w-0 gap-3 grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-end">
      <AutomationField label={t('automation.model')}><select className={automationField} name="supervisorModel" value={value.model ?? ''} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
        onChange={event => onChange({ ...value, model: event.target.value, reasoningEffort: '' })}>
        <option value="">{t('automation.choose')}</option>{unknownModel && <option value={value.model}>{value.model}</option>}
        {models.map(candidate => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
      </select></AutomationField>
      <AutomationField label={t('automation.effort')}><select className={automationField} name="supervisorEffort" value={value.reasoningEffort ?? ''} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
        onChange={event => onChange({ ...value, reasoningEffort: event.target.value })}>
        <option value="">{t('automation.choose')}</option>{unknownEffort && <option value={value.reasoningEffort}>{value.reasoningEffort}</option>}
        {efforts.map(effort => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
      </select></AutomationField>
    </div>
    {value.provider === 'codex' && model && (tiers.length > 1 || !tiers.some(tier => tier.value === value.serviceTier)) && <AutomationField label={t('automation.tier')}><select className={automationField} name="supervisorTier" value={value.serviceTier ?? 'default'} {...telemetryClickAttributes('automation.autorun.supervisor', 'automation')}
      onChange={event => onChange({ ...value, serviceTier: event.target.value as SupervisorSelection['serviceTier'] })}>
      {value.serviceTier && !tiers.some(tier => tier.value === value.serviceTier) && <option value={value.serviceTier}>{t(value.serviceTier === 'fast' ? 'automation.tierFast' : 'automation.tierDefault')}</option>}
      {tiers.map(tier => <option key={tier.value} value={tier.value}>{t(tier.value === 'fast' ? 'automation.tierFast' : 'automation.tierDefault')}</option>)}
    </select></AutomationField>}
  </fieldset>;
}
