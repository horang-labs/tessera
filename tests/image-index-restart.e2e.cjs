const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
(async()=>{
  const [manifestPath,fixtureDirectory,artifactDirectory,mode]=process.argv.slice(2);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,''));
  assert.ok(manifest.sessionId.startsWith('codex-0904ry-image-index'));
  const instance=manifest.instances[0];
  assert.notEqual(instance.serverPort,32123);
  const browser=await chromium.connectOverCDP(instance.cdpUrl);
  try{
    const page=browser.contexts()[0].pages()[0];
    if(mode==='prepare') {
      await page.getByText('IMAGE INDEX OTHER',{exact:true}).first().click();
      await page.screenshot({path:path.join(artifactDirectory,'08b-before-server-restart.png')});
      return;
    }
    const id='image-index-qa-session';
    const start=Date.now();
    const cached=await page.evaluate(async id=>(await fetch(`/api/sessions/${id}/image-generations`)).json(),id);
    const cacheMs=Date.now()-start;
    assert.equal(cached.traces.length,2);
    assert.equal(cached.traces[1].status,'running');
    const inputBefore=cached.traces[1].inputs;
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    fs.appendFileSync(path.join(fixtureDirectory,'rollout.jsonl'),JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'item_completed',item:{id:'qa-next-result',type:'imageGeneration',result:png}}})+'\n');
    const updated=await page.evaluate(async id=>(await fetch(`/api/sessions/${id}/image-generations?sync=1`)).json(),id);
    assert.equal(updated.traces.length,2);
    assert.equal(updated.traces[1].status,'completed');
    assert.deepEqual(updated.traces[1].inputs,inputBefore);
    const bytes=await page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,length:(await r.arrayBuffer()).byteLength};},updated.traces[1].result.url);
    assert.equal(bytes.status,200);
    assert.ok(bytes.length>0);
    await page.screenshot({path:path.join(artifactDirectory,'09-server-restarted.png')});
    console.log(JSON.stringify({cacheMs,cards:updated.traces.length,pendingRestoredAndCompleted:true,bytes},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
