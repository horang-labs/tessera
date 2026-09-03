import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/components/image-generation/image-generations-panel.tsx', import.meta.url), 'utf8');

test('result and input images expose independent bottom-right download controls', () => {
  assert.match(source, /<ImageDownloadButton[\s\S]{0,180}url=\{result\.url\}/);
  assert.match(source, /<ImageDownloadButton[\s\S]{0,180}url=\{input\.url\}/);
  assert.match(source, /className="pointer-events-none absolute bottom-2 right-2/);
  assert.match(source, /download=\{imageDownloadFileName\(path, fallbackName\)\}/);
  assert.match(source, /draggable=\{false\}/);
});

test('download controls have dedicated telemetry and translated accessible names', () => {
  assert.match(source, /image_generation\.result\.download/);
  assert.match(source, /image_generation\.input\.download/);
  assert.match(source, /imagePanel\.downloadResult/);
  assert.match(source, /imagePanel\.downloadInput/);
});

test('download controls stay hidden until their image card is hovered or focused', () => {
  assert.match(source, /className="group relative"/);
  assert.match(source, /pointer-events-none[\s\S]{0,180}opacity-0[\s\S]{0,180}group-hover:opacity-100[\s\S]{0,180}group-focus-within:opacity-100/);
});
