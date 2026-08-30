import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectExpandedWorkspacePaths,
  useWorkspaceFileViewStore,
} from '../src/stores/workspace-file-view-store';

test('expanded folders survive switching to another workspace and back', () => {
  useWorkspaceFileViewStore.setState({ expandedPathsByWorkspace: {} });

  const store = useWorkspaceFileViewStore.getState();
  store.setExpandedPaths('session:alpha', ['src', 'src/components']);
  store.setExpandedPaths('session:beta', ['tests']);

  assert.deepEqual(
    selectExpandedWorkspacePaths('session:alpha')(useWorkspaceFileViewStore.getState()),
    ['src', 'src/components'],
  );
  assert.deepEqual(
    selectExpandedWorkspacePaths('session:beta')(useWorkspaceFileViewStore.getState()),
    ['tests'],
  );
});
