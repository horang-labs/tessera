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
  const id = 'image-reference-qa-session', title = 'IMAGE REFERENCE QA';
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
    appendCall('store', `const paths=${JSON.stringify(refs)};store("realrefs",paths);for(const path of paths){const r=await tools.view_image({path});image(r.image_url);}`);
    assert.equal((await read()).traces.length, 0);
    await capture('03-reference-only-cell-indexed.png');
    fs.appendFileSync(file, record('response_item', { type: 'custom_tool_call_output', call_id: 'store', output: 'ok' }));
    // Reloading the renderer and a later sync both restore the SQLite checkpoint.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /Images|이미지/ }).waitFor({ timeout: 15000 });
    await capture('04-reload-before-image-call.png');
    appendCall('edit', 'const r=await tools.image_gen__imagegen({prompt:"QA load refs",referenced_image_paths:load("realrefs")});generatedImage(r);');
    const first = (await read()).traces[0];
    assert.equal(first.inputs.length, 3);
    assert.equal(first.unresolvedInputCount, 0);
    assert.deepEqual(first.inputs.map(input => input.label), refs);
    for (const [index, input] of first.inputs.entries()) {
      const result = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, input.url);
      assert.equal(result.status, 200);
      assert.deepEqual(Buffer.from(result.bytes), inputBytes[index]);
    }
    await page.getByTestId('image-generations-panel').getByText('QA load refs', { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('img[src*="/inputs/"]')];
      return images.length === 3 && images.every(img => img.complete && img.naturalWidth > 0);
    });
    await capture('05-three-resolved-inputs.png');
    fs.appendFileSync(file, record('event_msg', { type: 'item_completed', item: { id: 'result', type: 'imageGeneration', result: png } }));
    await read();
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-testid="image-generation-hero"] img');
      return img && img.complete && img.naturalWidth > 0;
    });
    await capture('06-completed-generation.png');
    appendCall('indexed', `const p=load("realrefs");tools.image_gen__imagegen({prompt:"QA indexed refs",referenced_image_paths:[${JSON.stringify(refs[0])},p[1],p[2]]})`);
    const second = (await read()).traces[1];
    assert.equal(second.inputs.length, 3);
    assert.equal(second.unresolvedInputCount, 0);
    await page.getByTestId('image-generations-panel').getByText('QA indexed refs', { exact: true }).waitFor({ timeout: 15000 });
    await capture('07-indexed-array-inputs.png');
    // Unsupported data is explicit, never an older image silently substituted.
    appendCall('unknown', 'tools.image_gen__imagegen({prompt:"QA unknown refs",referenced_image_paths:load("missing")})');
    const third = (await read()).traces[2];
    assert.equal(third.inputs.length, 0);
    assert.equal(third.unresolvedInputCount, 1);
    await page.getByTestId('image-generations-panel').getByText('QA unknown refs', { exact: true }).waitFor({ timeout: 15000 });
    await capture('08-unknown-reference-warning.png');
    for (const name of names) fs.unlinkSync(path.join(fixtureDirectory, name));
    for (const input of second.inputs) assert.equal(await page.evaluate(async url => (await fetch(url)).status, input.url), 200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('image-generations-panel').waitFor({ timeout: 15000 });
    await capture('09-cached-inputs-after-source-removed.png');
    console.log(JSON.stringify({ inputs: [first.inputs.length, second.inputs.length], unresolved: [first.unresolvedInputCount, second.unresolvedInputCount], unknown: third.unresolvedInputCount, cachedAfterSourceRemoval: true }));
  } catch (error) {
    await capture('99-error.png');
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
