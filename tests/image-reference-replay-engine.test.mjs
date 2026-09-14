import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const test = require('node:test');
const assert = require('node:assert/strict');
const { Recording, ReplaySession, replayCells } = require('../runtime/image-reference-replay.cjs');

function fixture() {
  const recording = new Recording();
  let offset = 0;
  const append = (type, payload) => recording.append(JSON.stringify({ type, payload }), offset++);
  const call = (id, input) => append('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input });
  const output = (id, output = []) => append('response_item', { type: 'custom_tool_call_output', call_id: id, output });
  const event = (id, prompt, extra = {}) => append('event_msg', { type: 'item_completed', item: {
    id, kind: 'image_gen.generation', revisedPrompt: prompt, status: 'completed', result: 'YQ==', ...extra,
  } });
  return { recording, append, call, output, event };
}

test('syntax errors skip only the failed cell and preserve state for corrected image calls', async () => {
  const f = fixture();
  f.call('seed', 'store("ref","/reference.png");'); f.output('seed');
  f.call('invalid', 'store("ref","/wrong.png");text("oops");});');
  f.output('invalid', [{ type: 'input_text', text: 'Script error:\nSyntaxError: Unexpected token' }]);
  f.call('retry', 'await tools.image_gen__imagegen({prompt:"retry",referenced_image_paths:[load("ref")]});');
  f.event('exec-retry', 'retry'); f.output('retry');
  const result = await replayCells(f.recording);
  assert.equal(result.cells, 3);
  assert.match(result.diagnostics.find(d => d.callId === 'invalid').unresolved, /SyntaxError/);
  assert.equal(result.invocations[0]?.resultId, 'exec-retry');
  assert.deepEqual(result.invocations[0].referencedImagePaths, ['/reference.png']);
});

test('recorded image validation failure preserves stored values for a corrected retry', async () => {
  const f = fixture();
  f.call('rejected', 'store("prompt","retry");await tools.image_gen__imagegen({prompt:"first",referenced_image_paths:["/a.png"]});');
  f.output('rejected', [{ type: 'input_text', text: 'Script error:\nInvalid reference arguments' }]);
  f.call('retry', 'await tools.image_gen__imagegen({prompt:load("prompt"),referenced_image_paths:["/retry.png"]});');
  f.event('exec-retry', 'retry'); f.output('retry');
  const result = await replayCells(f.recording);
  assert.equal(result.invocations[0].status, 'error');
  assert.equal(result.invocations[0].error, 'Invalid reference arguments');
  assert.equal(result.invocations[1]?.resultId, 'exec-retry');
  assert.deepEqual(result.invocations[1].referencedImagePaths, ['/retry.png']);
});

test('parallel map calls match out-of-order results and recorded hints survive JSON output', async () => {
  const f = fixture();
  f.call('store', 'store("prompts",[0,1,2].map(i=>({key:i,prompt:`asset-${i}`,referenced_image_paths:[`/input-${i}.png`]})));');
  f.output('store');
  f.call('generate', 'await Promise.allSettled(load("prompts").map(async ({key,...args})=>store(String(key),await tools.image_gen__imagegen(args))));');
  for (const i of [2,0,1]) f.event(`exec-${i}`, `asset-${i}`);
  f.output('generate', [2,0,1].map(i=>({ type:'input_text', text:JSON.stringify({output_hint:`Generated images are saved to /exec-${i}.png`}) })));
  f.call('reuse', 'const p=load("1").output_hint.replace("Generated images are saved to ","");await tools.image_gen__imagegen({prompt:"reuse",referenced_image_paths:[p]});');
  const result = await replayCells(f.recording);
  assert.deepEqual(result.invocations.map(i=>i.resultId), ['exec-0','exec-1','exec-2',undefined]);
  assert.deepEqual(result.invocations[3].referencedImagePaths, ['/exec-1.png']);
});

test('large recorded image views dispose without crashing QuickJS', async () => {
  const f = fixture();
  f.call('views', 'for(const path of ["/a.png","/b.png","/c.png"])image((await tools.view_image({path})).image_url);');
  for (const [i,path] of ['/a.png','/b.png','/c.png'].entries()) f.append('event_msg', {type:'item_completed',item:{type:'ImageView',id:`view-${i}`,path}});
  f.output('views', [0,1,2].map(()=>({type:'input_image',image_url:'data:image/png;base64,'+'a'.repeat(4_500_000)})));
  const result = await replayCells(f.recording);
  assert.equal(result.diagnostics[0].done, true);
  assert.equal(result.diagnostics[0].error, null);
});

test('single call can use sole result even when revised prompt changed', async () => {
  const f = fixture();
  f.call('first', 'const r=await tools.image_gen__imagegen({prompt:"original"});store("r",r);');
  f.event('exec-first','rewritten original');
  f.output('first', [{type:'input_text',text:JSON.stringify({output_hint:'Generated images are saved to /exec-first.png'})}]);
  f.call('second', 'await tools.image_gen__imagegen({prompt:load("r").output_hint});');
  const r = await replayCells(f.recording);
  assert.equal(r.invocations[0].resultId, 'exec-first');
  assert.equal(r.invocations[1].prompt, 'Generated images are saved to /exec-first.png');
});

test('ambiguous parallel results stay unassigned and do not suppress later independent cells', async () => {
  const f=fixture();
  f.call('parallel', 'await Promise.allSettled(["a","b"].map(prompt=>tools.image_gen__imagegen({prompt})));');
  f.event('exec-a','rewritten-a'); f.event('exec-b','rewritten-b'); f.output('parallel');
  f.call('independent','await tools.image_gen__imagegen({prompt:"later",referenced_image_paths:["/later.png"]});');
  const r=await replayCells(f.recording);
  assert.equal(r.invocations.length,3);
  assert.ok(r.invocations.slice(0,2).every(i=>!i.resultId));
  assert.deepEqual(r.invocations[2].referencedImagePaths,['/later.png']);
});

test('yield and wait associate subsequent generation with the original exec', async () => {
  const f=fixture();
  f.call('yielded','const r=await tools.image_gen__imagegen({prompt:"yielded"});store("r",r);');
  f.output('yielded',[{type:'input_text',text:'Script running with cell ID cell-1'}]);
  const before=f.recording.generation;
  f.event('exec-yielded','yielded');
  assert.ok(f.recording.generation>before);
  f.append('response_item',{type:'function_call',name:'functions.wait',call_id:'wait-1',arguments:JSON.stringify({cell_id:'cell-1'})});
  f.append('response_item',{type:'function_call_output',call_id:'wait-1',output:[{type:'input_text',text:'Script completed'}]});
  const r=await replayCells(f.recording);
  assert.equal(r.invocations[0].resultId,'exec-yielded');
  assert.equal(r.diagnostics[0].done,true);
  assert.equal(f.recording.cells[0].closed,true);
});

test('direct image tool JSON arguments and stable recent image ids are retained', async () => {
  const f=fixture();
  f.append('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'hi'},{type:'input_image',image_url:'data:image/png;base64,YQ=='}]});
  f.append('response_item',{type:'function_call',name:'image_gen.imagegen',call_id:'direct',arguments:JSON.stringify({prompt:'direct',num_last_images_to_include:1})});
  f.event('exec-direct','direct',{savedPath:'/exec-direct.png'});
  f.append('response_item',{type:'function_call_output',call_id:'direct',output:'ok'});
  const r=await replayCells(f.recording);
  assert.equal(r.invocations[0].recentImages[0].sourceMessageId,'image-0-1');
  assert.equal(f.recording.images.at(-1).sourceMessageId,'hist-tool-exec-direct');
});

test('unrecorded tool values cannot provide truthy fabricated results', async () => {
  const f=fixture();
  f.call('unknown','if(await tools.web__run({}))await tools.image_gen__imagegen({prompt:"fabricated"});');
  f.output('unknown');
  const r=await replayCells(f.recording);
  assert.equal(r.invocations.length,0);
  assert.match(r.diagnostics[0].unresolved,/absent/);
});

test('recorded immediate tools preserve promise semantics without await', async () => {
  const f=fixture();
  f.call('command','const r=tools.exec_command({cmd:"echo ok"});store("isPromise",typeof r.then);');
  f.append('event_msg',{type:'item_completed',item:{type:'CommandExecution',command:['bash','-c','echo ok'],formatted_output:'ok',exit_code:0}});
  f.output('command');
  f.call('image','await tools.image_gen__imagegen({prompt:load("isPromise")});');
  const r=await replayCells(f.recording);
  assert.equal(r.invocations[0].prompt,'function');
});

test('parallel commands map recorded output by command identity, not output order', async () => {
  const f=fixture();
  f.call('commands','await Promise.all(["A","B"].map(async cmd=>store(cmd,(await tools.exec_command({cmd})).output)));');
  for(const cmd of ['B','A'])f.append('event_msg',{type:'item_completed',item:{type:'CommandExecution',command:['bash','-c',cmd],formatted_output:`/${cmd}.png`,exit_code:0}});
  f.output('commands',['B','A'].map(cmd=>({type:'input_text',text:JSON.stringify({output:`/${cmd}.png`,exit_code:0})})));
  f.call('image','await tools.image_gen__imagegen({prompt:"from commands",referenced_image_paths:[load("A"),load("B")]});');
  const r=await replayCells(f.recording);
  assert.deepEqual(r.invocations[0].referencedImagePaths,['/A.png','/B.png']);
});

test('image view calls must match recorded paths before exposing values', async () => {
  const f=fixture();
  f.call('view','await tools.view_image({path:"/different.png"});await tools.image_gen__imagegen({prompt:"wrong"});');
  f.append('event_msg',{type:'item_completed',item:{type:'ImageView',id:'view',path:'/original.png'}});
  f.output('view',[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]);
  const r=await replayCells(f.recording);
  assert.equal(r.invocations.length,0);
  assert.match(r.diagnostics[0].unresolved,/path/);
});

test('one recorded result cannot be assigned to the first of two identical parallel prompts', async () => {
  const f=fixture();
  f.call('parallel','await Promise.all(["/a.png","/b.png"].map(path=>tools.image_gen__imagegen({prompt:"same",referenced_image_paths:[path]})));');
  f.event('exec-only','same');
  const r=await replayCells(f.recording);
  assert.equal(r.invocations.length,2);
  assert.ok(r.invocations.every(i=>!i.resultId));
});

test('missing partial result fields cannot drive membership or enumeration branches', async () => {
  for (const expression of ['"output_hint" in r', 'Object.keys(r)', '({...r})']) {
    const f=fixture();
    f.call('first', `const r=await tools.image_gen__imagegen({prompt:"first"});if(${expression})await tools.image_gen__imagegen({prompt:"fabricated"});`);
    f.event('exec-first','first');f.output('first');
    const r=await replayCells(f.recording);
    assert.equal(r.invocations.length,1);
    assert.match(r.diagnostics[0].unresolved,/Unrecorded return field/);
  }
});

test('explicit recorded key enumeration permits Object.keys on a reconstructed result', async () => {
  const f=fixture();
  f.call('first','store("result",await tools.image_gen__imagegen({prompt:"first"}));');
  f.event('exec-first','first');
  f.output('first',[{type:'input_text',text:JSON.stringify({hint:'Generated images are saved to /exec-first.png',keys:['image_url','output_hint']})}]);
  f.call('second','await tools.image_gen__imagegen({prompt:Object.keys(load("result")).join(",")});');
  const r=await replayCells(f.recording);
  assert.equal(r.invocations[1].prompt,'image_url,output_hint');
});

test('CPU-bound transcript code is interrupted and a later isolate still works', async () => {
  const stalled = fixture(); stalled.call('loop', 'while(true){}'); stalled.output('loop');
  const result = await replayCells(stalled.recording, { cellTimeoutMs: 20 });
  assert.equal(result.invocations.length, 0);
  assert.ok(result.diagnostics.some(item => item.unresolved || item.error));
  const next = fixture(); next.call('next', 'void tools.image_gen__imagegen({prompt:"after timeout",referenced_image_paths:["/a.png"]});');
  assert.deepEqual((await replayCells(next.recording)).invocations[0].referencedImagePaths, ['/a.png']);
});

test('image body computations and reflective access stay unresolved without fabricating pixels', async () => {
  for (const expression of ['r.image_url.length', 'Object.getOwnPropertyDescriptor(r,"image_url").value', 'r.image_url ? "yes" : "no"']) {
    const f=fixture();
    f.call('body',`const r=await tools.view_image({path:"/a.png"});const computed=${expression};await tools.image_gen__imagegen({prompt:"must not run",referenced_image_paths:[computed]});`);
    f.append('event_msg',{type:'item_completed',item:{type:'ImageView',id:'view-a',path:'/a.png'}});
    f.output('body',[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]);
    const r=await replayCells(f.recording);
    assert.equal(r.invocations.length,0);
    assert.match(r.diagnostics[0].unresolved,/Image body/);
    assert.ok(!JSON.stringify(f.recording).includes('data:image/'));
  }
});
test('direct display-only image reads preserve awaited tool calls, but custom image functions cannot receive omitted bytes', async () => {
  for (const custom of [false,true]) {
    const f=fixture();
    f.call('display',`${custom?'globalThis.image=value=>store("body",value);':''}image((await tools.view_image({path:"/a.png"})).image_url);await tools.image_gen__imagegen({prompt:"next",referenced_image_paths:["/a.png"]});`);
    f.append('event_msg',{type:'item_completed',item:{type:'ImageView',id:'view-a',path:'/a.png'}});
    f.output('display',[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]);
    const r=await replayCells(f.recording);
    assert.equal(r.invocations.length,custom?0:1);
  }
});
