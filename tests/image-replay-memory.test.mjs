import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MiB=1024*1024;
const TOTAL_RSS_LIMIT=384*MiB;
const childFile=fileURLToPath(new URL('./image-replay-memory-child.cjs',import.meta.url));

function runBounded(directory,payloadBytes,existingTranscript) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128',childFile,directory,String(payloadBytes),...(existingTranscript?[existingTranscript]:[])],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',peakRss=0,failure;
    const fail=reason=>{failure??=new Error(reason);child.kill('SIGKILL');};
    const collect=(name,chunk)=>{
      if(name==='stdout')stdout+=chunk;else stderr+=chunk;
      if(stdout.length+stderr.length>1024*1024)fail('Memory child output exceeded 1MiB');
    };
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    const poll=setInterval(()=>{
      try {
        const status=fs.readFileSync(`/proc/${child.pid}/status`,'utf8');
        const kib=Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]??0);
        const rss=kib*1024;
        peakRss=Math.max(peakRss,rss);
        // /proc status includes every thread, including the actual replay worker.
        if(rss+process.memoryUsage().rss>TOTAL_RSS_LIMIT)fail('Reader/replay plus monitor exceeded 384MiB RSS hard cap');
      } catch(error) { if(error.code!=='ENOENT')fail(`Cannot sample child RSS: ${error.message}`); }
    },25);
    const timeout=setTimeout(()=>fail('Memory regression exceeded 45 seconds'),45000);
    child.once('error',error=>{clearInterval(poll);clearTimeout(timeout);reject(error);});
    child.once('close',(code,signal)=>{
      clearInterval(poll);clearTimeout(timeout);
      if(failure)return reject(failure);
      if(code!==0)return reject(new Error(`Memory child exited ${code}/${signal}: ${stderr.slice(-4000)}`));
      try {
        const report=JSON.parse(stdout.trim());
        peakRss=Math.max(peakRss,report.rss);
        assert.ok(peakRss+process.memoryUsage().rss<=TOTAL_RSS_LIMIT,'Observed RSS exceeded hard cap');
        resolve({...report,peakRss});
      } catch(error) { reject(error); }
    });
  });
}

test('streamed metadata replay memory does not scale with a 128MiB image payload',{
  skip:process.platform!=='linux'?'RSS hard cap currently requires Linux /proc':false,
  timeout:100000,
},async t=>{
  const temporaryRoot=path.join(os.homedir(),'tmp');
  fs.mkdirSync(temporaryRoot,{recursive:true});
  const root=fs.mkdtempSync(path.join(temporaryRoot,'tessera-image-memory-'));
  try {
    const smallDir=path.join(root,'small'),largeDir=path.join(root,'large');
    fs.mkdirSync(smallDir);fs.mkdirSync(largeDir);
    const small=await runBounded(smallDir,4*MiB);
    const large=await runBounded(largeDir,128*MiB);
    assert.equal(small.metadataRecords,large.metadataRecords);
    assert.equal(small.invocations,large.invocations);
    assert.ok(Math.abs(large.sidecarBytes-small.sidecarBytes)<256,'metadata size must be independent of image payload size');
    assert.ok(large.peakRss-small.peakRss<48*MiB,
      `RSS scaled with image payload: small=${Math.round(small.peakRss/MiB)}MiB large=${Math.round(large.peakRss/MiB)}MiB`);
    t.diagnostic(JSON.stringify({small,large,totalRssHardCap:TOTAL_RSS_LIMIT}));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

// Opt-in local evidence only: ordinary CI does not depend on a user's transcript.
test('real frozen transcript replays seven image calls under the same RSS hard cap', {
  skip:process.platform!=='linux'||!process.env.TESSERA_IMAGE_REPLAY_REAL_TRANSCRIPT,
  timeout:50000,
},async t=>{
  const temporaryRoot=path.join(os.homedir(),'tmp');
  fs.mkdirSync(temporaryRoot,{recursive:true});
  const directory=fs.mkdtempSync(path.join(temporaryRoot,'tessera-image-memory-real-'));
  try {
    const original=process.env.TESSERA_IMAGE_REPLAY_REAL_TRANSCRIPT;
    const result=await runBounded(directory,fs.statSync(original).size,original);
    assert.deepEqual(result.referenceCounts,[1,1,1,1,1,2,1]);
    t.diagnostic(JSON.stringify(result));
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
