import type { Tab } from '@/types/tab';
import type { Panel, PanelNode, TabPanelData } from '@/types/panel';

export type TabMergeFailureReason = 'too-few-tabs' | 'stale-selection' | 'invalid-panel-data' | 'duplicate-session-conflict' | 'terminal-ownership-conflict';
export type TabMergePlan = { ok: true; sourceTabIds: string[]; panels: Panel[]; insertionIndex: number; projectDir: string | null; deduplicatedCount: number } | { ok: false; reason: TabMergeFailureReason };

function leaves(node: PanelNode): string[] {
  return node.type === 'leaf' ? [node.panelId] : [...leaves(node.children[0]), ...leaves(node.children[1])];
}

export function planTabMerge(tabs: readonly Tab[], tabPanels: Record<string, TabPanelData>, selectedIds: readonly string[]): TabMergePlan {
  const selected = new Set(selectedIds);
  if (selected.size < 2) return { ok: false, reason: 'too-few-tabs' };
  const sources = tabs.filter((tab) => selected.has(tab.id));
  if (sources.length !== selected.size) return { ok: false, reason: 'stale-selection' };
  const panels: Panel[] = [];
  const seenPanelIds = new Set<string>();
  const sessions = new Map<string, Panel>();
  const terminals = new Set<string>();
  let deduplicatedCount = 0;
  for (const tab of sources) {
    const data = tabPanels[tab.id];
    if (!data || !data.panels[data.activePanelId]) return { ok: false, reason: 'invalid-panel-data' };
    const leafIds = leaves(data.layout);
    if (leafIds.length !== Object.keys(data.panels).length || new Set(leafIds).size !== leafIds.length) return { ok: false, reason: 'invalid-panel-data' };
    for (const id of leafIds) {
      const panel = data.panels[id];
      if (!panel || panel.id !== id || seenPanelIds.has(id)) return { ok: false, reason: 'invalid-panel-data' };
      seenPanelIds.add(id);
      if (panel.terminalId) {
        if (terminals.has(panel.terminalId)) return { ok: false, reason: 'terminal-ownership-conflict' };
        terminals.add(panel.terminalId);
      }
      if (panel.sessionId) {
        const existing = sessions.get(panel.sessionId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(panel)) return { ok: false, reason: 'duplicate-session-conflict' };
          deduplicatedCount++;
          continue;
        }
        sessions.set(panel.sessionId, panel);
      }
      panels.push(panel);
    }
  }
  if (!panels.length) return { ok: false, reason: 'invalid-panel-data' };
  const dirs = new Set(sources.map((tab) => tab.projectDir));
  return { ok: true, sourceTabIds: sources.map((tab) => tab.id), panels, insertionIndex: tabs.indexOf(sources[0]!), projectDir: dirs.size === 1 ? sources[0]!.projectDir : null, deduplicatedCount };
}
