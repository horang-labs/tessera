import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_WORKSPACE_IMAGE_ZOOM,
  MIN_WORKSPACE_IMAGE_ZOOM,
  clampWorkspaceImageZoom,
  getWorkspaceImageLayoutSize,
} from '../src/lib/workspace-files/workspace-image-zoom';

test('clamps workspace image zoom to the Orca-compatible range', () => {
  assert.equal(clampWorkspaceImageZoom(0.01), MIN_WORKSPACE_IMAGE_ZOOM);
  assert.equal(clampWorkspaceImageZoom(2), 2);
  assert.equal(clampWorkspaceImageZoom(20), MAX_WORKSPACE_IMAGE_ZOOM);
});

test('fits large images without upscaling small images at 100%', () => {
  assert.deepEqual(
    getWorkspaceImageLayoutSize({
      imageSize: { width: 1600, height: 1200 },
      surfaceSize: { width: 832, height: 632 },
      zoom: 1,
    }),
    { width: 800, height: 600 },
  );
  assert.deepEqual(
    getWorkspaceImageLayoutSize({
      imageSize: { width: 320, height: 200 },
      surfaceSize: { width: 832, height: 632 },
      zoom: 1,
    }),
    { width: 320, height: 200 },
  );
});

test('uses layout dimensions for zoom so the full image remains scrollable', () => {
  assert.deepEqual(
    getWorkspaceImageLayoutSize({
      imageSize: { width: 1600, height: 1200 },
      surfaceSize: { width: 832, height: 632 },
      zoom: 2,
    }),
    { width: 1600, height: 1200 },
  );
  assert.equal(
    getWorkspaceImageLayoutSize({ imageSize: null, surfaceSize: null, zoom: 1 }),
    null,
  );
});
