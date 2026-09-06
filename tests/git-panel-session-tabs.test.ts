import assert from 'node:assert/strict';
import test from 'node:test';
import { useGitStore } from '@/stores/git-store';

test('right panel remembers each session independently and persists selections', () => {
  const store = useGitStore.getState();
  store.setPanelTab('files', 'session-a');
  store.setPanelTab('memory', 'session-b');
  assert.equal(useGitStore.getState().getPanelTab('session-a'), 'files');
  assert.equal(useGitStore.getState().getPanelTab('session-b'), 'memory');
  assert.equal(useGitStore.getState().getPanelTab('session-new'), 'git');
  store.openTab('scripts', 'session-b');
  assert.equal(useGitStore.getState().getPanelTab('session-a'), 'files');
  store.openConflictRecovery('session-b');
  assert.equal(useGitStore.getState().getPanelTab('session-b'), 'git');
  assert.equal(useGitStore.getState().getPanelTab('session-a'), 'files');
  const persisted = useGitStore.persist.getOptions().partialize!(useGitStore.getState());
  assert.equal(persisted.panelTabsBySessionId['session-a'], 'files');
});

test('rehydration restores session tabs and legacy global tabs do not leak into sessions', async () => {
  useGitStore.getState().setPanelTab('files', 'session-a');
  useGitStore.getState().setPanelTab('git', 'session-b');
  const options = useGitStore.persist.getOptions();
  const saved = options.partialize!(useGitStore.getState());
  try {
    useGitStore.persist.setOptions({
      storage: {
        getItem: () => ({ state: saved, version: 0 }),
        setItem: () => {},
        removeItem: () => {},
      },
    });
    useGitStore.setState({ panelTabsBySessionId: {} });
    await useGitStore.persist.rehydrate();
    assert.equal(useGitStore.getState().getPanelTab('session-a'), 'files');
    assert.equal(useGitStore.getState().getPanelTab('session-b'), 'git');

    useGitStore.persist.setOptions({
      storage: {
        getItem: () => ({ state: { panelTab: 'images' }, version: 0 }),
        setItem: () => {},
        removeItem: () => {},
      },
    });
    useGitStore.setState({ panelTabsBySessionId: {} });
    await useGitStore.persist.rehydrate();
    assert.equal(useGitStore.getState().getPanelTab(null), 'images');
    assert.equal(useGitStore.getState().getPanelTab('session-new'), 'git');
  } finally {
    useGitStore.persist.setOptions({ storage: options.storage });
  }
});
