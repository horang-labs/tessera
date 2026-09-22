import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Recording, replayCells } = require('../runtime/image-reference-replay.cjs');

function fixture() {
  const recording = new Recording(); let offset = 0;
  const append = (type, payload) => recording.append({type, payload}, offset++);
  const call = (id, input) => append('response_item', {type:'custom_tool_call',name:'exec',call_id:id,input});
  const output = (id, text = 'Script completed') => append('response_item', {type:'custom_tool_call_output',call_id:id,output:[{type:'text',text}]});
  const event = (id, prompt) => append('event_msg', {type:'item_completed',item:{id,kind:'image_gen.generation',revisedPrompt:prompt,status:'completed',result:{__tesseraImage:{length:1}}}});
  const image = (id, source = '["/ref.png"]') => {
    call(id, `await tools.image_gen__imagegen({prompt:${JSON.stringify(id)},referenced_image_paths:${source}});`);
    event(`exec-${id}`, id); output(id);
  };
  const wait = (id, cellId, terminate = false) => append('response_item',{type:'function_call',name:'functions.wait',call_id:id,arguments:JSON.stringify({cell_id:cellId,terminate})});
  return {recording,append,call,output,event,image,wait};
}

test('unfinished earlier execs do not hide later results with explicit returned IDs', async () => {
  const f=fixture();
  f.call('unfinished',`store('ref','/unfinished.png');await new Promise(()=>{});`);
  f.output('unfinished','Script running with cell ID first');
  f.call('later',`await tools.image_gen__imagegen({prompt:'later',referenced_image_paths:['/right.png']});`);
  f.event('exec-later','later');
  f.output('later','Generated images are saved to /images as /images/exec-later.png by default.');
  const result=await replayCells(f.recording);
  assert.equal(result.cells,2);
  assert.equal(result.invocations[0].resultId,'exec-later');
  assert.deepEqual(result.invocations[0].referencedImagePaths,['/right.png']);
});

test('CPU and heap failures discard only their cell and continue the same recording', async () => {
  for(const [source,reason] of [
    ['while(true){}',/interrupted/i],
    ['new ArrayBuffer(8*1024*1024);',/out of memory/i],
  ]) {
    const f=fixture();
    f.call('failed',source);f.output('failed');f.image('after');
    const result=await replayCells(f.recording,{cellTimeoutMs:100,memoryLimitBytes:4*1024*1024});
    assert.equal(result.cells,2);
    assert.match(result.diagnostics[0].unresolved || result.diagnostics[0].error,reason);
    assert.equal(result.invocations.at(-1).resultId,'exec-after');
    assert.deepEqual(result.invocations.at(-1).referencedImagePaths,['/ref.png']);
  }
});

test('recorded turn IDs disambiguate yielded calls without guessing unknown turn ownership', async () => {
  for(const known of [true,false]) {
    const f=fixture();
    if(known)f.append('turn_context',{turn_id:'old'});
    f.call('old','await new Promise(()=>{});');f.output('old','Script running with cell ID old');
    f.append('event_msg',{type:'task_started',turn_id:'new'});
    f.call('new',`await tools.image_gen__imagegen({prompt:'new',referenced_image_paths:['/new.png']});`);
    f.append('event_msg',{type:'item_completed',turn_id:'new',item:{id:'exec-new',kind:'image_gen.generation',revisedPrompt:'new',status:'completed',result:{__tesseraImage:{length:1}}}});
    f.output('new');
    const result=await replayCells(f.recording);
    assert.equal(result.invocations[0].resultId,known?'exec-new':undefined);
  }
});

test('display and notification helpers preserve argument side effects and yield loops continue', async () => {
  const f=fixture();
  f.call('helpers', `let count=0;for(const fn of [text,image,audio,generatedImage,notify])fn(++count);store('count',String(count));
    for(let i=0;i<3;i++){await tools.image_gen__imagegen({prompt:'loop'+i,referenced_image_paths:['/'+i+'.png']});await yield_control();}`);
  for(let i=0;i<3;i++)f.event('exec-'+i,'loop'+i);
  f.output('helpers'); f.image('after','[load("count")]');
  const result=await replayCells(f.recording);
  assert.equal(result.invocations.length,4);
  assert.deepEqual(result.invocations.at(-1).referencedImagePaths,['5']);
  assert.ok(result.diagnostics.every(d=>!d.error&&!d.unresolved));
});

