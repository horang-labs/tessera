import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseElectronWindowLayoutState,
  resolveVisibleWindowBounds,
  type WindowBounds,
} from '../electron/window-layout-state';

const mainBounds: WindowBounds = { x: 100, y: 120, width: 1400, height: 900 };
const popoutBounds: WindowBounds = { x: 1600, y: 80, width: 1000, height: 720 };

test('parses a complete main and board-popout layout', () => {
  const parsed = parseElectronWindowLayoutState(JSON.stringify({
    version: 1,
    main: { bounds: mainBounds, isMaximized: true, isFullScreen: false },
    popouts: [{
      bounds: popoutBounds,
      isMaximized: false,
      isFullScreen: true,
      route: '/board-popout?projectDir=__all_projects__&runningFilter=true',
    }],
  }));

  assert.deepEqual(parsed.main, {
    bounds: mainBounds,
    isMaximized: true,
    isFullScreen: false,
  });
  assert.equal(parsed.popouts.length, 1);
  assert.equal(parsed.popouts[0].route, '/board-popout?projectDir=__all_projects__&runningFilter=true');
  assert.equal(parsed.popouts[0].isFullScreen, true);
});

test('rejects malformed, external, and excessive popout entries', () => {
  const valid = {
    bounds: popoutBounds,
    isMaximized: false,
    isFullScreen: false,
    route: '/board-popout',
  };
  const parsed = parseElectronWindowLayoutState(JSON.stringify({
    version: 1,
    main: { bounds: { ...mainBounds, width: 20 } },
    popouts: [
      { ...valid, route: 'https://example.com/board-popout' },
      { ...valid, route: '/settings' },
      valid,
      valid,
      valid,
      valid,
      valid,
      valid,
    ],
  }));

  assert.equal(parsed.main, null);
  assert.equal(parsed.popouts.length, 5);
});

test('keeps visible bounds and drops coordinates from a disconnected monitor', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.deepEqual(resolveVisibleWindowBounds(mainBounds, displays), mainBounds);
  assert.equal(
    resolveVisibleWindowBounds({ x: 5000, y: 5000, width: 1200, height: 800 }, displays),
    undefined,
  );
});
