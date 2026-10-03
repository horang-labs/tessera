'use client';
import type { AutomationActivation } from '@/lib/automation/activation-contracts';
import type { AutomationV2 } from '@/lib/automation/autorun-contracts';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { automationNotice } from './automation-layout';
import { automationButton } from './ownership-actions';

/** Intent and server-reported activity are independent of the input ownership projection. */
export function activationStatusKey(state: AutomationV2['state'], activation?: AutomationActivation | null) {
  if (state !== 'enabled' || !activation) return `automation.state_${state}` as const;
  return `automation.activation_${activation.reason ?? activation.phase}` as const;
}
export function AutomationActivationStatus({ state, mode, activation, onOpenSession }: {
  state: AutomationV2['state']; mode: AutomationV2['mode']; activation?: AutomationActivation | null; onOpenSession: () => void;
}) {
  const { t } = useI18n();
  const current = state === 'enabled' ? activation : null;
  const approval = current?.approval;
  const needsAnswer = approval?.status === 'needs-user' || current?.phase === 'needs-user'
    || ['approval-needs-user', 'interaction-unsupported', 'delivery-unresolved'].includes(current?.reason ?? '');
  const heartbeatApproval = mode === 'heartbeat' && ['approval-review', 'approval-needs-user'].includes(current?.reason ?? '');
  return <div className={automationNotice}>
    <p role="status" aria-live="polite">{t(`automation.state_${state}`)}{current && <> · {t(heartbeatApproval ? 'automation.heartbeatApprovalWait' : activationStatusKey(state, current))}</>}</p>
    {approval && <div className="mt-2 grid gap-1 text-sm"><p>{t(`automation.approval_${approval.status}`)}</p><p className="break-words">{approval.summary}</p>
      {approval.explanation && <details className="text-xs text-(--text-secondary)"><summary className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-(--accent)" {...telemetryClickAttributes('automation.diagnostics','automation')}>{t('automation.technicalDetails')}</summary><p className="mt-1 break-words">{approval.explanation}</p></details>}
    </div>}
    {needsAnswer && <button type="button" className={`${automationButton} mt-2`} {...telemetryClickAttributes('automation.history.open_session','automation')} onClick={onOpenSession}>{t('automation.openSession')}</button>}
  </div>;
}
