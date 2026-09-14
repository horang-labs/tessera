import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [codeView, fileTab, videoViewer] = await Promise.all([
  readFile(new URL('../src/components/workspace/workspace-code-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/workspace/workspace-file-tab.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/workspace/workspace-video-viewer.tsx', import.meta.url), 'utf8'),
]);

test('workspace video preview remains a read-only native video surface', () => {
  assert.match(codeView, /isWorkspaceVideoMimeType/);
  assert.match(codeView, /fileData\?\.binary && !isImageFile && !isVideoFile/);
  assert.match(codeView, /!isImageFile && !isVideoFile \? <Tooltip content=\{copied/);
  assert.match(codeView, /!isImageFile && !isVideoFile && fileData\?\.truncated/);
  assert.match(codeView, /<WorkspaceVideoViewer/);
  assert.match(fileTab, /!isWorkspaceVideoMimeType\(fileData\.mimeType\)/);
  assert.match(videoViewer, /\bcontrols\b/);
  assert.match(videoViewer, /\bplaysInline\b/);
  assert.match(videoViewer, /preload="metadata"/);
  assert.doesNotMatch(videoViewer, /\bautoPlay\b/);
  assert.match(videoViewer, /max-h-full max-w-full object-contain/);
  assert.doesNotMatch(videoViewer, /ZoomIn|ZoomOut|setZoom|ResizeObserver/);
});

test('workspace video preview isolates controls and pauses when hidden or unmounted', () => {
  assert.match(codeView, /active=\{previewActive\}/);
  assert.match(fileTab, /previewActive=\{isTabActive && isDocumentVisible\}/);
  assert.match(videoViewer, /event\.stopPropagation\(\)/);
  assert.match(videoViewer, /if \(!active\) videoRef\.current\?\.pause\(\)/);
  assert.match(videoViewer, /useEffect\(\(\) => \(\) => \{\s*videoRef\.current\?\.pause\(\);/);
  assert.match(videoViewer, /key=\{previewSrc\}/);
  assert.match(codeView, /key=\{videoRawUrl\}/);
});
