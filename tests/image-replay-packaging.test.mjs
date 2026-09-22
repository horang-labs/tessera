import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asar = require('@electron/asar');
const { verifyImageReplayRuntime } = require('../scripts/verify-image-replay-runtime.cjs');

test('packaged replay starts in isolation and missing dependencies or WASM fail verification', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-replay-package-test-'));
  const source = path.join(directory, 'app');
  const archive = path.join(directory, 'app.asar');
  try {
    await fs.mkdir(path.join(source, 'runtime'), { recursive: true });
    for (const name of ['image-reference-replay-worker.cjs', 'image-reference-replay.cjs', 'image-record-reader.cjs', 'replay-state-codec.cjs']) {
      await fs.copyFile(path.join(__dirname, '..', 'runtime', name), path.join(source, 'runtime', name));
    }
    const pending = ['quickjs-emscripten', 'acorn'];
    const seen = new Set();
    while (pending.length) {
      const name = pending.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const original = path.join(__dirname, '..', 'node_modules', name);
      const target = path.join(source, 'node_modules', name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(original, target, { recursive: true, dereference: true });
      pending.push(...Object.keys(JSON.parse(await fs.readFile(path.join(original, 'package.json'), 'utf8')).dependencies ?? {}));
    }
    await t.test('complete staged directory and actual ASAR execute the worker', async () => {
      await verifyImageReplayRuntime(source);
      await asar.createPackage(source, archive);
      await verifyImageReplayRuntime(archive);
    });
    await t.test('a symlinked temporary directory preserves the packaged dependency boundary', async () => {
      const alias = path.join(directory, 'temp-alias');
      const real = path.join(directory, 'temp-real');
      await fs.mkdir(real);
      await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const originalTmpdir = os.tmpdir;
      os.tmpdir = () => alias;
      try { await verifyImageReplayRuntime(source); }
      finally { os.tmpdir = originalTmpdir; }
    });
    for (const relative of ['node_modules/quickjs-emscripten', 'node_modules/quickjs-emscripten-core',
      'runtime/image-reference-replay-worker.cjs', 'runtime/image-record-reader.cjs', 'runtime/replay-state-codec.cjs',
      'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm']) {
      await t.test(`fails with missing ${relative}`, async () => {
        const target = path.join(source, relative);
        const saved = path.join(directory, 'removed');
        await fs.rename(target, saved);
        try {
          await asar.createPackage(source, archive);
          await assert.rejects(verifyImageReplayRuntime(archive), /Image replay runtime verification failed/);
        } finally { await fs.rename(saved, target); }
      });
    }
    await t.test('common afterPack hook rejects the damaged archive before handing off a build', async () => {
      // The last packed archive has its WASM deliberately removed.
      const output = path.join(directory, 'packed');
      await fs.mkdir(path.join(output, 'resources'), { recursive: true });
      await fs.copyFile(archive, path.join(output, 'resources', 'app.asar'));
      const afterPack = require('../scripts/electron-after-pack.cjs');
      await assert.rejects(afterPack({ electronPlatformName: 'win32', arch: 1, appOutDir: output }),
        /Image replay runtime verification failed/);
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