test('exit preserves pre-exit state and discards catch/finally and later image effects', async () => {
  for(const code of [
    `store('ref','/before.png');exit();store('ref','/after.png');`,
    `store('ref','/before.png');try{exit()}catch(e){store('ref','/catch.png')}finally{store('ref','/finally.png')}await tools.image_gen__imagegen({prompt:'wrong'});`,
    `store('ref','/before.png');try{exit()}catch(e){while(true){}}`,
  ]) {
    const f=fixture();f.call('exit',code);f.output('exit');f.image('after','[load("ref")]');
    const result=await replayCells(f.recording,{cellTimeoutMs:100});
    assert.equal(result.invocations.length,1);
    assert.deepEqual(result.invocations[0].referencedImagePaths,['/before.png']);
  }
});

test('globals and display overrides do not leak while explicit state survives', async () => {
  const f=fixture();
  f.call('seed',`globalThis.leaked='/wrong.png';globalThis.image=()=>{throw Error('leaked helper')};store('ref','/right.png');`);f.output('seed');
  f.call('after',`image('ignored');await tools.image_gen__imagegen({prompt:'after',referenced_image_paths:[typeof leaked==='undefined'?load('ref'):leaked]});`);
  f.event('exec-after','after');f.output('after');
  const result=await replayCells(f.recording);
  assert.deepEqual(result.invocations[0].referencedImagePaths,['/right.png']);
});

test('unawaited image completions cannot mutate state after top-level completion', async () => {
  const f=fixture();
  f.call('pending',`store('ref','/right.png');void tools.image_gen__imagegen({prompt:'pending'}).then(()=>store('ref','/wrong.png'));`);
  f.event('exec-pending','pending');f.output('pending');f.image('after','[load("ref")]');
  const result=await replayCells(f.recording);
  assert.deepEqual(result.invocations.at(-1).referencedImagePaths,['/right.png']);
});

test('virtual timers honor await, cancellation, microtasks and discard after completion', async () => {
  const f=fixture();
  f.call('timer',`const order=[];const cancelled=setTimeout(()=>order.push('wrong'),0);clearTimeout(cancelled);
    const waited=new Promise(resolve=>setTimeout(()=>{order.push('timer');resolve()},10000));
    Promise.resolve().then(()=>order.push('microtask'));await waited;
    store('order',order.join(','));setTimeout(()=>store('order','wrong'),0);`);f.output('timer');f.image('after','[load("order")]');
  const result=await replayCells(f.recording);
  assert.deepEqual(result.invocations.at(-1).referencedImagePaths,['microtask,timer']);
});

test('timer/tool races and absent catalogs fail explicitly and permit independent later cells', async () => {
  for(const [source,expected] of [
    [`await Promise.race([tools.image_gen__imagegen({prompt:'race'}),new Promise(r=>setTimeout(r,1))]);await tools.image_gen__imagegen({prompt:'invented'});`,/ordering/],
    [`const found=ALL_TOOLS.find(t=>t.name.includes('image'));await tools.image_gen__imagegen({prompt:found.name});`,/catalog/],
  ]) {
    const f=fixture();f.call('unknown',source);if(source.includes('race'))f.event('exec-race','race');f.output('unknown');f.image('independent');
    const result=await replayCells(f.recording);
    assert.match(result.diagnostics[0].unresolved,expected);
    assert.ok(!result.invocations.some(i=>i.prompt==='invented'));
    assert.equal(result.invocations.at(-1).resultId,'exec-independent');
  }
});

test('terminated yield loops do not invent unobserved iterations', async () => {
  const f=fixture();
  f.call('loop',`for(let i=0;i<3;i++){await tools.image_gen__imagegen({prompt:'loop'+i,referenced_image_paths:['/'+i+'.png']});await yield_control();store('continued','wrong');}`);
  f.event('exec-0','loop0');f.output('loop','Script running with cell ID yielded');
  f.wait('stop','yielded',true);f.output('stop','Script terminated');
  f.image('after','[load("continued")||"/right.png"]');
  const result=await replayCells(f.recording);
  assert.deepEqual(result.invocations.map(i=>i.prompt),['loop0','after']);
  assert.deepEqual(result.invocations.at(-1).referencedImagePaths,['/right.png']);
});

