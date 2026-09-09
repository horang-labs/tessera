const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');

(async () => {
  const [manifestPath, source, providerId, mode = 'scan'] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,''));
  assert.ok(manifest.sessionId.startsWith('codex-0904ry-image-index'));
  const instance = manifest.instances[0];
  assert.notEqual(instance.serverPort,32123);
  const db = new DatabaseSync(path.join(instance.dataDir,'tessera.db'));
  const id = 'image-index-qa-session';
  if (mode === 'scan') {
    db.prepare('UPDATE sessions SET provider_state=? WHERE id=?').run(JSON.stringify({kind:'terminal',codexSessionId:providerId}),id);
    db.prepare('UPDATE terminal_provider_sessions SET provider_session_id=?,transcript_path=? WHERE tessera_session_id=?').run(providerId,source,id);
    db.prepare('DELETE FROM image_generation_cache WHERE session_id=?').run(id);
  }
  const browser = await chromium.connectOverCDP(instance.cdpUrl);
  try {
    const page=browser.contexts()[0].pages()[0];
    const files=page.getByRole('tab',{name:/^Files$|^파일$/});
    if(await files.count())await files.click();
    const started=Date.now();
    let batches=0, response;
    do {
      response=await page.evaluate(async id=>{
        const r=await fetch(`/api/sessions/${id}/image-generations?sync=1`);
        return {status:r.status,...await r.json()};
      },id);
      assert.equal(response.status,200,JSON.stringify(response));
      batches++;
      if(batches>200)throw Error('Index did not catch up');
    }while(response.more);
    const scanMs=Date.now()-started;
    const loadStart=Date.now();
    const cached=await page.evaluate(async id=>(await fetch(`/api/sessions/${id}/image-generations`)).json(),id);
    const cacheMs=Date.now()-loadStart;
    const row=db.prepare('SELECT source_json,state_json,cards_json FROM image_generation_cache WHERE session_id=?').get(id);
    console.log(JSON.stringify({mode,scanMs,cacheMs,batches,cards:cached.traces.length,source:JSON.parse(row.source_json),
      metadataBytes:Buffer.byteLength(row.state_json)+Buffer.byteLength(row.cards_json)},null,2));
  }finally{db.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
