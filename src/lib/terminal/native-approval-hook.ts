import { AUTORUN_SOURCE_IDENTITY } from './autorun-observer';
import type { HookCommandStyle } from './hook-command';

/** CLI-side only: native stdout receives an exact once-only hook output, never an HTTP offer. */
export function buildNativeApprovalHookCommand(style: HookCommandStyle, provider: 'codex' | 'claude-code'): string {
  const source = AUTORUN_SOURCE_IDENTITY + String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const provider=PROVIDER;
let raw='';process.stdin.on('data',chunk=>{raw+=chunk;if(raw.length>1000000)process.exit(0)});
process.stdin.on('end',async()=>{try{
 const payload=JSON.parse(raw);if(payload.hook_event_name!=='PermissionRequest')return;
 const generation=Number(process.env.TESSERA_TERMINAL_GENERATION);if(!Number.isSafeInteger(generation)||generation<1)return;
 const invocationId=crypto.randomUUID();
 try{
  const source=autorunSource(payload.transcript_path,false);
  const file=path.join(path.dirname(source.canonicalPath),'.tessera-autorun',crypto.createHash('sha256').update(source.canonicalPath).digest('hex')+'.lead.json');
  const lead=JSON.parse(fs.readFileSync(file,'utf8'));
  if(lead.fileGeneration===source.fileGeneration&&(!payload.turn_id||payload.turn_id===lead.nativeId))payload.tessera_autorun=lead;
 }catch{}
 const port=process.env.TESSERA_HOOK_PORT,session=process.env.TESSERA_SESSION_ID,token=process.env.TESSERA_PANE_TOKEN;
 if(!/^\d+$/.test(port||'')||!session||!token)return;
 const url='http://127.0.0.1:'+port+'/__tessera/hook?session='+encodeURIComponent(session);
 const wsl=!!process.env.WSL_DISTRO_NAME||(()=>{try{return /microsoft|wsl/i.test(fs.readFileSync('/proc/version','utf8'))}catch{return false}})();
 const binaries=process.platform==='win32'?[path.join(process.env.SystemRoot,'System32','curl.exe')]:wsl?['curl','curl.exe','/mnt/c/Windows/System32/curl.exe']:['curl'];
 function post(body,maxTime){
  for(const binary of binaries){try{
   return cp.execFileSync(binary,['-sS','--fail','--noproxy','127.0.0.1','--connect-timeout','1','--max-time',String(maxTime),'-X','POST',url,'-H','X-Tessera-Pane-Token: '+token,'--data-binary','@-'],
    {input:JSON.stringify(body),encoding:'utf8',timeout:(maxTime+2)*1000,maxBuffer:65536,stdio:['pipe','pipe','ignore']});
  }catch(error){
   // Never retry a request that may have reached its authenticated owner.
   if(![7,22].includes(error.status))throw error;
  }}return '';
 }
 const probe=post({...payload,hook_event_name:'TesseraApprovalProbe',tessera_terminal_generation:generation},5);
 if(!probe||JSON.parse(probe).enabled!==true){post(payload,5);return;}
 const version=cp.execFileSync(provider==='codex'?'codex':'claude',['--version'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).match(/\b\d+\.\d+\.\d+\b/)?.[0];
 if(!version){post(payload,5);return;}
 payload.tessera_native_approval={invocationId,generation,providerVersion:version};
 const offerRaw=post(payload,95);if(!offerRaw)return;
 const offer=JSON.parse(offerRaw);
 if(Object.keys(offer).sort().join(',')!=='optionId,requestHash,requestId'||offer.requestId!==invocationId||!['allow-once','deny'].includes(offer.optionId)||!/^[a-f0-9]{64}$/.test(offer.requestHash))return;
 const outputRaw=post({hook_event_name:'TesseraApprovalCommit',requestId:offer.requestId,requestHash:offer.requestHash},5);if(!outputRaw)return;
 const output=JSON.parse(outputRaw),specific=output.hookSpecificOutput,decision=specific?.decision;
 if(Object.keys(output).join(',')!=='hookSpecificOutput'||Object.keys(specific).sort().join(',')!=='decision,hookEventName'||specific.hookEventName!=='PermissionRequest'
  ||Object.keys(decision||{}).join(',')!=='behavior'||decision.behavior!==(offer.optionId==='allow-once'?'allow':'deny'))return;
 await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(output),error=>error?reject(error):resolve()));
 // This acknowledgement proves stdout pipe write only. Native lifecycle proves subsequent acceptance/tool outcome.
 post({hook_event_name:'TesseraApprovalAck',requestId:offer.requestId,requestHash:offer.requestHash},5);
}catch{} });
`.replace('PROVIDER', JSON.stringify(provider));
  const encoded = Buffer.from(source).toString('base64');
  const node = `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
  return style === 'windows-cmd' ? `${node} 2>nul & exit /b 0` : `${node} 2>/dev/null || true`;
}
