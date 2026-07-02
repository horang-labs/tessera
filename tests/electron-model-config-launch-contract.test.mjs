import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const serverChildSource = fs.readFileSync(
  path.join(root, 'electron', 'server-child.ts'),
  'utf8',
);

test('Electron server child refreshes remote model config on app launch', () => {
  assert.match(
    serverChildSource,
    /import \{ setModelConfigBroadcast, triggerModelConfigRefresh \} from '\.\.\/src\/lib\/model-config\/refresh';/,
  );
  assert.match(
    serverChildSource,
    /import \{ ensureRemoteModelConfigLoaded \} from '\.\.\/src\/lib\/model-config\/remote-config';/,
  );
  assert.match(serverChildSource, /return ensureRemoteModelConfigLoaded\(\);/);
  assert.match(serverChildSource, /setModelConfigBroadcast\(\(msg\) => wsServer\.broadcast\(msg\)\);/);
  assert.match(serverChildSource, /void triggerModelConfigRefresh\('launch'\);/);
});
