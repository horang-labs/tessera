'use client';

import { memo, useRef, useContext } from 'react';
import type { PanelNode } from '@/types/panel';
import { usePanelStore, TabIdContext } from '@/stores/panel-store';
import { PanelWrapper } from './panel-wrapper';
import { PanelDivider } from './panel-divider';
import { ChatArea } from '@/components/chat/chat-area';
import { EmptyPanelState } from '@/components/panel/empty-panel-state';
import { ARCHIVE_DASHBOARD_SESSION_ID, SKILLS_DASHBOARD_SESSION_ID } from '@/lib/constants/special-sessions';
import { SkillDashboard } from '@/components/skills/skill-dashboard';
import { ArchiveDashboard } from '@/components/archive/archive-dashboard';
import { WorkspaceExplorerTab } from '@/components/workspace/workspace-explorer-tab';
import { WorkspaceFileTab } from '@/components/workspace/workspace-file-tab';
import { TerminalPanel } from '@/components/terminal/terminal-panel';
import {
  parseWorkspaceExplorerSessionId,
  parseWorkspaceFileSessionId,
} from '@/lib/workspace-tabs/special-session';

// (Unit 2) BR-CONTAINER-002: anchorPanelId 계산용 순수 헬퍼 (export 없음)
function firstLeafId(node: PanelNode): string {
  if (node.type === 'leaf') return node.panelId;
  return firstLeafId(node.children[0]);
}

// leaf 노드 전용 컴포넌트 — hooks를 조건부가 아닌 최상위에서 호출
const PanelLeaf = memo(function PanelLeaf({ panelId }: { panelId: string }) {
  const tabId = useContext(TabIdContext);
  // 패널의 sessionId를 store에서 직접 구독 — panels 객체 전체 변경에 반응하지 않음
  const sessionId = usePanelStore(
    (state) => state.tabPanels[tabId]?.panels[panelId]?.sessionId ?? null,
  );
  const terminalId = usePanelStore(
    (state) => state.tabPanels[tabId]?.panels[panelId]?.terminalId ?? null,
  );
  const terminalSessionId = usePanelStore(
    (state) => state.tabPanels[tabId]?.panels[panelId]?.terminalSessionId ?? null,
  );

  const content = (() => {
    if (terminalId) {
      return (
        <TerminalPanel
          panelId={panelId}
          terminalId={terminalId}
          terminalSessionId={terminalSessionId}
        />
      );
    }
    if (sessionId === SKILLS_DASHBOARD_SESSION_ID) return <SkillDashboard />;
    if (sessionId === ARCHIVE_DASHBOARD_SESSION_ID) return <ArchiveDashboard />;
    if (sessionId) {
      const explorerRef = parseWorkspaceExplorerSessionId(sessionId);
      if (explorerRef) return <WorkspaceExplorerTab key={sessionId} explorerRef={explorerRef} />;
      const fileRef = parseWorkspaceFileSessionId(sessionId);
      if (fileRef) return <WorkspaceFileTab key={sessionId} fileRef={fileRef} panelId={panelId} />;
    }
    if (sessionId) return <ChatArea sessionId={sessionId} panelId={panelId} />;
    return <EmptyPanelState panelId={panelId} />;
  })();

  return <PanelWrapper panelId={panelId}>{content}</PanelWrapper>;
});

const PanelContainer = memo(function PanelContainer({
  node,
}: {
  node: PanelNode;
}) {
  const resizeSplit = usePanelStore((state) => state.resizeSplit);

  // BR-CONTAINER-001: 항상 useRef 호출 (React Hook 규칙 -- 조건부 호출 금지)
  const containerRef = useRef<HTMLDivElement>(null);

  if (node.type === 'leaf') {
    return <PanelLeaf panelId={node.panelId} />;
  }

  // split 노드 (Unit 2: containerRef, anchorPanelId, resizeSplit 연동)
  const isHorizontal = node.type === 'hsplit';
  const leftAnchorId = firstLeafId(node.children[0]);   // BR-CONTAINER-002
  const rightAnchorId = firstLeafId(node.children[1]);

  return (
    <div
      ref={containerRef}                                  // BR-CONTAINER-001
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        width: '100%',
        height: '100%',
      }}
    >
      <div style={{ flex: node.ratio, overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
        <PanelContainer node={node.children[0]} />
      </div>
      <PanelDivider
        direction={isHorizontal ? 'horizontal' : 'vertical'}
        initialRatio={node.ratio}
        onResize={(r) => resizeSplit(leftAnchorId, rightAnchorId, r)}  // BR-CONTAINER-003
        containerRef={containerRef}
      />
      <div style={{ flex: 1 - node.ratio, overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
        <PanelContainer node={node.children[1]} />
      </div>
    </div>
  );
});

export default PanelContainer;
