'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Star, RefreshCw, Square, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useSkillAnalysisStore } from '@/stores/skill-analysis-store';
import { useWebSocket } from '@/hooks/use-websocket';
import type { SkillInfo } from '@/hooks/use-skill-picker';
import type {
  SkillAnalysis,
  SkillDetail,
} from '@/lib/skill/skill-analysis-types';
import { CLAUDE_MODELS } from '@/lib/cli/provider-session-option-definitions';
import { SkillCard } from './skill-card';
import {
  CategoryAccordion,
  buildSkillDashboardCategories,
  formatTimeAgo,
  getShortName,
} from './skill-dashboard-sections';
import { useI18n } from '@/lib/i18n';

const EMPTY_FAVORITE_SKILLS: string[] = [];

type SkillDashboardTab = 'claude' | 'codex';

interface SkillDashboardMeta {
  claudeAvailable?: boolean;
  configDir?: string;
  environment?: string;
}

// ─── Main Dashboard ───

export function SkillDashboard() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SkillDashboardTab>('claude');
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([]);
  const [skillsMeta, setSkillsMeta] = useState<SkillDashboardMeta | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [fallbackAnalysis, setFallbackAnalysis] = useState<SkillAnalysis | null>(null);
  const favoriteSkills = useSettingsStore((s) => s.settings.favoriteSkills) ?? EMPTY_FAVORITE_SKILLS;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadSettings = useSettingsStore((s) => s.load);

  useWebSocket();

  const analysisStatus = useSkillAnalysisStore((s) => s.status);
  const analysisSkillCount = useSkillAnalysisStore((s) => s.skillCount);
  const analysisError = useSkillAnalysisStore((s) => s.error);
  const analysisResult = useSkillAnalysisStore((s) => s.result);
  const analysisModel = useSkillAnalysisStore((s) => s.model);
  const completedCount = useSkillAnalysisStore((s) => s.completedCount);
  const totalCount = useSkillAnalysisStore((s) => s.totalCount);
  const currentJobs = useSkillAnalysisStore((s) => s.currentJobs);

  const isAnalyzing = analysisStatus === 'scanning' || analysisStatus === 'analyzing';
  const activeAnalysis = analysisResult ?? fallbackAnalysis;

  useEffect(() => {
    loadSettings();
    Promise.all([
      fetch('/api/skills').then((r) => {
        if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
        return r.json();
      }),
      fetch('/api/skills/analyze').then((r) => {
        if (r.status === 401) throw new Error('Unauthorized');
        return r.json();
      }),
    ])
      .then(([skillsData, analysisData]) => {
        setAllSkills(skillsData.skills || []);
        setSkillsMeta(skillsData.meta || null);
        if (analysisData.analysis && !useSkillAnalysisStore.getState().result) {
          setFallbackAnalysis(analysisData.analysis);
        }
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, [loadSettings]);

  // Model selector
  const [analysisModelChoice, setAnalysisModelChoice] = useState(
    () => CLAUDE_MODELS.find((m) => m.isDefault)?.value ?? CLAUDE_MODELS[0].value,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelMenuOpen]);

  const handleRefreshAnalysis = useCallback(() => {
    fetch('/api/skills/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: analysisModelChoice }),
    }).catch(console.error);
  }, [analysisModelChoice]);

  const handleCancelAnalysis = useCallback(() => {
    fetch('/api/skills/analyze', { method: 'DELETE' }).catch(console.error);
  }, []);

  const toggleFavorite = useCallback(
    (skillName: string) => {
      const isFav = favoriteSkills.includes(skillName);
      updateSettings({
        favoriteSkills: isFav
          ? favoriteSkills.filter((n) => n !== skillName)
          : [...favoriteSkills, skillName],
      });
    },
    [favoriteSkills, updateSettings],
  );

  const skillAnalysisMap = useMemo(() => {
    const map = new Map<string, SkillDetail>();
    if (!activeAnalysis) return map;
    for (const plugin of activeAnalysis.plugins ?? [])
      for (const skill of plugin.skills ?? [])
        map.set(skill.name, skill);
    for (const s of activeAnalysis.standaloneSkills ?? [])
      map.set(s.name, { name: s.name, displayName: s.displayName, summary: s.summary, whenToUse: s.whenToUse, role: 'core', order: 1 });
    return map;
  }, [activeAnalysis]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery) return allSkills;
    const q = searchQuery.toLowerCase();
    return allSkills.filter((s) => {
      const d = skillAnalysisMap.get(s.name);
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) ||
        d?.displayName?.toLowerCase().includes(q) || d?.summary?.toLowerCase().includes(q);
    });
  }, [allSkills, searchQuery, skillAnalysisMap]);

  const { categories, standalone } = useMemo(
    () => buildSkillDashboardCategories(filteredSkills, activeAnalysis, t),
    [filteredSkills, activeAnalysis, t],
  );

  const favoriteSkillInfos = useMemo(
    () => favoriteSkills.map((n) => allSkills.find((s) => s.name === n)).filter((s): s is SkillInfo => !!s),
    [favoriteSkills, allSkills],
  );

  const modelDisplayName = analysisModel
    ? (CLAUDE_MODELS.find((m) => m.value === analysisModel)?.label ?? analysisModel)
    : 'Claude';

  const progressPct = (completedCount != null && totalCount && totalCount > 0)
    ? Math.round((completedCount / totalCount) * 100) : 0;

  const hasClaudeSkills = categories.length > 0 || standalone.length > 0;
  const showClaudeContent = activeTab === 'claude';
  const canUseClaudeSkills = showClaudeContent && skillsMeta?.claudeAvailable !== false;
  const disabledStatusText = activeTab === 'codex'
    ? t('skill.codexDashboardStatus')
    : t('skill.claudeUnavailable');
  const searchPlaceholder = activeTab === 'codex'
    ? t('skill.codexSearchPlaceholder')
    : t('skill.searchPlaceholder');

  return (
    <div className="h-full overflow-y-auto bg-(--chat-bg)">
      {/* Sticky Header */}
      <header className="sticky top-0 z-10 border-b border-(--divider)" style={{ backgroundColor: 'var(--chat-header-bg)' }}>
        <div className="max-w-[1140px] mx-auto px-6 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold font-mono text-(--text-primary) flex-1 tracking-tight">
              {t('skill.dashboardTitle')}
            </h1>
            <div className="flex min-h-8 items-center justify-end gap-2 shrink-0">
              {canUseClaudeSkills ? (
                <>
                {activeAnalysis && !isAnalyzing && (
                  <span className="text-[11px] text-(--text-muted)">
                    {formatTimeAgo(activeAnalysis.generatedAt, t)} {t('skill.analyzedSuffix')}
                  </span>
                )}
                <div className="relative" ref={modelMenuRef}>
                  <button
                    onClick={() => setModelMenuOpen(!modelMenuOpen)}
                    disabled={isAnalyzing}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs',
                      'border border-(--divider)',
                      'text-(--text-secondary) hover:text-(--text-primary)',
                      'hover:bg-(--sidebar-hover) transition-colors',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    {CLAUDE_MODELS.find((m) => m.value === analysisModelChoice)?.label ?? analysisModelChoice}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {modelMenuOpen && (
                    <div className="absolute right-0 top-full mt-1 py-1 rounded-md shadow-lg z-20 min-w-[100px] border border-(--divider)" style={{ backgroundColor: 'var(--chat-header-bg)' }}>
                      {CLAUDE_MODELS.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => { setAnalysisModelChoice(m.value); setModelMenuOpen(false); }}
                          className={cn(
                            'w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-(--sidebar-hover)',
                            analysisModelChoice === m.value ? 'text-(--accent) font-medium' : 'text-(--text-secondary)',
                          )}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {isAnalyzing ? (
                  <button onClick={handleCancelAnalysis} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-(--status-error-border) text-(--status-error-text) hover:bg-(--status-error-bg) transition-colors">
                    <Square className="w-3 h-3 fill-current" />
                    <span>{t('skill.stopAnalysis')}</span>
                  </button>
                ) : (
                  <button onClick={handleRefreshAnalysis} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-(--divider) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--sidebar-hover) transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{t('skill.generateAnalysis')}</span>
                  </button>
                )}
                </>
              ) : (
                <span className="hidden max-w-[320px] truncate rounded-md border border-(--divider) px-2.5 py-1.5 text-xs text-(--text-muted) sm:inline-flex">
                  {disabledStatusText}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex w-fit rounded-md border border-(--divider) bg-(--bg-secondary) p-0.5">
              <button
                type="button"
                onClick={() => setActiveTab('claude')}
                className={cn(
                  'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                  activeTab === 'claude'
                    ? 'bg-(--chat-header-bg) text-(--text-primary) shadow-sm'
                    : 'text-(--text-muted) hover:text-(--text-secondary)',
                )}
              >
                {t('skill.claudeTab')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('codex')}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors',
                  activeTab === 'codex'
                    ? 'bg-(--chat-header-bg) text-(--text-primary) shadow-sm'
                    : 'text-(--text-muted) hover:text-(--text-secondary)',
                )}
              >
                <span>{t('skill.codexTab')}</span>
                <span className="rounded-full border border-(--divider) px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-(--text-muted)">
                  {t('skill.comingSoon')}
                </span>
              </button>
            </div>
            <div className="min-h-[1rem] min-w-0 break-all text-[11px] text-(--text-muted) sm:text-right">
              {activeTab === 'codex' ? (
                t('skill.codexDashboardScope')
              ) : skillsMeta?.configDir ? (
                <>
                  {t('skill.serverEnvironmentScope', { environment: skillsMeta.environment || 'server' })}
                  {' '}
                  <span className="mx-1 text-(--divider)">·</span>
                  {' '}
                  <span className="font-mono">{skillsMeta.configDir}</span>
                </>
              ) : (
                <span className="invisible">.</span>
              )}
            </div>
          </div>

          <div className="relative">
            <Search className={cn(
              'absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-(--text-muted)',
              !canUseClaudeSkills && 'opacity-60',
            )} />
            <input
              type="text"
              value={showClaudeContent ? searchQuery : ''}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={!canUseClaudeSkills}
              placeholder={searchPlaceholder}
              className={cn(
                'w-full rounded-md border border-(--input-border) bg-(--input-bg) py-1.5 pl-9 pr-3 text-xs text-(--input-text) placeholder:text-(--input-placeholder) focus:border-(--accent)/50 focus:outline-none',
                !canUseClaudeSkills && 'cursor-not-allowed opacity-70',
              )}
            />
          </div>
        </div>
      </header>

      {/* Progress Banner */}
      {showClaudeContent && isAnalyzing && (
        <div className="max-w-[1140px] mx-auto px-6 pt-4">
          <div className="p-3 rounded-lg bg-(--bg-secondary) border border-(--divider)">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-2 h-2 rounded-full bg-(--accent) animate-pulse shrink-0" />
              <span className="text-xs text-(--text-secondary) flex-1">
                {analysisStatus === 'scanning'
                  ? (analysisSkillCount ? t('skill.scanningWithCount', { count: analysisSkillCount }) : t('skill.scanning'))
                  : t('skill.analyzingWithModel', { model: modelDisplayName })}
              </span>
              {totalCount != null && totalCount > 0 && (
                <span className="text-[10px] font-mono text-(--text-muted)">
                  {completedCount ?? 0}/{totalCount}
                </span>
              )}
            </div>
            {totalCount != null && totalCount > 0 && (
              <div className="w-full h-[3px] bg-(--divider) rounded-full overflow-hidden mb-2">
                <div className="h-full bg-(--accent) rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
              </div>
            )}
            {currentJobs && currentJobs.length > 0 && (
              <div className="text-[11px] font-mono text-(--text-muted) flex flex-wrap gap-x-2 gap-y-0.5">
                <span>{t('skill.analyzingLabel')}</span>
                {currentJobs.map((job) => (
                  <span key={job} className="text-(--text-secondary) font-medium">{job}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {showClaudeContent && analysisError && analysisStatus === 'failed' && (
        <div className="max-w-[1140px] mx-auto px-6 pt-4">
          <div className="p-3 rounded-lg bg-(--status-error-bg) border border-(--status-error-border)">
            <span className="text-xs text-(--status-error-text)">{analysisError}</span>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="max-w-[1140px] mx-auto px-6 py-5 space-y-2">
        {activeTab === 'codex' ? (
          <section className="min-h-[320px] flex justify-center pt-16 text-center sm:pt-20">
            <div className="max-w-[460px]">
              <div className="inline-flex items-center rounded-full border border-(--divider) px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-(--text-muted) mb-3">
                {t('skill.comingSoon')}
              </div>
              <h2 className="text-lg font-semibold text-(--text-primary) mb-2">
                {t('skill.codexComingSoonTitle')}
              </h2>
              <p className="text-sm text-(--text-muted) leading-6">
                {t('skill.codexComingSoonDescription')}
              </p>
            </div>
          </section>
        ) : isLoading ? (
          <div className="text-center py-20 text-(--text-muted) text-sm">{t('skill.loading')}</div>
        ) : (
          <>
            {!hasClaudeSkills && !searchQuery && (
              <div className="text-center py-20 text-(--text-muted) text-sm">
                <div className="font-medium text-(--text-secondary) mb-1">
                  {skillsMeta?.claudeAvailable === false
                    ? t('skill.claudeUnavailable')
                    : t('skill.noClaudeSkills')}
                </div>
                {skillsMeta?.configDir && (
                  <div className="text-xs">
                    {t('skill.claudeConfigPath', { path: skillsMeta.configDir })}
                  </div>
                )}
              </div>
            )}

            {/* Favorites */}
            {favoriteSkillInfos.length > 0 && !searchQuery && (
              <section className="mb-5">
                <h2 className="flex items-center gap-2 text-xs font-semibold text-(--accent) mb-2">
                  <Star className="w-3.5 h-3.5 fill-current" />
                  {t('skill.favoritesWithCount', { count: favoriteSkillInfos.length })}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1.5">
                  {favoriteSkillInfos.map((skill) => (
                    <SkillCard key={skill.name} skill={skill} shortName={getShortName(skill.name)}
                      isFavorite onToggleFavorite={() => toggleFavorite(skill.name)}
                      analysis={skillAnalysisMap.get(skill.name)} />
                  ))}
                </div>
              </section>
            )}

            {/* Categories */}
            {categories.map((cat, idx) => (
              <CategoryAccordion
                key={cat.category}
                category={cat}
                skillAnalysisMap={skillAnalysisMap}
                favoriteSkills={favoriteSkills}
                onToggleFavorite={toggleFavorite}
                defaultOpen={idx < 2}
              />
            ))}

            {/* Standalone */}
            {standalone.length > 0 && (
              <section className="pt-5 mt-3 border-t border-(--divider)">
                <h2 className="text-[10px] font-semibold text-(--text-muted) uppercase tracking-wider mb-2">
                  {t('skill.standaloneWithCount', { count: standalone.length })}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1.5">
                  {standalone.map((skill) => (
                    <SkillCard key={skill.name} skill={skill} shortName={getShortName(skill.name)}
                      isFavorite={favoriteSkills.includes(skill.name)}
                      onToggleFavorite={() => toggleFavorite(skill.name)}
                      analysis={skillAnalysisMap.get(skill.name)} />
                  ))}
                </div>
              </section>
            )}

            {!hasClaudeSkills && searchQuery && (
              <div className="text-center py-20 text-(--text-muted) text-sm">
                {t('skill.noSearchResultsFor', { query: searchQuery })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
