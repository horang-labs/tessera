/** Shared CLI-side canonical identity: first Submit can precede creation of the native file. */
export const AUTORUN_SOURCE_IDENTITY = String.raw`
function autorunSource(inputPath, create) {
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 if(create)fs.mkdirSync(path.dirname(inputPath),{recursive:true,mode:448});
 const canonical=fs.existsSync(inputPath)?fs.realpathSync(inputPath):path.join(fs.realpathSync(path.dirname(inputPath)),path.basename(inputPath));
 const dir=path.join(path.dirname(canonical),'.tessera-autorun');if(create)fs.mkdirSync(dir,{recursive:true,mode:448});
 const file=path.join(dir,hash(canonical)+'.generation.json');
 let stat=null;try{const s=fs.statSync(canonical);stat=s.dev+':'+s.ino+':'+s.birthtimeMs}catch{if(!create)throw Error('source missing')}
 let generation;try{generation=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(!generation){if(!create)throw Error('instrumentation missing');generation={id:crypto.randomUUID(),stat};fs.writeFileSync(file,JSON.stringify(generation),{flag:'wx',mode:384})}
 else if(generation.stat===null&&stat!==null){generation.stat=stat;fs.writeFileSync(file,JSON.stringify(generation),{mode:384})}
 else if(stat!==null&&generation.stat!==stat){if(!create)throw Error('source rotated');generation={id:crypto.randomUUID(),stat};fs.writeFileSync(file,JSON.stringify(generation),{mode:384})}
 return {canonicalPath:canonical,identityHash:hash(canonical),fileGeneration:generation.id};
}
`;
/** CLI-side observation before the authenticated HTTP post. No stdout decisions or approvals. */
export const AUTORUN_HOOK_OBSERVER = AUTORUN_SOURCE_IDENTITY + String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let input='';process.stdin.on('data',b=>{if(input.length<1000000)input+=b});
process.stdin.on('end',()=>{try{
 const payload=JSON.parse(input),event=payload.hook_event_name;
 const nativeId=payload.prompt_id||payload.turn_id;
 if(!nativeId||!['UserPromptSubmit','Stop'].includes(event)){process.stdout.write(input);return}
 const source=autorunSource(payload.transcript_path,event==='UserPromptSubmit'),canonical=source.canonicalPath;
 const stat=fs.existsSync(canonical)?fs.statSync(canonical):{size:0};
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const dir=path.join(path.dirname(canonical),'.tessera-autorun');fs.mkdirSync(dir,{recursive:true,mode:448});
 const file=path.join(dir,hash(canonical+'\0'+nativeId)+'.json');
 let observed;
 try{observed=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(event==='UserPromptSubmit'&&!observed){
  const size=Math.min(stat.size,2097152),tail=Buffer.alloc(size);
  if(size){const fd=fs.openSync(canonical,'r');fs.readSync(fd,tail,0,size,stat.size-size);fs.closeSync(fd);}
  const end=tail.lastIndexOf(10);if(end<0&&stat.size>2097152)throw Error('record limit');
  observed={observerSubmissionId:crypto.randomUUID(),sourceIdentityHash:hash(canonical),fileGeneration:source.fileGeneration,
   startByte:end<0?0:stat.size-size+end+1,canonicalPath:canonical,nativeId};
  fs.writeFileSync(file,JSON.stringify(observed),{flag:'wx',mode:384});
 }
 if(observed&&observed.fileGeneration===source.fileGeneration){
  if(event==='Stop'&&!observed.completionHookId){observed.completionHookId=crypto.randomUUID();fs.writeFileSync(file,JSON.stringify(observed),{mode:384})}
  payload.tessera_autorun={...observed,dedupKey:event==='Stop'?observed.completionHookId:observed.observerSubmissionId};
 }
 process.stdout.write(JSON.stringify(payload));
}catch{process.stdout.write(input)}});
`;
