'use client';

import { useState } from 'react';
import { Activity, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type {
  CliDiagnosticExportResult,
  CliDiagnosticOutcome,
  CliDiagnosticReport,
} from '@/lib/cli/diagnostic-types';
import { cn } from '@/lib/utils';

interface DiagnosticsRunResponse {
  report: CliDiagnosticReport;
}

const OUTCOME_DOT_CLASS: Record<CliDiagnosticOutcome, string> = {
  passed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-gray-400',
  timeout: 'bg-yellow-500',
};

export default function CliDiagnosticsPanel() {
  const { t } = useI18n();
  const [report, setReport] = useState<CliDiagnosticReport | null>(null);
  const [exportResult, setExportResult] = useState<CliDiagnosticExportResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function runDiagnostics() {
    setIsRunning(true);
    setError(null);
    setExportError(null);
    setExportResult(null);

    try {
      const response = await fetch('/api/diagnostics/cli', { method: 'POST' });
      if (!response.ok) {
        throw new Error(t('settings.cliDiagnostics.runFailed'));
      }
      const data = await response.json() as DiagnosticsRunResponse;
      setReport(data.report);
    } catch (nextError) {
      setError((nextError as Error).message || t('settings.cliDiagnostics.runFailed'));
    } finally {
      setIsRunning(false);
    }
  }

  async function exportReport() {
    setIsExporting(true);
    setExportError(null);

    try {
      const response = await fetch('/api/diagnostics/cli/export', { method: 'POST' });
      if (!response.ok) {
        throw new Error(t('settings.cliDiagnostics.exportFailed'));
      }
      setExportResult(await response.json() as CliDiagnosticExportResult);
    } catch (nextError) {
      setExportError((nextError as Error).message || t('settings.cliDiagnostics.exportFailed'));
    } finally {
      setIsExporting(false);
    }
  }

  const hasReport = report !== null;

  return (
    <div className="space-y-3" data-testid="cli-diagnostics-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-(--text-primary)">
            {t('settings.cliDiagnostics.title')}
          </h4>
          {report && (
            <p className="mt-1 text-xs text-(--text-muted)">
              {t('settings.cliDiagnostics.lastRun', { environment: report.environment })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void runDiagnostics()}
            disabled={isRunning || isExporting}
            data-testid="cli-diagnostics-run"
          >
            {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            {isRunning ? t('settings.cliDiagnostics.running') : t('settings.cliDiagnostics.run')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void exportReport()}
            disabled={!hasReport || isRunning || isExporting}
            data-testid="cli-diagnostics-export"
          >
            {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {isExporting ? t('settings.cliDiagnostics.exporting') : t('settings.cliDiagnostics.export')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600" role="alert">
          {error}
        </div>
      )}

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <SummaryBadge label={t('settings.cliDiagnostics.passed')} value={report.summary.passed} />
            <SummaryBadge label={t('settings.cliDiagnostics.failed')} value={report.summary.failed} />
            <SummaryBadge label={t('settings.cliDiagnostics.timeout')} value={report.summary.timeout} />
            <SummaryBadge label={t('settings.cliDiagnostics.skipped')} value={report.summary.skipped} />
          </div>

          <div className="divide-y divide-(--divider) border-y border-(--divider)" data-testid="cli-diagnostics-results">
            {report.providers.map((provider) => (
              <div
                key={`${provider.providerId}-${provider.environment}`}
                className="grid gap-2 py-3 text-sm sm:grid-cols-[minmax(8rem,1fr)_auto]"
                data-testid={`cli-diagnostics-row-${provider.providerId}-${provider.environment}`}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={cn('h-2 w-2 shrink-0 rounded-full', OUTCOME_DOT_CLASS[provider.outcome])}
                    />
                    <span className="truncate font-medium text-(--text-primary)">
                      {provider.displayName}
                    </span>
                    {provider.version && (
                      <span className="shrink-0 text-xs text-(--text-muted)">
                        v{provider.version}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--text-muted)">
                    <span>{t(`settings.cliDiagnostics.outcome.${provider.outcome}`)}</span>
                    <span>{t(`settings.cliStatus.status.${provider.connectionStatus}`)}</span>
                    <span>{provider.durationMs}ms</span>
                  </div>
                  {provider.assistantPreview && (
                    <p className="mt-2 max-h-10 overflow-hidden text-xs text-(--text-secondary)">
                      {provider.assistantPreview}
                    </p>
                  )}
                  {provider.rawLogPath && (
                    <p className="mt-2 break-all text-[11px] text-(--text-muted)">
                      {t('settings.cliDiagnostics.rawLog')}: {provider.rawLogPath}
                    </p>
                  )}
                </div>
                <div className="text-xs text-(--text-muted) sm:text-right">
                  {provider.steps.receiveResponse.message || provider.steps.spawn.message || t('settings.cliDiagnostics.ok')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {exportResult && (
        <div className="space-y-1 text-xs text-(--text-muted)" data-testid="cli-diagnostics-export-result">
          <div>{t('settings.cliDiagnostics.exported')}</div>
          <div className="break-all">{exportResult.rawLogDir}</div>
          <div className="break-all">{exportResult.markdownPath}</div>
          <div className="break-all">{exportResult.jsonPath}</div>
        </div>
      )}

      {exportError && (
        <div className="text-xs text-red-600" role="alert">
          {exportError}
        </div>
      )}
    </div>
  );
}

function SummaryBadge({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-(--divider) px-2 py-0.5 text-(--text-muted)">
      <span>{label}</span>
      <span className="font-medium text-(--text-primary)">{value}</span>
    </span>
  );
}
