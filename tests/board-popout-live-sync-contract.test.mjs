import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const clientMessageHandlersSource = fs.readFileSync(
  new URL('../src/lib/ws/client-message-handlers.ts', import.meta.url),
  'utf8',
);
const serverSource = fs.readFileSync(
  new URL('../src/lib/ws/server.ts', import.meta.url),
  'utf8',
);
const serverSessionActionsSource = fs.readFileSync(
  new URL('../src/lib/ws/server-session-actions.ts', import.meta.url),
  'utf8',
);
const messageTypesSource = fs.readFileSync(
  new URL('../src/lib/ws/message-types.ts', import.meta.url),
  'utf8',
);
const mutationBroadcastSource = fs.readFileSync(
  new URL('../src/lib/ws/mutation-broadcast.ts', import.meta.url),
  'utf8',
);
const generateTitleRouteSource = fs.readFileSync(
  new URL('../src/app/api/sessions/[id]/generate-title/route.ts', import.meta.url),
  'utf8',
);
const sessionStoreSource = fs.readFileSync(
  new URL('../src/stores/session-store.ts', import.meta.url),
  'utf8',
);
const taskStoreSource = fs.readFileSync(
  new URL('../src/stores/task-store.ts', import.meta.url),
  'utf8',
);
const crossWindowUiSyncSource = fs.readFileSync(
  new URL('../src/hooks/use-cross-window-ui-sync.ts', import.meta.url),
  'utf8',
);
const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
const electronPreloadSource = fs.readFileSync(
  new URL('../electron/preload.ts', import.meta.url),
  'utf8',
);
const panelWrapperSource = fs.readFileSync(
  new URL('../src/components/panel/panel-wrapper.tsx', import.meta.url),
  'utf8',
);
const sessionClickHandlersSource = fs.readFileSync(
  new URL('../src/hooks/use-session-click-handlers.ts', import.meta.url),
  'utf8',
);
const notificationCenterSource = fs.readFileSync(
  new URL('../src/components/notifications/notification-center.tsx', import.meta.url),
  'utf8',
);
const toastContainerSource = fs.readFileSync(
  new URL('../src/components/notifications/toast-container.tsx', import.meta.url),
  'utf8',
);
const toastNotificationSource = fs.readFileSync(
  new URL('../src/components/notifications/toast-notification.tsx', import.meta.url),
  'utf8',
);

