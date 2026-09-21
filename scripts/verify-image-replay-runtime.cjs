const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const asar = require('@electron/asar');

const workerPath = 'runtime/image-reference-replay-worker.cjs';
const runtimeFiles = [workerPath, 'runtime/image-reference-replay.cjs', 'runtime/image-record-reader.cjs', 'runtime/replay-state-codec.cjs'];

/** Verify shipped bytes in isolation: never resolve dependencies from the build worktree. */
async function verifyImageReplayRuntime(source) {
  const archive = source.endsWith('.asar');
  const entries = archive ? asar.listPackage(source).map(entry => entry.replace(/^[/\\]+/, '').replaceAll('\\', '/')) : [];
  const read = async relative => archive ? asar.extractFile(source, relative) : fs.readFile(path.join(source, relative));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-image-runtime-'));
  try {
    const copy = async relative => {
      const bytes = await read(relative);
      const target = path.join(temporary, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    };
    for (const file of runtimeFiles) await copy(file);
    // QuickJS variants include runtime-selected JS/WASM files. Copy their actual
    // packaged dependency trees, including assets that static tracing may miss.
    const pending = ['quickjs-emscripten', 'acorn'];
    const visited = new Set();
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw Error(`Invalid runtime dependency: ${name}`);
      visited.add(name);
      const prefix = `node_modules/${name}`;
      const manifest = JSON.parse((await read(`${prefix}/package.json`)).toString());
      if (archive) {
        for (const entry of entries.filter(entry => entry.startsWith(`${prefix}/`))) {
          const stat = asar.statFile(source, entry);
          if (stat.files) continue;
          if (stat.link) throw Error(`Unexpected runtime symlink: ${entry}`);
          await copy(entry);
        }
      } else {
        await fs.mkdir(path.dirname(path.join(temporary, prefix)), { recursive: true });
        await fs.cp(path.join(source, prefix), path.join(temporary, prefix), { recursive: true, dereference: true });
      }
      pending.push(...Object.keys(manifest.dependencies ?? {}));
    }
    const record = payload => JSON.stringify({ type: 'response_item', payload }) + '\n';
    const fixture = record({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'build-check',
      input: 'const refs = ["/build-check.png"].map(p => p); void tools.image_gen__imagegen({prompt:"build check",referenced_image_paths:refs});' });
    const transcript = path.join(temporary, 'metadata.jsonl');
    await fs.writeFile(transcript, fixture);
    await new Promise((resolve, reject) => {
      const worker = new Worker(`
        const path = require('node:path');
        const Module = require('node:module');
        const { workerData } = require('node:worker_threads');
        const original = Module._resolveFilename;
        Module._resolveFilename = function(...args) {
          const resolved = original.apply(this, args);
          if (!Module.isBuiltin(resolved)) {
            const relative = path.relative(workerData.root, resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Runtime dependency escaped packaged files: ' + resolved);
          }
          return resolved;
        };
        require(path.join(workerData.root, ${JSON.stringify(workerPath)}));
      `, { eval: true, execArgv: [], workerData: { root: temporary },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 } });
      let finished = false;
      const finish = async error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        await worker.terminate();
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => void finish(Error('Worker/WASM startup exceeded 15 seconds')), 15_000);
      worker.once('error', error => void finish(error));
      worker.once('exit', code => { if (!finished) void finish(Error(`Worker exited before verification (${code})`)); });
      worker.once('message', reply => {
        const refs = reply.result?.invocations?.[0]?.referencedImagePaths;
        if (reply.error || reply.result?.invocations?.length !== 1 || refs?.length !== 1 || refs[0] !== '/build-check.png') {
          void finish(Error(reply.error ?? 'Worker failed the reference replay smoke test'));
        } else void finish();
      });
      worker.postMessage({ id: 1, sessionId: 'build-check', path: transcript, offset: Buffer.byteLength(fixture), reset: true });
    });
  } catch (error) {
    throw new Error(`Image replay runtime verification failed (${source}): ${error.message}`, { cause: error });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { verifyImageReplayRuntime };
if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node scripts/verify-image-replay-runtime.cjs <runtime-directory|app.asar>'); process.exitCode = 1; }
  else verifyImageReplayRuntime(path.resolve(process.argv[2])).then(
    () => console.log('Image replay worker, dependencies and WASM verified'),
    error => { console.error(error.message); process.exitCode = 1; },
  );
}
