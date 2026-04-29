'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsDark } from '@/hooks/use-is-dark';
import { useI18n } from '@/lib/i18n';
import type { SkillInfo } from '@/hooks/use-skill-picker';
import type {
  SkillAnalysis,
  PluginAnalysis,
  SkillDetail,
} from '@/lib/skill/skill-analysis-types';
import { SkillCard } from './skill-card';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function getNamespace(name: string) {
  const separatorIndex = name.indexOf(':');
  return separatorIndex !== -1 ? name.slice(0, separatorIndex) : '_standalone';
}

const TAG_COLORS: Array<{ bg: string; text: string; darkBg: string; darkText: string }> = [
  { bg: 'rgba(22,163,74,.08)', text: '#15803d', darkBg: 'rgba(110,201,117,.1)', darkText: '#6ec975' },
  { bg: 'rgba(37,99,235,.08)', text: '#1d4ed8', darkBg: 'rgba(91,156,245,.1)', darkText: '#5b9cf5' },
  { bg: 'rgba(124,58,237,.08)', text: '#6d28d9', darkBg: 'rgba(157,134,224,.1)', darkText: '#9d86e0' },
  { bg: 'rgba(217,119,6,.08)', text: '#b45309', darkBg: 'rgba(232,168,76,.1)', darkText: '#e8a84c' },
  { bg: 'rgba(190,24,93,.08)', text: '#9d174d', darkBg: 'rgba(216,129,166,.1)', darkText: '#d881a6' },
  { bg: 'rgba(13,148,136,.08)', text: '#0f766e', darkBg: 'rgba(91,192,190,.1)', darkText: '#5bc0be' },
  { bg: 'rgba(202,138,4,.08)', text: '#a16207', darkBg: 'rgba(250,204,21,.1)', darkText: '#d4a820' },
  { bg: 'rgba(220,38,38,.08)', text: '#b91c1c', darkBg: 'rgba(248,113,113,.1)', darkText: '#f87171' },
  { bg: 'rgba(101,163,13,.08)', text: '#4d7c0f', darkBg: 'rgba(163,230,53,.1)', darkText: '#84cc16' },
  { bg: 'rgba(79,70,229,.08)', text: '#4338ca', darkBg: 'rgba(129,140,248,.1)', darkText: '#818cf8' },
];

const UNCATEGORIZED_TAG_COLOR = {
  bg: 'rgba(0,0,0,.04)',
  text: '#8b8b95',
  darkBg: 'rgba(255,255,255,.04)',
  darkText: '#8b8b95',
};

export interface PluginView {
  namespace: string;
  label: string;
  pluginAnalysis?: PluginAnalysis;
  skills: SkillInfo[];
}

export interface CategoryView {
  category: string;
  displayName: string;
  tag: string;
  summary: string;
  tagColor: { bg: string; text: string; darkBg: string; darkText: string };
  plugins: PluginView[];
  totalSkills: number;
}

function makeCategoryTag(category: string): string {
  return category
    .split('-')
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 4);
}

export function getShortName(name: string) {
  const separatorIndex = name.indexOf(':');
  return separatorIndex !== -1 ? name.slice(separatorIndex + 1) : name;
}

export function formatTimeAgo(isoDate: string, t: TranslateFn): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('time.just');
  if (minutes < 60) return t('time.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { hours });
  return t('time.daysAgo', { days: Math.floor(hours / 24) });
}

export function buildSkillDashboardCategories(
  allSkills: SkillInfo[],
  analysis: SkillAnalysis | null,
  t: TranslateFn,
): { categories: CategoryView[]; standalone: SkillInfo[] } {
  const skillsByNamespace = new Map<string, SkillInfo[]>();
  const standaloneSkills: SkillInfo[] = [];

  for (const skill of allSkills) {
    const namespace = getNamespace(skill.name);
    if (namespace === '_standalone') {
      standaloneSkills.push(skill);
      continue;
    }

    if (!skillsByNamespace.has(namespace)) {
      skillsByNamespace.set(namespace, []);
    }
    skillsByNamespace.get(namespace)!.push(skill);
  }

  const pluginAnalysisMap = new Map<string, PluginAnalysis>();
  for (const plugin of analysis?.plugins ?? []) {
    pluginAnalysisMap.set(plugin.namespace, plugin);
  }

  const buildPluginView = (namespace: string): PluginView => {
    const pluginAnalysis = pluginAnalysisMap.get(namespace);
    const skills = skillsByNamespace.get(namespace) || [];

    if (pluginAnalysis) {
      const orderMap = new Map<string, number>();
      for (const skill of pluginAnalysis.skills ?? []) {
        orderMap.set(skill.name, skill.order ?? 999);
      }
      skills.sort((left, right) => (orderMap.get(left.name) ?? 999) - (orderMap.get(right.name) ?? 999));
    }

    return {
      namespace,
      label: pluginAnalysis?.displayName || namespace,
      pluginAnalysis,
      skills,
    };
  };

  const groupedNamespaces = new Set<string>();
  const categories = (analysis?.groups ?? [])
    .map((group, index) => {
      const plugins: PluginView[] = [];
      for (const namespace of group.pluginOrder) {
        groupedNamespaces.add(namespace);
        if (skillsByNamespace.has(namespace)) {
          plugins.push(buildPluginView(namespace));
        }
      }

      return {
        category: group.category,
        displayName: group.displayName,
        tag: makeCategoryTag(group.category),
        summary: group.summary,
        tagColor: TAG_COLORS[index % TAG_COLORS.length],
        plugins,
        totalSkills: plugins.reduce((sum, plugin) => sum + plugin.skills.length, 0),
      };
    })
    .filter((category) => category.plugins.length > 0);

  const ungroupedPlugins: PluginView[] = [];
  for (const namespace of skillsByNamespace.keys()) {
    if (!groupedNamespaces.has(namespace)) {
      ungroupedPlugins.push(buildPluginView(namespace));
    }
  }

  if (ungroupedPlugins.length > 0) {
    ungroupedPlugins.sort((left, right) => left.label.localeCompare(right.label));
    categories.push({
      category: 'uncategorized',
      displayName: t('skill.uncategorized'),
      tag: 'ETC',
      summary: t('skill.uncategorizedSummary'),
      tagColor: UNCATEGORIZED_TAG_COLOR,
      plugins: ungroupedPlugins,
      totalSkills: ungroupedPlugins.reduce((sum, plugin) => sum + plugin.skills.length, 0),
    });
  }

  return {
    categories,
    standalone: standaloneSkills,
  };
}

