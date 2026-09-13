import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
process.env.NODE_ENV = 'test';

test('worker serializes sessions and does not leak stored inputs between them', async () => {
  const { replayImageReferences } = await import('../src/lib/image-generation/replay-worker');
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.image-replay-worker-test-'));
  const record = (payload: unknown) => JSON.stringify({ type: 'response_item', payload }) + '\n';
  const call = (id: string, input: string) => record({ type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const output = (id: string) => record({ type: 'custom_tool_call_output', call_id: id, output: [] });
  try {
    const a = path.join(directory, 'a.jsonl'), b = path.join(directory, 'b.jsonl');
    await fs.writeFile(a, call('store', 'store("private",["/a.png"]);') + output('store')
      + call('generate-a', 'void tools.image_gen__imagegen({prompt:"a",referenced_image_paths:load("private")});'));
    await fs.writeFile(b, call('generate-b', 'void tools.image_gen__imagegen({prompt:"b",referenced_image_paths:load("private")});'));
    const request = async (sessionId: string, file: string) => replayImageReferences({ sessionId, path: file, offset: (await fs.stat(file)).size });
    const [first, second] = await Promise.all([request('a', a), request('b', b)]);
    assert.deepEqual(first.invocations[0].referencedImagePaths, ['/a.png']);
    assert.equal(second.invocations[0].referencedImagePaths, undefined);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(replayImageReferences({ sessionId: 'a', path: a, offset: 0 }, aborted.signal), /aborted/);
    const looping = path.join(directory, 'loop.jsonl');
    await fs.writeFile(looping, call('loop', 'while(true){}') + output('loop'));
    const running = new AbortController();
    const interrupted = replayImageReferences({ sessionId: 'loop', path: looping, offset: (await fs.stat(looping)).size }, running.signal);
    const timer = setTimeout(() => running.abort(), 100);
    await assert.rejects(interrupted, /aborted/);
    clearTimeout(timer);
    assert.deepEqual((await request('a', a)).invocations[0].referencedImagePaths, ['/a.png']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
