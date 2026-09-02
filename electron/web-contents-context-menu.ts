import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import type { PanelSplitPlacement } from '../src/lib/panel/panel-split';

interface TerminalPanelContextMenuOptions {
  panelId: string;
  onSplit: (panelId: string, placement: PanelSplitPlacement) => void;
  viewMode?: 'terminal' | 'chat';
  onSwitchView?: (panelId: string, mode: 'terminal' | 'chat') => void;
}

interface FrameScriptRunner {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

const TERMINAL_PANEL_MENU_COPY = {
  switchToChatView: 'Switch to Chat View',
  switchToTerminalView: 'Switch to PTY View',
  splitPanel: 'Split Panel',
  placements: {
    left: 'New Panel on Left',
    right: 'New Panel on Right',
    up: 'New Panel Above',
    down: 'New Panel Below',
  },
};

const SPLIT_PLACEMENTS: PanelSplitPlacement[] = ['left', 'right', 'up', 'down'];

function menuItemEnabled(value: boolean | undefined): boolean {
  return value ?? true;
}

export function buildWebContentsContextMenuTemplate(
  params: ContextMenuParams,
  terminalPanel?: TerminalPanelContextMenuOptions,
): MenuItemConstructorOptions[] {
  if (terminalPanel) {
    return [
      ...(terminalPanel.onSwitchView && terminalPanel.viewMode
        ? [{
            label: terminalPanel.viewMode === 'chat'
              ? TERMINAL_PANEL_MENU_COPY.switchToTerminalView
              : TERMINAL_PANEL_MENU_COPY.switchToChatView,
            click: () => terminalPanel.onSwitchView?.(
              terminalPanel.panelId,
              terminalPanel.viewMode === 'chat' ? 'terminal' : 'chat',
            ),
          }, { type: 'separator' as const }]
        : []),
      {
        label: TERMINAL_PANEL_MENU_COPY.splitPanel,
        submenu: SPLIT_PLACEMENTS.map((placement) => ({
          label: TERMINAL_PANEL_MENU_COPY.placements[placement],
          click: () => terminalPanel.onSplit(terminalPanel.panelId, placement),
        })),
      },
    ];
  }

  const { editFlags } = params;
  let template: MenuItemConstructorOptions[];

  if (params.isEditable) {
    template = [
      { role: 'undo', enabled: menuItemEnabled(editFlags.canUndo) },
      { role: 'redo', enabled: menuItemEnabled(editFlags.canRedo) },
      { type: 'separator' },
      { role: 'cut', enabled: menuItemEnabled(editFlags.canCut) },
      { role: 'copy', enabled: menuItemEnabled(editFlags.canCopy) },
      { role: 'paste', enabled: menuItemEnabled(editFlags.canPaste) },
      { role: 'delete', enabled: menuItemEnabled(editFlags.canDelete) },
      { type: 'separator' },
      { role: 'selectAll', enabled: menuItemEnabled(editFlags.canSelectAll) },
    ];
  } else if (params.selectionText.length > 0) {
    template = [
      { role: 'copy', enabled: menuItemEnabled(editFlags.canCopy) },
      { type: 'separator' },
      { role: 'selectAll', enabled: menuItemEnabled(editFlags.canSelectAll) },
    ];
  } else {
    template = [];
  }

  return template;
}

/**
 * Resolve the terminal panel at the native-menu coordinates without replacing
 * Electron's edit-aware context menu with a renderer imitation. The matching
 * wrapper check excludes embedded log/preview terminals that cannot be split.
 */
export async function resolveTerminalPanelAtPoint(
  frame: FrameScriptRunner | null,
  x: number,
  y: number,
): Promise<{ panelId: string; viewMode: 'terminal' | 'chat' | null } | null> {
  if (!frame || frame.isDestroyed()) return null;

  const script = `(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const terminal = target instanceof Element
      ? target.closest('[data-terminal-panel-id]')
      : null;
    const sessionSurface = target instanceof Element
      ? target.closest('[data-terminal-session-panel-id]')
      : null;
    const context = terminal ?? sessionSurface;
    const wrapper = context?.closest('[data-panel-wrapper="true"][data-panel-id]');
    const terminalPanelId = terminal instanceof HTMLElement
      ? terminal.dataset.terminalPanelId
      : sessionSurface instanceof HTMLElement
        ? sessionSurface.dataset.terminalSessionPanelId
      : undefined;
    const wrapperPanelId = wrapper instanceof HTMLElement
      ? wrapper.dataset.panelId
      : undefined;
    return terminalPanelId && terminalPanelId === wrapperPanelId
      ? {
          panelId: terminalPanelId,
          viewMode: sessionSurface instanceof HTMLElement
            && sessionSurface.dataset.terminalChatViewAvailable === 'true'
            && (sessionSurface.dataset.terminalViewMode === 'terminal'
              || sessionSurface.dataset.terminalViewMode === 'chat')
              ? sessionSurface.dataset.terminalViewMode
              : terminal instanceof HTMLElement
                && terminal.dataset.terminalChatViewAvailable === 'true'
                ? 'terminal'
                : null,
        }
      : null;
  })()`;

  try {
    const result = await frame.executeJavaScript(script);
    if (!result || typeof result !== 'object') return null;
    const candidate = result as { panelId?: unknown; viewMode?: unknown };
    return typeof candidate.panelId === 'string'
      && candidate.panelId.length > 0
      && candidate.panelId.length <= 128
      && (candidate.viewMode === null
        || candidate.viewMode === 'terminal'
        || candidate.viewMode === 'chat')
      ? { panelId: candidate.panelId, viewMode: candidate.viewMode }
      : null;
  } catch {
    return null;
  }
}
