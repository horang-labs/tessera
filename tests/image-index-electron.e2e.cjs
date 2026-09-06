// Windows Node + an ownership-manifest-isolated Electron backend + WSL JSONL fixtures.
// No provider calls: append recorded protocol shapes to exercise the real HTTP/UI path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('@playwright/test');

async function main() {
  const [manifestPath, fixtureDirectory, artifactDirectory] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(manifest.sessionId.startsWith('codex-0904ry-image-index'));
  const instance = manifest.instances[0];
  assert.notEqual(instance.serverPort, 32123);
  assert.ok(instance.dataDir.includes('TesseraTestInstances'));
  assert.ok(fixtureDirectory.includes('image-index-qa'));
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const file = path.join(fixtureDirectory, 'rollout.jsonl');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const record = (type, payload) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n';
  fs.writeFileSync(file, record('session_meta', { cli_version: '0.147.0' })
    + record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }] }));
  const db = new DatabaseSync(path.join(instance.dataDir, 'tessera.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const project = db.prepare('SELECT * FROM projects WHERE decoded_path = ?').get('/home/work/Source/tessera-dev');
  assert.ok(project);
  const id = 'image-index-qa-session';
  const title = 'IMAGE INDEX QA';
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO sessions(id,project_id,title,provider,provider_state,work_dir,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, project.id, title, 'codex', JSON.stringify({kind:'terminal',codexSessionId:'image-index-qa-provider'}), project.decoded_path, now, now);
  db.prepare(`INSERT OR REPLACE INTO terminal_provider_sessions(provider_id,provider_session_id,tessera_session_id,transcript_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run('codex','image-index-qa-provider',id,file,now,now);
  db.prepare('DELETE FROM image_generation_cache WHERE session_id=?').run(id);
  db.prepare(`INSERT OR REPLACE INTO sessions(id,project_id,title,provider,provider_state,work_dir,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('image-index-qa-other',project.id,'IMAGE INDEX OTHER','codex',JSON.stringify({kind:'terminal',codexSessionId:'image-index-other-provider'}),project.decoded_path,now,now);
  db.close();
  const browser = await chromium.connectOverCDP(instance.cdpUrl);
  const page = browser.contexts()[0].pages()[0];
  const requests = [];
  page.on('request', (request) => { if(request.url().includes(`/sessions/${id}/image-generations`)) requests.push({time:Date.now(),url:request.url()}); });
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try { if (JSON.parse(data).type === 'terminal_create') return; } catch {}
      return send.call(this,data);
    };
    localStorage.setItem('tessera:git-panel',JSON.stringify({state:{isOpen:true,panelWidth:450,drawerHeight:300,panelTab:'images'},version:0}));
  });
  const capture = (name) => page.screenshot({path:path.join(artifactDirectory,name)});
  try {
    await page.reload({waitUntil:'domcontentloaded'});
    await capture('02-fixture-ready.png');
    await page.getByText(title,{exact:true}).first().click({timeout:20000});
    await page.getByRole('tab',{name:/Images|이미지/}).click({timeout:15000});
    await capture('03-image-tab-before-call.png');
    const started = Date.now();
    fs.appendFileSync(file,record('response_item',{type:'custom_tool_call',call_id:'qa-call',name:'functions.exec',input:'tools.image_gen__imagegen({prompt: "QA generated image", num_last_images_to_include: 1})'}));
    await page.getByTestId('image-generations-panel').getByText('QA generated image',{exact:true}).waitFor({timeout:15000});
    const cardLatencyMs = Date.now()-started;
    await capture('04-running-card.png');
    const completed = Date.now();
    fs.appendFileSync(file,record('event_msg',{type:'item_completed',item:{id:'qa-result',type:'imageGeneration',result:png}}));
    await page.waitForFunction(() => {
      const img=document.querySelector('[data-testid="image-generation-hero"] img');
      return img && img.complete && img.naturalWidth>0 && Number(getComputedStyle(img).opacity)>0.99;
    },undefined,{timeout:15000});
    const imageLatencyMs = Date.now()-completed;
    await capture('05-completed-image.png');
    const logLines=fs.readFileSync(path.join(instance.dataDir,'tessera-main.log'),'utf8').split('\n');
    const samples=logLines.flatMap(line=>{
      const start=line.indexOf('{"level"');
      if(start<0)return [];
      try{const entry=JSON.parse(line.slice(start));return entry.sessionId===id&&entry.msg==='Image index incremental read'?[entry]:[];}catch{return [];}
    }).filter(entry=>entry.bytesRead>0);
    assert.ok(samples.length>=2);
    const last=samples.at(-1),previous=samples.at(-2);
    assert.equal(last.bytesRead,last.offset-previous.offset,'append must not rescan the previous transcript (including on WSL)');
    await page.getByText('IMAGE INDEX OTHER',{exact:true}).first().click();
    await capture('06a-other-session.png');
    const beforeSwitch=requests.filter(entry=>entry.url.includes('sync=1')).length;
    fs.appendFileSync(file,record('response_item',{type:'custom_tool_call',call_id:'qa-next',name:'functions.exec',input:'tools.image_gen__imagegen({prompt: "QA next image", num_last_images_to_include: 1})'}));
    await page.waitForTimeout(2300);
    assert.equal(requests.filter(entry=>entry.url.includes('sync=1')).length,beforeSwitch,'unselected session must not poll');
    await page.getByText(title,{exact:true}).first().click();
    await page.getByTestId('image-generations-panel').getByText('QA next image',{exact:true}).waitFor({timeout:10000});
    await capture('06b-session-return-catches-up.png');
    // Revisit must restore cards without waiting for transcript access.
    await page.getByRole('tab',{name:/^Files$|^파일$/}).click();
    await capture('06-other-tab.png');
    const closedRequests=requests.filter(entry=>entry.url.includes('sync=1')).length;
    await page.waitForTimeout(2300);
    assert.equal(requests.filter(entry=>entry.url.includes('sync=1')).length,closedRequests,'hidden image tab must stop polling');
    const savedFile = file+'.saved';
    fs.renameSync(file,savedFile);
    const revisit = Date.now();
    await page.getByRole('tab',{name:/Images|이미지/}).click();
    await page.getByTestId('image-generations-panel').waitFor();
    const revisitMs = Date.now()-revisit;
    await capture('07-cached-without-transcript.png');
    fs.renameSync(savedFile,file);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByTestId('image-generations-panel').waitFor({timeout:15000});
    await capture('08-renderer-restart-cache.png');
    console.log(JSON.stringify({cardLatencyMs,imageLatencyMs,revisitMs,requests},null,2));
  } catch(error) { await capture('99-error.png'); throw error; }
  finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