test('live replay events mark background popout cards as processing', () => {
  assert.match(clientMessageHandlersSource, /startTurnInFlight/);
  assert.match(clientMessageHandlersSource, /function replayEventsIndicateActiveTurn/);
  assert.match(clientMessageHandlersSource, /case 'replay_events':[\s\S]*if \(shouldStartTurnFromReplayEvents\(sessionStore, msg\.sessionId, msg\.events\)\) \{\s*startTurnInFlight\(msg\.sessionId\);/);
  assert.match(clientMessageHandlersSource, /function shouldStartTurnFromReplayEvents/);
  assert.match(clientMessageHandlersSource, /\(session\?\.unreadCount \?\? 0\) > 0/);
  assert.match(clientMessageHandlersSource, /event\.hookEvent === 'waiting_for_task' \|\| event\.progressType === 'waiting_for_task'/);
  assert.match(clientMessageHandlersSource, /case 'tool_call':\s*return event\.status === 'running';/);
  assert.match(clientMessageHandlersSource, /case 'interactive_prompt_response':\s*return true;/);
});

test('mark-as-read broadcasts clear unread state to board popouts', () => {
  assert.match(clientMessageHandlersSource, /case 'unread_cleared':\s*sessionStore\.clearUnreadCount\(msg\.sessionId\);\s*useNotificationStore\.getState\(\)\.markSessionAsRead\(msg\.sessionId\);/);
  assert.match(panelWrapperSource, /wsClient\.sendMarkAsRead\(sessionId\);/);
  assert.match(panelWrapperSource, /sessionUnreadCount <= 0/);
  assert.match(sessionClickHandlersSource, /\(session\.unreadCount \?\? 0\) > 0/);
  assert.match(sessionClickHandlersSource, /wsClient\.sendMarkAsRead\(session\.id\);/);
  assert.match(notificationCenterSource, /wsClient\.sendMarkAsRead\(sessionId\);/);
  assert.match(notificationCenterSource, /function handleMarkAllAsRead|const handleMarkAllAsRead =/);
  assert.match(toastContainerSource, /wsClient\.sendMarkAsRead\(sessionId\);/);
  assert.match(toastNotificationSource, /wsClient\.sendMarkAsRead\(notification\.sessionId\);/);
});

test('interactive prompt responses clear waiting state in every window', () => {
  assert.match(serverSessionActionsSource, /sendInteractivePromptResponseReplayEvent/);
  assert.match(serverSessionActionsSource, /type: 'replay_events'/);
  assert.match(serverSessionActionsSource, /type: 'interactive_prompt_response'/);
  assert.match(clientMessageHandlersSource, /case 'interactive_prompt_response':\s*return true;/);
  assert.match(clientMessageHandlersSource, /chatStore\.setActiveInteractivePrompt\(session\.id, session\.activeInteractivePrompt \?\? null\);/);
  assert.match(clientMessageHandlersSource, /stopTurnInFlight\(session\.id\);/);
  assert.match(serverSource, /sessionHistory\.readReplayState\(p\.sessionId/);
  assert.match(serverSource, /activeInteractivePrompt: replayState\?\.activeInteractivePrompt \?\? null/);
  assert.match(messageTypesSource, /activeInteractivePrompt\?: import\('@\/types\/chat'\)\.ActiveInteractivePrompt \| null;/);
});

test('AI title generation state is broadcast and restored in popouts', () => {
  assert.match(messageTypesSource, /type: 'session_title_generation';\s*sessionId: string;\s*isGenerating: boolean;/);
  assert.match(messageTypesSource, /titleGeneratingSessionIds\?: string\[\];/);
  assert.match(mutationBroadcastSource, /function broadcastSessionTitleGeneration/);
  assert.match(generateTitleRouteSource, /beginTitleGeneration\(userId, sessionId\)/);
  assert.match(generateTitleRouteSource, /broadcastSessionTitleGeneration\(userId, sessionId, true\)/);
  assert.match(generateTitleRouteSource, /endTitleGeneration\(userId, sessionId\)/);
  assert.match(generateTitleRouteSource, /broadcastSessionTitleGeneration\(userId, sessionId, false\)/);
  assert.match(serverSource, /titleGeneratingSessionIds: getGeneratingTitleSessionIds\(userId\)/);
  assert.match(clientMessageHandlersSource, /case 'session_title_generation':\s*sessionStore\.setGeneratingTitle\(msg\.sessionId, msg\.isGenerating\);/);
  assert.match(clientMessageHandlersSource, /setGeneratingTitleIds\(titleGeneratingSessionIds\);/);
  assert.match(sessionStoreSource, /setGeneratingTitleIds: \(sessionIds: readonly string\[\]\) => void;/);
});

test('collection filter changes are mirrored between main and board popouts', () => {
  assert.match(crossWindowUiSyncSource, /uiCollectionFilterChanged\?: \(collectionId: string \| null\) => void;/);
  assert.match(crossWindowUiSyncSource, /onUiCollectionFilterChanged/);
  assert.match(crossWindowUiSyncSource, /activeCollectionFilter/);
  assert.match(crossWindowUiSyncSource, /setCollectionFilter\(collectionId\);/);
  assert.match(electronMainSource, /ipcMain\.on\('ui-collection-filter-changed'/);
  assert.match(electronMainSource, /win\.webContents\.send\('ui-collection-filter-changed', \{ collectionId \}\);/);
  assert.match(electronPreloadSource, /uiCollectionFilterChanged: \(collectionId: string \| null\) =>/);
  assert.match(electronPreloadSource, /onUiCollectionFilterChanged/);
});

test('task reloads requested during an in-flight reload are replayed for popout creation sync', () => {
  assert.match(taskStoreSource, /queuedProjectLoads: Record<string, QueuedProjectLoad>;/);
  assert.match(taskStoreSource, /if \(get\(\)\.loadingProjectIds\[projectId\]\) \{/);
  assert.match(taskStoreSource, /queuedProjectLoads:\s*\{\s*\.\.\.state\.queuedProjectLoads,\s*\[projectId\]: \{/);
  assert.match(taskStoreSource, /const queuedLoad = get\(\)\.queuedProjectLoads\[projectId\];/);
  assert.match(taskStoreSource, /void get\(\)\.loadTasks\(projectId, \{ setCurrent: queuedLoad\.setCurrent \}\);/);
});
