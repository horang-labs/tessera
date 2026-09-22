'use strict';
// Run only through image-replay-memory.test.mjs, which enforces an RSS ceiling.
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const assert = require('node:assert/strict');

async function write(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

async function main() {
  const [directory, rawBytesText, existingTranscript] = process.argv.slice(2);
  const rawBytes = Number(rawBytesText);
  assert.ok(directory && Number.isSafeInteger(rawBytes) && rawBytes > 0);
  const original = existingTranscript || path.join(directory, 'original.jsonl');
  const sidecar = path.join(directory, 'metadata.jsonl');
  if (!existingTranscript) {
  const transcript = fs.createWriteStream(original);
  const record = payload => JSON.stringify({type:'response_item',payload})+'\n';
  await write(transcript, JSON.stringify({type:'turn_context',payload:{turn_id:'memory-turn'}})+'\n');
  await write(transcript, record({type:'custom_tool_call',name:'exec',call_id:'memory-unfinished',input:'await new Promise(()=>{});'}));
  await write(transcript, record({type:'custom_tool_call_output',call_id:'memory-unfinished',output:'Script running with cell ID unfinished'}));
  await write(transcript, record({type:'custom_tool_call',name:'exec',call_id:'memory-image',
    input:'await tools.image_gen__imagegen({prompt:"bounded replay memory",referenced_image_paths:["/fixture/reference.png"]});'}));
  // Both execs are live: this exercises late association as well as streaming.
  await write(transcript, '{"type":"event_msg","payload":{"type":"item_completed","turn_id":"memory-turn","item":{"id":"exec-memory","kind":"image_gen.generation","status":"completed","revisedPrompt":"bounded replay memory","result":"');
  const chunk = 'A'.repeat(64 * 1024);
  for (let remaining=rawBytes; remaining>0; remaining-=Math.min(remaining,chunk.length)) await write(transcript,chunk.slice(0,Math.min(remaining,chunk.length)));
  await write(transcript, '"}}}\n');
  await write(transcript,record({type:'custom_tool_call_output',call_id:'memory-image',output:[]}));
  transcript.end(); await once(transcript,'finish');
  }
  const { readMetadataRecords } = require('../runtime/image-record-reader.cjs');
  const metadata = fs.createWriteStream(sidecar);
  let markers=0, metadataRecords=0, maximumRecordBytes=0;
  const check = value => {
    if (typeof value === 'string') {
      assert.ok(value.length <= 256 * 1024,'oversized string leaked into sanitized metadata');
      assert.ok(!/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/.test(value),'embedded image data URI leaked into sanitized metadata');
    }
    else if (value && typeof value === 'object') {
      if (value.__tesseraImage) {
        const span=value.__tesseraImage;
        assert.ok(Number.isSafeInteger(span.offset) && Number.isSafeInteger(span.length));
        if (!existingTranscript) assert.equal(span.length,rawBytes);
        markers++;
      }
      for (const child of Object.values(value)) check(child);
    }
  };
  const start=performance.now();
  const scan=await readMetadataRecords(original,{maxBytes:rawBytes+1024*1024,maxMs:30000},async(record,originalOffset)=>{
    check(record); metadataRecords++;
    const serialized=JSON.stringify({...record,__tesseraRecordOffset:originalOffset})+'\n';
    maximumRecordBytes=Math.max(maximumRecordBytes,Buffer.byteLength(serialized));
    await write(metadata,serialized);
  });
  metadata.end(); await once(metadata,'finish');
  assert.equal(scan.more,false);
  if (!existingTranscript) { assert.equal(metadataRecords,6); assert.equal(markers,1); }
  else { assert.ok(metadataRecords>3); assert.ok(markers>0); }
  const sidecarBytes=fs.statSync(sidecar).size;
  assert.ok(sidecarBytes<(existingTranscript?32*1024*1024:64*1024),'metadata sidecar scales with image payload');
  const worker=new Worker(path.resolve(__dirname,'../runtime/image-reference-replay-worker.cjs'),{
    resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:8},
  });
  try {
    const response=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(new Error(`Worker exited ${code}`));});});
    worker.postMessage({id:1,sessionId:'memory-regression',path:sidecar,offset:sidecarBytes});
    const reply=await response;
    assert.ok(!reply.error,reply.error);
    const referenceCounts=reply.result.invocations.map(i=>i.referencedImagePaths?.length??0);
    if (existingTranscript) {
      assert.deepEqual(referenceCounts,[1,1,1,1,1,2,1]);
      assert.ok(reply.result.invocations.every(i=>i.resultId),'real calls must retain result associations');
    } else {
      assert.equal(reply.result.invocations.length,1);
      assert.deepEqual(reply.result.invocations[0].referencedImagePaths,['/fixture/reference.png']);
      assert.equal(reply.result.invocations[0].resultId,'exec-memory');
    }
    console.log(JSON.stringify({rawBytes,sidecarBytes,metadataRecords,markers,maximumRecordBytes,workerHeapLimitMiB:64,
      elapsedMs:Math.round(performance.now()-start),rss:process.memoryUsage().rss,invocations:reply.result.invocations.length,referenceCounts,
      diagnostics:existingTranscript?reply.result.diagnostics.filter(d=>d.unresolved||d.error):undefined}));
  } finally { await worker.terminate(); }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