function WorkflowChips({ steps }: { steps: PluginAnalysis['workflow'] }) {
  if (!steps || steps.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto scrollbar-none px-4 pb-2">
      {steps.map((step, index) => (
        <div key={step.skillName} className="flex items-center gap-1 shrink-0">
          {index > 0 && <span className="text-[9px] text-(--text-muted)">→</span>}
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-(--accent)/8 text-(--accent)">
            {step.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}

function PluginCard({
  plugin,
  skillAnalysisMap,
  favoriteSkills,
  onToggleFavorite,
}: {
  plugin: PluginView;
  skillAnalysisMap: Map<string, SkillDetail>;
  favoriteSkills: string[];
  onToggleFavorite: (name: string) => void;
}) {
  const { t } = useI18n();
  const pluginAnalysis = plugin.pluginAnalysis;

  return (
    <div className="mt-3 first:mt-0 rounded-lg border border-(--divider) bg-(--chat-bg) overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-0.5">
          {pluginAnalysis?.displayName ? (
            <>
              <span className="text-sm font-semibold text-(--text-primary)">
                {pluginAnalysis.displayName}
              </span>
              <span className="text-sm font-mono text-(--text-muted)">
                {plugin.namespace}
              </span>
            </>
          ) : (
            <span className="text-sm font-mono font-semibold text-(--text-primary)">
              {plugin.namespace}
            </span>
          )}
          <span className="text-[10px] font-mono text-(--text-muted) ml-auto">
            {t('skill.skillsCount', { count: plugin.skills.length })}
          </span>
        </div>
        {pluginAnalysis?.summary && (
          <p className="text-xs text-(--text-muted) leading-relaxed mt-1">
            {pluginAnalysis.summary}
          </p>
        )}
      </div>

      {pluginAnalysis?.workflow && pluginAnalysis.workflow.length > 0 && (
        <WorkflowChips steps={pluginAnalysis.workflow} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1.5 px-3 pb-3">
        {plugin.skills.map((skill) => (
          <SkillCard
            key={skill.name}
            skill={skill}
            shortName={getShortName(skill.name)}
            isFavorite={favoriteSkills.includes(skill.name)}
            onToggleFavorite={() => onToggleFavorite(skill.name)}
            analysis={skillAnalysisMap.get(skill.name)}
          />
        ))}
      </div>
    </div>
  );
}

export function CategoryAccordion({
  category,
  skillAnalysisMap,
  favoriteSkills,
  onToggleFavorite,
  defaultOpen,
}: {
  category: CategoryView;
  skillAnalysisMap: Map<string, SkillDetail>;
  favoriteSkills: string[];
  onToggleFavorite: (name: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { t } = useI18n();
  const isDark = useIsDark();
  const tagBg = isDark ? category.tagColor.darkBg : category.tagColor.bg;
  const tagText = isDark ? category.tagColor.darkText : category.tagColor.text;

  return (
    <section className={cn(
      'rounded-xl border overflow-hidden transition-colors',
      'bg-(--bg-secondary) border-(--divider)',
    )}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 w-full px-4 py-3 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        <ChevronRight className={cn(
          'w-3.5 h-3.5 text-(--text-muted) transition-transform duration-200 shrink-0',
          open && 'rotate-90',
        )} />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
          style={{ background: tagBg, color: tagText }}
        >
          {category.tag}
        </span>
        <span className="text-[13px] font-semibold text-(--text-primary) shrink-0">
          {category.displayName}
        </span>
        <span className="text-[11px] text-(--text-muted) hidden sm:inline truncate min-w-0 flex-1">
          {category.summary}
        </span>
        <span className="text-[10px] font-mono text-(--text-muted) ml-auto shrink-0">
          {t('skill.pluginsCount', { count: category.plugins.length })} · {t('skill.skillsCount', { count: category.totalSkills })}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {category.summary && category.category !== 'uncategorized' && (
            <p
              className="text-xs text-(--text-secondary) leading-relaxed mb-3 px-3 py-2.5 rounded-md"
              style={{ background: tagBg }}
            >
              {category.summary}
            </p>
          )}
          {category.plugins.map((plugin) => (
            <PluginCard
              key={plugin.namespace}
              plugin={plugin}
              skillAnalysisMap={skillAnalysisMap}
              favoriteSkills={favoriteSkills}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>
      )}
    </section>
  );
}
