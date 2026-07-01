'use client';

import { memo, useState } from 'react';
import {
  Loader2,
  Check,
  X,
  Ban,
  Circle,
  CircleSlash,
  Clock,
  Zap,
  Wrench,
  Bot,
  FileText,
  ChevronRight,
  ChevronDown,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import type { WorkflowMessage } from '@/types/chat';
import type { WorkflowAgentEntry, WorkflowPhaseEntry } from '@/types/cli-jsonl-schemas';
import { useLiveElapsed } from '@/hooks/use-live-elapsed';
import { cn } from '@/lib/utils';
import { MESSAGE_BODY_OFFSET_CLASS } from '../message-layout';
import { MessageRowShell } from '../message-row-shell';

interface WorkflowCardProps {
  message: WorkflowMessage;
  alignWithMessageBody?: boolean;
  /** Render full-width for the composer status bar (no message-body offset/max-width). */
  docked?: boolean;
  /** Initial collapsed state (e.g. completed runs start collapsed in the bar). */
  defaultCollapsed?: boolean;
}

type AgentLifecycle = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped';

function agentLifecycle(agent: WorkflowAgentEntry): AgentLifecycle {
  if (agent.state === 'done') return 'done';
  if (agent.state === 'failed') return 'failed';
  if (agent.state === 'skipped') return 'skipped';
  if (agent.state === 'start' && !agent.agentId) return 'queued';
  return 'running';
}

function isSettled(l: AgentLifecycle): boolean {
  return l === 'done' || l === 'failed' || l === 'skipped';
}

/** "claude-opus-4-8[1m]" → "opus 4.8" */
function shortModel(model?: string): string | null {
  if (!model) return null;
  const m = model.match(/(opus|sonnet|haiku|fable)-(\d+)-?(\d+)?/i);
  if (m) return `${m[1].toLowerCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  return model.length > 16 ? model.slice(0, 16) + '…' : model;
}

function formatTokens(n?: number): string | null {
  if (!n || n <= 0) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatSeconds(ms?: number): string | null {
  if (ms == null || ms <= 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── meta stat (icon + value), shared by header and agent rows ─────────────────
function Stat({ icon: Icon, children, className }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', className)}>
      <Icon className="h-2.5 w-2.5 opacity-70" />
      {children}
    </span>
  );
}

const AGENT_ICON: Record<AgentLifecycle, React.ReactNode> = {
  running: <Loader2 className="h-3 w-3 animate-spin text-(--accent)" />,
  done: <Check className="h-3 w-3 text-(--success)" />,
  failed: <X className="h-3 w-3 text-(--error)" />,
  skipped: <Ban className="h-3 w-3 text-(--text-muted)" />,
  queued: <Circle className="h-3 w-3 text-(--text-muted) opacity-50" />,
  stopped: <CircleSlash className="h-3 w-3 text-(--text-muted)" />,
};

const WorkflowAgentRow = memo(function WorkflowAgentRow({
  agent,
  workflowRunning,
}: {
  agent: WorkflowAgentEntry;
  workflowRunning: boolean;
}) {
  const rawLifecycle = agentLifecycle(agent);
  // The live timer must stop once the workflow itself is no longer running —
  // otherwise an agent left mid-flight (e.g. the run was stopped) keeps ticking.
  const isActive = (rawLifecycle === 'running' || rawLifecycle === 'queued') && workflowRunning;
  const liveElapsed = useLiveElapsed({
    isActive,
    startTime: agent.startedAt ? new Date(agent.startedAt).toISOString() : null,
  });
  // An unfinished agent on a finished workflow is "stopped", not running.
  const lifecycle: AgentLifecycle =
    !workflowRunning && (rawLifecycle === 'running' || rawLifecycle === 'queued')
      ? 'stopped'
      : rawLifecycle;

  const model = shortModel(agent.model);
  const tokens = formatTokens(agent.tokens);
  const duration =
    lifecycle === 'running'
      ? formatSeconds(liveElapsed)
      : lifecycle === 'done' || lifecycle === 'failed' || lifecycle === 'skipped'
        ? formatSeconds(agent.durationMs)
        : null;
  const hasDetail = Boolean(
    (lifecycle === 'done' && agent.resultPreview) || lifecycle === 'failed' || agent.promptPreview,
  );

  return (
    <div className="group/agent flex min-w-0 items-center gap-2 overflow-hidden rounded-md py-1 pl-2 pr-1 text-[11px] transition-colors hover:bg-(--sidebar-hover)">
      <span className="shrink-0">{AGENT_ICON[lifecycle]}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className={cn(
            'shrink-0 truncate font-medium text-(--text-secondary)',
            hasDetail ? 'max-w-[45%]' : 'max-w-full',
          )}
          title={agent.label}
        >
          {agent.label}
        </span>

        {lifecycle === 'done' && agent.resultPreview ? (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0 text-(--text-muted)">→</span>
            <span className="min-w-0 flex-1 truncate font-mono text-(--status-success-text)" title={agent.resultPreview}>
              {agent.resultPreview}
            </span>
          </span>
        ) : lifecycle === 'failed' ? (
          <span className="min-w-0 flex-1 truncate text-(--status-error-text)">failed{agent.attempt && agent.attempt > 1 ? ` · ${agent.attempt} tries` : ''}</span>
        ) : agent.promptPreview ? (
          <span className="min-w-0 flex-1 truncate italic text-(--text-muted)" title={agent.promptPreview}>
            {agent.promptPreview}
          </span>
        ) : null}
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[10px] text-(--text-muted)">
        {model && <span className="font-mono opacity-80">{model}</span>}
        {duration && <Stat icon={Clock}>{duration}</Stat>}
        {tokens && <Stat icon={Zap}>{tokens}</Stat>}
      </span>
    </div>
  );
});

function PhaseGroup({
  phase,
  agents,
  workflowRunning,
}: {
  phase: WorkflowPhaseEntry | null;
  agents: WorkflowAgentEntry[];
  workflowRunning: boolean;
}) {
  const done = agents.filter((a) => isSettled(agentLifecycle(a))).length;
  const running = workflowRunning && agents.some((a) => agentLifecycle(a) === 'running');

  return (
    <div className="mt-2 first:mt-0">
      {phase && (
        <div className="mb-1 flex items-center gap-1.5 pl-0.5 text-[10px] font-medium uppercase tracking-wider text-(--text-muted)">
          <span className={cn('h-1.5 w-1.5 rounded-full', running ? 'bg-(--accent) animate-pulse' : done === agents.length && agents.length > 0 ? 'bg-(--success)' : 'bg-(--text-muted)/40')} />
          <span className="text-(--text-secondary)">{phase.title}</span>
          {agents.length > 0 && <span className="ml-auto tabular-nums normal-case tracking-normal">{done}/{agents.length}</span>}
        </div>
      )}
      {agents.length > 0 && (
        <div className="ml-[3px] border-l border-(--divider) pl-2">
          {agents.map((agent) => (
            <WorkflowAgentRow key={agent.index} agent={agent} workflowRunning={workflowRunning} />
          ))}
        </div>
      )}
    </div>
  );
}

export const WorkflowCard = memo(function WorkflowCard({
  message,
  alignWithMessageBody = true,
  docked = false,
  defaultCollapsed = false,
}: WorkflowCardProps) {
  const { status, workflowName, description, phases, agents, logs, usage, outputFile } = message;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const liveElapsed = useLiveElapsed({ isActive: status === 'running', startTime: message.startedAt });
  const elapsed = status === 'running'
    ? formatSeconds(liveElapsed)
    : usage?.durationMs != null
      ? formatSeconds(usage.durationMs)
      : message.endedAt && message.startedAt
        ? formatSeconds(Math.max(0, new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()))
        : null;

  const settledCount = agents.filter((a) => isSettled(agentLifecycle(a))).length;
  const progress = agents.length > 0 ? settledCount / agents.length : status === 'running' ? 0 : 1;
  const totalTokens = formatTokens(usage?.totalTokens);

  const running = status === 'running';
  const failed = status === 'failed';

  const barColor = failed ? 'bg-(--error)' : running ? 'bg-(--accent)' : 'bg-(--success)';
  const statusPill = running
    ? { cls: 'bg-(--accent)/12 text-(--accent)', label: 'Running', icon: <Loader2 className="h-3 w-3 animate-spin" /> }
    : failed
      ? { cls: 'bg-(--status-error-bg) text-(--status-error-text)', label: 'Failed', icon: <X className="h-3 w-3" /> }
      : { cls: 'bg-(--status-success-bg) text-(--status-success-text)', label: 'Completed', icon: <Check className="h-3 w-3" /> };

  // Group agents by phase index, preserving phase order; orphans last.
  const phaseByIndex = new Map(phases.map((p) => [p.index, p]));
  const groups: Array<{ phase: WorkflowPhaseEntry | null; agents: WorkflowAgentEntry[] }> = [];
  const groupIndex = new Map<number | 'none', number>();
  for (const phase of phases) {
    groupIndex.set(phase.index, groups.length);
    groups.push({ phase, agents: [] });
  }
  for (const agent of agents) {
    const key = agent.phaseIndex != null && phaseByIndex.has(agent.phaseIndex) ? agent.phaseIndex : 'none';
    let gi = groupIndex.get(key);
    if (gi == null) { gi = groups.length; groupIndex.set(key, gi); groups.push({ phase: null, agents: [] }); }
    groups[gi].agents.push(agent);
  }
  const renderableGroups = groups.filter((g) => g.agents.length > 0 || g.phase);

  const content = (
    <div
      className={cn(
        'relative rounded-lg border bg-(--tool-bg) transition-shadow',
        docked ? 'w-full' : 'my-1 max-w-2xl',
        !docked && alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS,
        running ? 'border-(--accent)/25 ring-1 ring-(--accent)/10' : failed ? 'border-(--status-error-border)' : 'border-(--tool-border)',
      )}
      data-testid="workflow-card"
    >
      {/* signature: agents-settled progress rail across the top edge */}
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-lg bg-(--tool-param-bg)">
        <div
          className={cn('h-full rounded-r-full transition-[width] duration-500 ease-out', barColor, running && 'animate-pulse')}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      {/* Header (click to collapse) */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 pb-1.5 pt-2 text-left"
      >
        {collapsed ? <ChevronRight className="h-3 w-3 shrink-0 text-(--text-muted)" /> : <ChevronDown className="h-3 w-3 shrink-0 text-(--text-muted)" />}
        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-(--text-primary)">{workflowName}</span>

        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium', statusPill.cls)}>
          {statusPill.icon}
          {statusPill.label}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-3 text-[10px] text-(--text-muted)">
          {agents.length > 0 && <Stat icon={Bot}>{settledCount}/{agents.length}</Stat>}
          {totalTokens && <Stat icon={Zap}>{totalTokens}</Stat>}
          {usage?.toolUses != null && usage.toolUses > 0 && <Stat icon={Wrench}>{usage.toolUses}</Stat>}
          {elapsed && <Stat icon={Clock}>{elapsed}</Stat>}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2.5">
          {description && description !== workflowName && (
            <div className="mb-1.5 text-[11px] leading-snug text-(--text-muted)">{description}</div>
          )}

          {renderableGroups.map((group, i) => (
            <PhaseGroup key={group.phase ? `p${group.phase.index}` : `none-${i}`} phase={group.phase} agents={group.agents} workflowRunning={running} />
          ))}

          {logs.length > 0 && (
            <div className="mt-2 space-y-0.5 rounded-md bg-(--tool-param-bg) px-2 py-1.5">
              {logs.slice(-5).map((line, i) => (
                <div key={i} className="truncate font-mono text-[10px] leading-relaxed text-(--text-muted)" title={line}>
                  <span className="opacity-50">›</span> {line}
                </div>
              ))}
            </div>
          )}

          {outputFile && (
            <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md bg-(--tool-param-bg) px-2 py-1 text-[10px] text-(--text-muted)">
              <FileText className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate font-mono" title={outputFile}>{outputFile}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (!alignWithMessageBody) return content;
  return <MessageRowShell>{content}</MessageRowShell>;
});
