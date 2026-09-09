import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_WORKSPACE_IMAGE_ZOOM,
  MIN_WORKSPACE_IMAGE_ZOOM,
  clampWorkspaceImageZoom,
  getAnchoredWorkspaceImageScrollOffset,
  getWorkspaceImageLayoutSize,
  getNextWorkspaceImageWheelZoom,
  getWorkspaceImagePanScrollOffset,
  getWorkspaceImageWheelZoomFactor,
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

test('zooms ordinary wheel input in the expected direction and clamps it', () => {
  assert.equal(getNextWorkspaceImageWheelZoom(1, -30, 0) > 1, true);
  assert.equal(getNextWorkspaceImageWheelZoom(1, 30, 0) < 1, true);
  assert.equal(getNextWorkspaceImageWheelZoom(MIN_WORKSPACE_IMAGE_ZOOM, 1000, 0), MIN_WORKSPACE_IMAGE_ZOOM);
  assert.equal(getNextWorkspaceImageWheelZoom(MAX_WORKSPACE_IMAGE_ZOOM, -1000, 0), MAX_WORKSPACE_IMAGE_ZOOM);
});

test('normalizes wheel delta modes and limits extreme events', () => {
  const pixelFactor = getWorkspaceImageWheelZoomFactor(1, 0);
  const lineFactor = getWorkspaceImageWheelZoomFactor(1, 1);
  const pageFactor = getWorkspaceImageWheelZoomFactor(1, 2);
  assert.equal(lineFactor < pixelFactor, true);
  assert.equal(pageFactor < lineFactor, true);
  assert.equal(
    getWorkspaceImageWheelZoomFactor(-10_000, 0),
    getWorkspaceImageWheelZoomFactor(-200, 0),
  );
  assert.equal(getWorkspaceImageWheelZoomFactor(0, 0), 1);
});

test('keeps the zoom anchor stable while panning in either direction', () => {
  assert.equal(
    getAnchoredWorkspaceImageScrollOffset({
      scrollOffset: 100,
      anchorOffset: 200,
      currentZoom: 1,
      nextZoom: 2,
    }),
    400,
  );
  assert.equal(
    getAnchoredWorkspaceImageScrollOffset({
      scrollOffset: 0,
      anchorOffset: 500,
      currentZoom: 1,
      nextZoom: 2,
      contentOrigin: 250,
      nextContentOrigin: 16,
    }),
    16,
  );
  assert.equal(
    getWorkspaceImagePanScrollOffset({
      startScrollOffset: 100,
      startPointerOffset: 300,
      currentPointerOffset: 250,
    }),
    150,
  );
  assert.equal(
    getWorkspaceImagePanScrollOffset({
      startScrollOffset: 100,
      startPointerOffset: 300,
      currentPointerOffset: 350,
    }),
    50,
  );
});
