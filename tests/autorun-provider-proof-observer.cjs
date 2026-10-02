const fs=require('fs'); const cp=require('child_process');
let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{
 const p=JSON.parse(s); const base=process.env.PROOF_ROOT;
 let b=Buffer.alloc(0);try{b=fs.readFileSync(fs.realpathSync(p.transcript_path))}catch{}
 const cursor=b.lastIndexOf(10)+1;
 const file=base+'/hook-'+Date.now()+'-'+process.pid;
 fs.writeFileSync(file+'.json',JSON.stringify({...p,proof_cursor:cursor}));
 fs.writeFileSync(file+'.jsonl',b);
 const child=cp.spawn('/bin/sh',['-c',fs.readFileSync(base+'/bridge-command.txt','utf8')],{stdio:['pipe','ignore','ignore']});
 child.stdin.end(JSON.stringify({...p,proof_cursor:cursor}));
});
