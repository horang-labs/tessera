export class SupervisorProcessUncertain extends Error { constructor() { super('owned supervisor process uncertainty'); } }
/** Runs only on the CLI filesystem, under an exclusive kernel flock for every ledger mutation/query.
 * No process lookup, kill, model output or inference is part of reconciliation.
 */
export const RECOVERY_LEDGER_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const operation=process.argv[1],request=JSON.parse(process.argv[2]),root=process.argv[3];
const identity={version:1,userId:request.userId,agentEnvironment:request.agentEnvironment,invocationId:request.invocationId};
function read(file){if(fs.statSync(file).size>32768)throw Error('receipt bound');return JSON.parse(fs.readFileSync(file,'utf8'))}
function write(file,value,exclusive=false){
 const tmp=exclusive?file:file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,exclusive?'wx':'w',384);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 if(!exclusive)fs.renameSync(tmp,file);
 const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
}
function unknown(reason){return {...identity,observedAt:Date.now(),kind:'unknown',code:'SUPERVISOR_PROCESS_UNCERTAIN',reason}}
try{
 if(operation==='reserve'){
  fs.mkdirSync(root,{recursive:true,mode:448});
  const manifest={...identity,provider:request.provider,launchId:crypto.randomUUID(),createdAt:Date.now(),deadlineAt:request.deadlineAt,closedAt:null,attemptIds:[]};
  write(root+'/invocation.json',manifest,true);fs.mkdirSync(root+'/attempts',{mode:448});
  process.stdout.write(JSON.stringify(manifest));
 }else{
  const manifest=read(root+'/invocation.json');
  const matches=Object.entries(identity).every(([k,v])=>manifest[k]===v)&&manifest.provider===request.provider&&
   (!request.launchId||request.launchId===manifest.launchId);
  if(!matches){process.stdout.write(JSON.stringify(unknown('identity-mismatch')));process.exit(0)}
  if(typeof manifest.launchId!=='string'||!Number.isSafeInteger(manifest.deadlineAt)||
   !Array.isArray(manifest.attemptIds)||manifest.attemptIds.length>64||new Set(manifest.attemptIds).size!==manifest.attemptIds.length||
   manifest.attemptIds.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))||
   (manifest.closedAt!==null&&!Number.isSafeInteger(manifest.closedAt)))throw Error('malformed ledger');
  if(operation==='attempt'){
   if(manifest.closedAt!==null||Date.now()>=manifest.deadlineAt||manifest.attemptIds.length>=64)throw Error('launch closed');
   const attemptId=crypto.randomUUID(),dir=root+'/attempts/'+attemptId;fs.mkdirSync(dir,{mode:448});
   const attempt={...identity,provider:manifest.provider,launchId:manifest.launchId,attemptId,ledgerRoot:root,phase:'prelaunch',createdAt:Date.now()};
   write(dir+'/state.json',attempt,true);manifest.attemptIds.push(attemptId);write(root+'/invocation.json',manifest);
   process.stdout.write(JSON.stringify(attempt));
  }else{
   if(operation==='close'||(operation==='observe'&&Date.now()>=manifest.deadlineAt)){
    if(manifest.closedAt===null){manifest.closedAt=Date.now();write(root+'/invocation.json',manifest)}
   }
   if(manifest.closedAt===null){process.stdout.write(JSON.stringify(unknown('active')));process.exit(0)}
   let settledAt=manifest.closedAt,incomplete=false;
   for(const attemptId of manifest.attemptIds){
    const file=root+'/attempts/'+attemptId+'/state.json',s=read(file);
    if(!Object.entries(identity).every(([k,v])=>s[k]===v)||s.provider!==request.provider||s.launchId!==manifest.launchId||s.attemptId!==attemptId||s.ledgerRoot!==root)throw Error('foreign attempt');
    // Affirmative prelaunch state + sealed authorization under flock proves no launch can now occur.
    // Missing state or a started launch without a receipt never takes this path.
    if(s.phase==='prelaunch'){Object.assign(s,{phase:'settled',spawned:false,noLaunchReason:'authorization-sealed',quiescent:true,remaining:[],settledAt:Date.now()});write(file,s)}
    if(s.phase!=='settled'||s.quiescent!==true||!Array.isArray(s.remaining)||s.remaining.some(p=>p.state!=='Z')||!Number.isSafeInteger(s.settledAt))incomplete=true;
    else if(s.spawned===true&&(!s.wrapper||typeof s.wrapper.start!=='string'||typeof s.wrapper.bootId!=='string'||!Number.isSafeInteger(s.wrapper.pid)||!s.child||!Number.isSafeInteger(s.child.pid)))incomplete=true;
    else if(s.spawned!==true&&s.spawned!==false)incomplete=true;
    else if(s.spawned===false&&(!['authorization-sealed','deadline','spawn-error'].includes(s.noLaunchReason)||s.child))incomplete=true;
    settledAt=Math.max(settledAt,s.settledAt||0);
   }
   process.stdout.write(JSON.stringify(incomplete?unknown('incomplete'):{...identity,observedAt:Date.now(),kind:'quiescent',code:'SUPERVISOR_QUIESCENT',proof:{kind:'owned-invocation-closed',launchId:manifest.launchId,closedAt:manifest.closedAt,settledAt}}));
  }
 }
}catch(error){process.stdout.write(JSON.stringify(unknown(error.code==='ENOENT'?'missing':'incomplete')));process.exitCode=operation==='observe'?0:1}
`;
