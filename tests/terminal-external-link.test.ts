import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalExternalLinkHandlers } from '../src/lib/terminal/terminal-external-link';

test('plain and OSC 8 terminal links use the same external URL opener', () => {
  const opened: string[] = [];
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } } as MouseEvent;
  const handlers = createTerminalExternalLinkHandlers((url) => {
    opened.push(url);
  });

  handlers.webLinkHandler(event, 'http://127.0.0.1:3100');
  handlers.oscLinkHandler.activate(event, 'https://example.com/docs', {
    start: { x: 1, y: 1 },
    end: { x: 10, y: 1 },
  });

  assert.deepEqual(opened, [
    'http://127.0.0.1:3100/',
    'https://example.com/docs',
  ]);
  assert.equal(prevented, 2);
});

test('terminal link handlers do not forward unsafe protocols', () => {
  const opened: string[] = [];
  const handlers = createTerminalExternalLinkHandlers((url) => {
    opened.push(url);
  });
  const event = { preventDefault: () => undefined } as MouseEvent;

  handlers.webLinkHandler(event, 'javascript:alert(1)');
  handlers.oscLinkHandler.activate(event, 'file:///tmp/report.html');

  assert.deepEqual(opened, []);
});