test('yielded call results still associate after an intervening completed exec', async () => {
  const f=fixture();
  f.call('loop',`for(let i=0;i<2;i++){await tools.image_gen__imagegen({prompt:'loop'+i,referenced_image_paths:['/'+i+'.png']});await yield_control();}`);
  f.event('exec-0','loop0');f.output('loop','Script running with cell ID yielded');
  f.call('other','text("other");');f.output('other');
  f.wait('resume','yielded');f.event('exec-1','loop1');f.output('resume');
  const result=await replayCells(f.recording);
  assert.deepEqual(result.invocations.map(i=>i.resultId),['exec-0','exec-1']);
});

test('ordinary timer and unsupported-state failures do not suppress independent cells', async () => {
  for (const source of [
    `await new Promise(resolve=>setTimeout(()=>{throw Error('timer failure')},0));`,
    `store('unsupported',()=>'/unknown.png');`,
  ]) {
    const f=fixture();f.call('failed',source);f.output('failed');f.image('independent');
    const result=await replayCells(f.recording);
    const failed = result.diagnostics.filter(d=>d.callId==='failed');
    assert.equal(failed.length,1);
    assert.ok(failed[0].unresolved||failed[0].error);
    assert.equal(result.invocations.at(-1)?.resultId,'exec-independent');
  }
});

test('overlapping stateful execs refuse to invent a sequential state history', async () => {
  for (const [write,read] of [
    [`store('ref','/new.png')`,`load('ref')`],
    [`globalThis['store']('ref','/new.png')`,`globalThis['load']('ref')`],
  ]) {
    const f=fixture();f.call('seed',`store('ref','/old.png');`);f.output('seed');
    f.call('yielded',`await yield_control();await tools.image_gen__imagegen({prompt:'after overlap',referenced_image_paths:[${read}]});`);
    f.output('yielded','Script running with cell ID suspended');
    f.call('intervening',write);f.output('intervening');
    f.wait('resume','suspended');f.event('exec-overlap','after overlap');f.output('resume');
    f.image('independent');
    const result=await replayCells(f.recording);
    assert.ok(!result.invocations.some(i=>i.resultId==='exec-overlap'));
    assert.ok(result.diagnostics.some(d=>/overlap|concurrent|interleav/i.test(d.unresolved??d.error??'')));
    assert.equal(result.invocations.at(-1)?.resultId,'exec-independent');
  }
});

test('unrecorded clocks and randomness cannot fabricate image paths', async () => {
  for (const expression of ['Date.now()', 'new Date()', 'Date()', 'Math.random()']) {
    const f=fixture();
    f.call('clock', `await tools.image_gen__imagegen({prompt:'clock',referenced_image_paths:[String(${expression})]});`);
    f.event('exec-clock','clock');f.output('clock');f.image('independent');
    const result=await replayCells(f.recording);
    assert.match(result.diagnostics[0].unresolved,/Historical clock or random/);
    assert.deepEqual(result.invocations.map(i=>i.resultId),['exec-independent']);
  }
});

test('lost stored state cannot silently take a missing-key fallback path in a later exec', async () => {
  for (const source of ['await tools.unknown_tool({});', 'while(true){}']) {
    const f = fixture();
    f.call('seed', `store('ref','/actual.png');`); f.output('seed');
    f.call('uncertain', source); f.output('uncertain');
    f.image('dependent', `[load('ref') || '/invented-default.png']`);
    f.image('independent');
    const result = await replayCells(f.recording, { cellTimeoutMs: 30 });
    assert.ok(!result.invocations.some(i => i.callId === 'dependent'), 'unknown state must differ from an absent key');
    assert.equal(result.invocations.at(-1).resultId, 'exec-independent');
  }
});

test('explicit writes can recover individual keys after lost state, while other keys stay unknown', async () => {
  const f = fixture(); f.call('uncertain', 'await tools.unknown_tool({});'); f.output('uncertain');
  f.call('write', `store('known','/known.png');`); f.output('write');
  f.image('known', `[load('known')]`); f.image('unknown', `[load('unknown') || '/invented.png']`);
  const result = await replayCells(f.recording);
  assert.deepEqual(result.invocations.map(i => i.referencedImagePaths), [['/known.png']]);
});
