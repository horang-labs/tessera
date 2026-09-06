# Terminal changes must cover every session surface

When changing PTY interactions (context menus, keyboard input, clipboard, drag and drop,
focus, or PTY/chat switching), inspect both the workspace panel and Kanban Session Peek.
Also check popout windows and embedded preview/log terminals when the changed code reaches them.
Shared terminal rendering does not imply shared wrappers, event routing, or capabilities.

- Trace the caller and DOM wrapper for each affected surface before editing.
- For Electron context menus, verify surface detection, native menu construction, IPC routing,
  and the mounted renderer listener in both PTY and terminal chat view.
- Keep capabilities explicit: Session Peek supports PTY/chat switching for supported providers,
  but has no workspace panel to split. Embedded log/preview terminals must not acquire
  workspace actions simply because they render a terminal.
- Add a regression test at the actual surface detection/menu boundary. Cover Peek without a
  workspace wrapper, both view directions, and unrelated surfaces retaining their behavior.
- When performing Electron E2E QA, exercise ordinary panels and Peek in the reported runtime
  topology, capture ordered screenshots, and copy them to Windows Downloads. State separately
  which behavior was unit-tested and which was verified in a real Electron window.

The September 2026 Peek context-menu regression happened because native menu detection required
`data-panel-wrapper`, which Session Peek does not mount. See
`electron/web-contents-context-menu.ts`, `src/components/chat/chat-area.tsx`, and
`tests/electron-terminal-context-menu.test.ts`.
