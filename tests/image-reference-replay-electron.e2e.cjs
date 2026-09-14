// Run with Windows Node against a launcher-owned Windows backend and WSL fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('@playwright/test');
const { crc32, deflateSync } = require('node:zlib');

function solidPng(color) {
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193);
  for (let row = 0; row < 64; row++) {
    for (let column = 0; column < 64; column++) {
      Buffer.from(color).copy(pixels, row * 193 + 1 + column * 3);
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const [manifestPath, fixtureDirectory, linuxDirectory, artifactDirectory] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(manifest.sessionId.startsWith('codex-0906ke-image-refs'));
  const instance = manifest.instances[0];
  assert.notEqual(instance.serverPort, 32123);
  assert.ok(instance.dataDir.includes('TesseraTestInstances'));
  assert.ok(fixtureDirectory.includes('image-index-qa-0906ke'));
  assert.ok(linuxDirectory.startsWith('/home/work/tmp/image-index-qa-0906ke'));
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const names = ['frame.png', '싹냥이.png', '골냥이.png'];
  const inputBytes = [[52,100,180], [232,157,62], [60,155,110]].map(solidPng);
  const png = inputBytes[0].toString('base64');
  for (const [index, name] of names.entries()) fs.writeFileSync(path.join(fixtureDirectory, name), inputBytes[index]);
  const refs = names.map(name => `${linuxDirectory}/${name}`);
  const file = path.join(fixtureDirectory, 'rollout.jsonl');
  const record = (type, payload) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n';
  const appendCall = (id, input) => fs.appendFileSync(file, record('response_item', { type: 'custom_tool_call', name: 'functions.exec', call_id: id, input }));
  fs.writeFileSync(file, record('session_meta', { cli_version: '0.147.0' }));
  const db = new DatabaseSync(path.join(instance.dataDir, 'tessera.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const project = db.prepare('SELECT * FROM projects WHERE decoded_path = ?').get('/home/work/Source/tessera-dev');
  assert.ok(project);
  const id = 'image-reference-replay-qa-session', title = 'IMAGE REFERENCE REPLAY QA';
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO sessions(id,project_id,title,provider,provider_state,work_dir,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, project.id, title, 'codex', JSON.stringify({ kind: 'terminal', codexSessionId: id }), project.decoded_path, now, now);
  db.prepare(`INSERT OR REPLACE INTO terminal_provider_sessions(provider_id,provider_session_id,tessera_session_id,transcript_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run('codex', id, id, file, now, now);
  db.prepare('DELETE FROM image_generation_cache WHERE session_id=?').run(id);
  db.close();
  const browser = await chromium.connectOverCDP(instance.cdpUrl);
  const page = browser.contexts()[0].pages()[0];
  const capture = name => page.screenshot({ path: path.join(artifactDirectory, name) });
  const read = () => page.evaluate(async id => {
    const response = await fetch(`/api/sessions/${id}/image-generations?sync=1`);
    if (!response.ok) throw new Error(`Image metadata HTTP ${response.status}`);
    return response.json();
  }, id);
  try {
    await capture('01-isolated-start.png');
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try { if (JSON.parse(data).type === 'terminal_create') return; } catch { /* binary */ }
        return send.call(this, data);
      };
      localStorage.setItem('tessera:git-panel', JSON.stringify({ state: { isOpen: true, panelWidth: 450, drawerHeight: 300, panelTab: 'images' }, version: 0 }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(title, { exact: true }).first().click({ timeout: 20000 });
    await page.getByRole('tab', { name: /Images|이미지/ }).click({ timeout: 15000 });
    await capture('02-empty-image-tab.png');
    const appendOutput = (id, output = []) => fs.appendFileSync(file, record('response_item', {
      type: 'custom_tool_call_output', call_id: id, output,
    }));
    const prompts = refs.map((ref, index) => ({
      key: `asset-${index}`, prompt: `QA replay asset ${index}`,
      referenced_image_paths: [ref],
    }));
    appendCall('store-assets', `store("assetPrompts",${JSON.stringify(prompts)});`);
    appendOutput('store-assets');
    assert.equal((await read()).traces.length, 0);
    await capture('03-object-array-stored.png');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /Images|이미지/ }).waitFor({ timeout: 15000 });
    assert.equal((await read()).traces.length, 0);
    await capture('04-reload-before-parallel-calls.png');
    appendCall('parallel-assets', `await Promise.allSettled(load("assetPrompts").map(async ({key,...args})=>{
      const result=await tools.image_gen__imagegen(args);store(key,result);generatedImage(result);
    }));`);
    // A different image per result makes an incorrect completion-order match observable.
    const generatedNames = prompts.map((_, index) => `exec-replay-${index}.png`);
    const generatedPaths = generatedNames.map(name => `${linuxDirectory}/${name}`);
    const outputBlocks = [];
    for (const index of [2, 0, 1]) {
      fs.writeFileSync(path.join(fixtureDirectory, generatedNames[index]), inputBytes[index]);
      fs.appendFileSync(file, record('event_msg', { type: 'item_completed', item: {
        id: `exec-replay-${index}`, kind: 'image_gen.generation', status: 'completed',
        revisedPrompt: prompts[index].prompt, savedPath: generatedPaths[index],
        result: inputBytes[index].toString('base64'),
      } }));
      outputBlocks.push({ type: 'input_text', text: JSON.stringify({
        output_hint: `Generated images are saved to ${generatedPaths[index]}`,
      }) });
    }
    appendOutput('parallel-assets', outputBlocks);
    const parallel = (await read()).traces;
    assert.equal(parallel.length, 3, 'one card per dynamic invocation');
    for (const [index, expected] of prompts.entries()) {
      const trace = parallel.find(trace => trace.prompt === expected.prompt);
      assert.ok(trace, `missing prompt ${expected.prompt}`);
      assert.equal(trace.inputs.length, 1);
      assert.equal(trace.unresolvedInputCount, 0);
      assert.ok(!trace.inputResolutionError);
      assert.equal(trace.inputs[0].label, refs[index]);
      const fetched = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, trace.inputs[0].url);
      assert.equal(fetched.status, 200);
      assert.deepEqual(Buffer.from(fetched.bytes), inputBytes[index]);
      assert.equal(trace.status, 'completed');
      assert.ok(trace.result?.url);
      const outputBytes = await page.evaluate(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Result HTTP ${response.status}`);
        return [...new Uint8Array(await response.arrayBuffer())];
      }, trace.result.url);
      assert.deepEqual(Buffer.from(outputBytes), inputBytes[index], 'completion order must not swap generated results');
    }
    await page.getByTestId('image-generations-panel').getByText(prompts[0].prompt, { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => {
      const inputs = [...document.querySelectorAll('img[src*="/inputs/"]')];
      return inputs.length === 3 && inputs.every(img => img.complete && img.naturalWidth > 0);
    });
    await capture('05-parallel-inputs-resolved.png');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('image-generations-panel').waitFor({ timeout: 15000 });
    await capture('06-reload-before-generated-reference.png');
    appendCall('reuse-output', `const previous=load("asset-1");
      const ref=previous.output_hint.replace("Generated images are saved to ","");
      const result=await tools.image_gen__imagegen({prompt:"QA replay generated reference",referenced_image_paths:[ref]});
      generatedImage(result);`);
    fs.appendFileSync(file, record('event_msg', { type: 'item_completed', item: {
      id: 'exec-replay-reused', kind: 'image_gen.generation', status: 'completed',
      revisedPrompt: 'QA replay generated reference', result: png,
    } }));
    appendOutput('reuse-output');
    const traces = (await read()).traces;
    assert.equal(traces.length, 4);
    const reused = traces.find(trace => trace.prompt === 'QA replay generated reference');
    assert.ok(reused);
    assert.equal(reused.inputs.length, 1);
    assert.equal(reused.inputs[0].label, generatedPaths[1]);
    assert.equal(reused.unresolvedInputCount, 0);
    assert.ok(!reused.inputResolutionError);
    const reusedBytes = await page.evaluate(async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Generated input HTTP ${response.status}`);
      return [...new Uint8Array(await response.arrayBuffer())];
    }, reused.inputs[0].url);
    assert.deepEqual(Buffer.from(reusedBytes), inputBytes[1]);
    await page.getByTestId('image-generations-panel').getByText('QA replay generated reference', { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => {
      const inputs = [...document.querySelectorAll('img[src*="/inputs/"]')];
      return inputs.length === 4 && inputs.every(img => img.complete && img.naturalWidth > 0);
    });
    await capture('07-generated-output-reused-as-input.png');
    for (const name of [...names, ...generatedNames]) fs.unlinkSync(path.join(fixtureDirectory, name));
    assert.equal(await page.evaluate(async url => (await fetch(url)).status, reused.inputs[0].url), 200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('image-generations-panel').waitFor({ timeout: 15000 });
    await capture('08-cached-references-after-source-removal.png');
    assert.equal((await read()).traces.length, 4, 'incremental sync must not duplicate replay cards');
    appendCall('recent-after-removal', 'await tools.image_gen__imagegen({prompt:"QA recent cached inputs",num_last_images_to_include:2});');
    fs.appendFileSync(file, record('event_msg', { type: 'item_completed', item: {
      id: 'exec-replay-recent', kind: 'image_gen.generation', status: 'completed',
      revisedPrompt: 'QA recent cached inputs', result: png,
    } }));
    appendOutput('recent-after-removal');
    const recent = (await read()).traces.find(trace => trace.prompt === 'QA recent cached inputs');
    assert.equal(recent.inputs.length, 2);
    assert.equal(recent.unresolvedInputCount, 0);
    for (const [index, expected] of [inputBytes[1], inputBytes[0]].entries()) {
      const bytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], recent.inputs[index].url);
      assert.deepEqual(Buffer.from(bytes), expected);
    }
    await page.getByText('QA recent cached inputs', { exact: true }).waitFor({ timeout: 15000 });
    await capture('09-new-recent-call-after-source-removal.png');
    await page.getByRole('tab', { name: /^Git$/ }).click();
    await capture('10-images-tab-inactive.png');
    const unexpectedRequests = [];
    const onRequest = request => { if (request.url().includes('/image-generations?sync=1')) unexpectedRequests.push(request.url()); };
    page.on('request', onRequest);
    await page.waitForTimeout(3000);
    page.off('request', onRequest);
    assert.equal(unexpectedRequests.length, 0, 'inactive Images tab must not synchronize');
    await page.getByRole('tab', { name: /Images|이미지/ }).click();
    await page.getByText('QA recent cached inputs', { exact: true }).waitFor({ timeout: 15000 });
    await capture('11-images-tab-resumed.png');

    console.log(JSON.stringify({ parallelInputs: parallel.map(trace => trace.inputs.length), reusedInput: reused.inputs[0].label, cachedAfterSourceRemoval: true }));
  } catch (error) {
    await capture('99-error.png');
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
