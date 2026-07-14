import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { useBoardStore } from '@/stores/board-store';

test('all projects can select and restore its own board view mode', () => {
  const previous = useBoardStore.getState();

  try {
    useBoardStore.setState({
      selectedProjectDir: ALL_PROJECTS_SENTINEL,
      viewMode: 'list',
      projectViewModes: {},
    });

    useBoardStore.getState().setViewMode('board');
    assert.equal(useBoardStore.getState().viewMode, 'board');

    useBoardStore.getState().setSelectedProjectDir('alpha');
    useBoardStore.getState().setViewMode('list');
    useBoardStore.getState().setSelectedProjectDir(ALL_PROJECTS_SENTINEL);

    assert.equal(useBoardStore.getState().viewMode, 'board');
    assert.equal(useBoardStore.getState().projectViewModes[ALL_PROJECTS_SENTINEL], 'board');
  } finally {
    useBoardStore.setState({
      selectedProjectDir: previous.selectedProjectDir,
      viewMode: previous.viewMode,
      projectViewModes: previous.projectViewModes,
    });
  }
});

