import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImageReferenceScript, type ImageReferenceBindings } from '@/lib/image-generation/reference-script';
import { applyImageTool, createImageIndex } from '@/lib/image-generation/incremental-state';
import { createCodexTranscriptDecoderState, decodeCodexTranscriptLine } from '@/lib/cli/providers/codex/transcript-decoder';
import type { EnhancedMessage } from '@/types/chat';

const paths = ['/mnt/c/Users/work/Downloads/frame.png', '/home/work/assets/싹냥이.png', '/home/work/assets/골냥이.png'];
const call = (refs: string) => `tools.image_gen__imagegen({prompt:"edit", referenced_image_paths:${refs}})`;

test('resolves the reported store/load and indexed array calls across persisted exec cells', () => {
  let bindings: ImageReferenceBindings = { stored: [] };
  parseImageReferenceScript(`const paths=${JSON.stringify(paths)};store("realrefs",paths);
    for(const path of paths){const r=await tools.view_image({path});image(r.image_url);}`, bindings);
  bindings = JSON.parse(JSON.stringify(bindings));
  const [first] = parseImageReferenceScript(`const r=await ${call('load("realrefs")')};generatedImage(r)`, bindings);
  assert.deepEqual(first.referencedImagePaths, paths);
  assert.equal(first.referencesUnresolved, undefined);
  const [second] = parseImageReferenceScript(`const p=load("realrefs");const r=await ${call('["/home/work/generated.png",p[1],p[2]]')}`, bindings);
  assert.deepEqual(second.referencedImagePaths, ['/home/work/generated.png', ...paths.slice(1)]);
});

test('locals are cell-scoped; stored data is bounded and unknown overwrites discard stale values', () => {
  const bindings: ImageReferenceBindings = { stored: [] };
  parseImageReferenceScript('const p=["a.png"];store("refs",p)', bindings);
  assert.equal(parseImageReferenceScript(call('p'), bindings)[0].referencesUnresolved, true);
  parseImageReferenceScript('store("refs",await tools.some_tool({}))', bindings);
  assert.equal(parseImageReferenceScript(call('load("refs")'), bindings)[0].referencesUnresolved, true);
  for (let index = 0; index < 100; index++) parseImageReferenceScript(`store("${index}",["a.png"])`, bindings);
  assert.ok(bindings.stored.length <= 64);
  parseImageReferenceScript(`store("oversized",["${'x'.repeat(20_000)}"])`, bindings);
  assert.equal(bindings.stored.some(([key]) => key === 'oversized'), false);
  parseImageReferenceScript('store("imageBytes","data:image/png;base64,AAAA");store("output","arbitrary shell output")', bindings);
  assert.equal(bindings.stored.some(([key]) => key === 'imageBytes' || key === 'output'), false);
});

test('handles data composition without executing functions or inventing conditional values', () => {
  const bindings: ImageReferenceBindings = { stored: [] };
  assert.deepEqual(parseImageReferenceScript(`const dir="/home/work"; const p=[dir+"/a.png"]; ${call('[...p, `${dir}/b.png`]')}`, bindings)[0].referencedImagePaths,
    ['/home/work/a.png', '/home/work/b.png']);
  for (const change of ['if(flag) store("refs",["b.png"])', 'const p=load("refs");p.push("b.png")', 'mutateReferences()']) {
    parseImageReferenceScript('store("refs",["a.png"])', bindings);
    parseImageReferenceScript(change, bindings);
    assert.equal(parseImageReferenceScript(call('load("refs")'), bindings)[0].referencesUnresolved, true, change);
  }
  const [spread] = parseImageReferenceScript('tools.image_gen__imagegen({referenced_image_paths:["a.png"], ...unknown})', bindings);
  assert.equal(spread.referencesUnresolved, true);
  assert.deepEqual(parseImageReferenceScript('const example="tools.image_gen__imagegen({prompt: 1})"', bindings), []);
});

test('the decoder/index seam captures reference-only cells once, survives state reload and freezes inputs', () => {
  let index = createImageIndex();
  const decoder = createCodexTranscriptDecoderState();
  const feed = (payload: unknown) => {
    for (const event of decodeCodexTranscriptLine(JSON.stringify({type:'response_item',payload}), decoder, {includeImageReferenceScripts:true})) {
      if (event.type === 'tool_call') applyImageTool(index, {...event,id:event.toolUseId,sessionId:'test'} as Extract<EnhancedMessage,{type:'tool_call'}>);
    }
  };
  feed({type:'custom_tool_call',name:'exec',call_id:'store',input:`store("refs",${JSON.stringify(paths)})`});
  feed({type:'custom_tool_call',name:'exec',call_id:'edit',input:call('load("refs")')});
  index = JSON.parse(JSON.stringify(index));
  feed({type:'custom_tool_call',name:'exec',call_id:'replace',input:'store("refs",["new.png"])'});
  feed({type:'custom_tool_call_output',call_id:'store',output:'ok'});
  feed({type:'custom_tool_call_output',call_id:'edit',output:'ok'});
  assert.equal(index.traces.length, 1);
  assert.deepEqual(index.traces[0].inputs.map((image) => image.label), paths);
  assert.equal(index.traces[0].unresolvedInputCount, 0);
  feed({type:'custom_tool_call',name:'exec',call_id:'next',input:call('load("refs")')});
  assert.equal(index.traces[1].inputs[0].label, 'new.png');
});

test('preserves calls inside Promise wrappers and accounts for mutations in tool arguments', () => {
  const bindings: ImageReferenceBindings = { stored: [] };
  const calls = parseImageReferenceScript(`await Promise.all([${call('["a.png"]')}, ${call('["b.png"]')}])`, bindings);
  assert.deepEqual(calls.map((entry) => entry.referencedImagePaths), [['a.png'], ['b.png']]);
  const [mutated] = parseImageReferenceScript(`const p=["a.png"];await tools.view_image({path:(p[0]="b.png")});${call('p')}`, bindings);
  assert.equal(mutated.referencesUnresolved, true);
  const [duplicate] = parseImageReferenceScript(`const refs=["a.png"];tools.image_gen__imagegen({prompt:"edit",referenced_image_paths:refs,referenced_image_paths:["b.png"]})`, bindings);
  assert.equal(duplicate.referencesUnresolved, true);
  const [shadowed] = parseImageReferenceScript(`const load=()=>["b.png"];${call('load("refs")')}`, bindings);
  assert.equal(shadowed.referencesUnresolved, true);
  assert.deepEqual(parseImageReferenceScript(`await ${call('["a.png"]')}.then(generatedImage)`, bindings)[0].referencedImagePaths, ['a.png']);
  const [destructured] = parseImageReferenceScript(`const {image_url}=await tools.view_image({path:"a.png"});image(image_url);${call('["a.png"]')}`, bindings);
  assert.deepEqual(destructured.referencedImagePaths, ['a.png']);
  assert.equal(destructured.referencesUnresolved, undefined);
  assert.equal(parseImageReferenceScript(`const {image:preview}=result;${call('["a.png"]')}`, bindings)[0].referencesUnresolved, undefined);
});
