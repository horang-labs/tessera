'use strict';

// This module runs only in the replay worker. Transcript code never runs in Node.
const { getQuickJS } = require('quickjs-emscripten');
const { parse } = require('acorn');
const { MetadataDecoder, readMetadataRecords } = require('./image-record-reader.cjs');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');

const MAX_SOURCE = 128 * 1024;
const MAX_STATE = 32 * 1024 * 1024;
const MAX_CELLS = 10000;
const MAX_ARGUMENTS = 64 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function textBlocks(output) {
  return Array.isArray(output) ? output.filter(b => b?.type === 'input_text' || b?.type === 'text').map(b => b.text).filter(t => typeof t === 'string')
    : typeof output === 'string' ? [output] : [];
}

function imageArguments(value) {
  if (!isObject(value) || typeof value.prompt !== 'string' || value.prompt.length > 32000) return null;
  const paths = value.referenced_image_paths;
  const recent = value.num_last_images_to_include;
  if (paths != null && (!Array.isArray(paths) || paths.length > 64 || !paths.every(p => typeof p === 'string' && p.length < 8192 && !p.includes('\0')))) return null;
  if (recent != null && (!Number.isInteger(recent) || recent < 0 || recent > 5)) return null;
  if (paths != null && recent != null && recent !== 0) return null;
  return { prompt: value.prompt, ...(paths != null ? { referencedImagePaths: paths } : {}),
    ...(recent != null ? { numLastImagesToInclude: recent } : {}) };
}

/** Omit only the image body's final read when passed directly to the display helper.
 * The object expression (including awaits/tool calls) still executes normally.
 * Body reads in calculations, aliases, conditions and custom display functions fail closed.
 */
function displayOnlySource(source) {
  const edits = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    const argument = node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier'
      && node.callee.name === 'image' && node.arguments.length === 1 ? node.arguments[0] : undefined;
    if (argument?.type === 'MemberExpression' && !argument.optional
      && (argument.computed ? argument.property.type === 'Literal' && argument.property.value === 'image_url' : argument.property.name === 'image_url')) {
      edits.push({ start: node.start, end: node.end, value: `__displayImage(image,${source.slice(argument.object.start, argument.object.end)})` });
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

class Recording {
  constructor() {
    this.cells = []; this.active = new Map(); this.yielded = new Map(); this.waits = new Map(); this.hints = new Map(); this.resultKeys = new Map(); this.offset = 0;
    this.images = []; this.generation = 0; this.metadataBytes = 0; this.retainedBytes = 0;
  }
  append(raw, offset) {
    let record;
    if (typeof raw === 'string') {
      const decoder = new MetadataDecoder(offset);
      const records = decoder.push(Buffer.from(raw.endsWith('\n') ? raw : raw + '\n'), offset);
      record = records[0]?.record;
    } else record = raw;
    if (!record) return;
    offset = record.__tesseraRecordOffset ?? offset;
    const p = record.payload;
    if (!isObject(p)) return;
    const timestamp = record.timestamp ?? '';
    const retain = () => {
      this.retainedBytes += Buffer.byteLength(JSON.stringify(record));
      if (this.retainedBytes > 16 * 1024 * 1024) throw Error('Replay recording memory limit exceeded');
    };
    if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)
      && ['imagegen', 'image_gen.imagegen', 'image_gen__imagegen', 'tools.image_gen__imagegen'].includes(p.name)) {
      let args; try { args = JSON.parse(p.arguments ?? p.input); } catch { return; }
      if (!imageArguments(args)) return;
      p.type = 'custom_tool_call'; p.name = 'exec';
      p.input = `await tools.image_gen__imagegen(${JSON.stringify(args)});`;
    }
    if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) && ['wait', 'functions.wait'].includes(p.name)) {
      try { const args = JSON.parse(p.arguments ?? p.input); const cell = this.yielded.get(args.cell_id); if (cell) { this.active.set(p.call_id, cell); } } catch { /* malformed wait */ }
      return;
    }
    if (record.type === 'response_item' && p.type === 'custom_tool_call' && ['exec', 'functions.exec'].includes(p.name)) {
      if (this.cells.length >= MAX_CELLS) throw Error('Replay cell limit exceeded');
      this.metadataBytes += Buffer.byteLength(p.input ?? '');
      if (this.metadataBytes > 16 * 1024 * 1024) throw Error('Replay source limit exceeded');
      retain();
      const cell = { id: p.call_id, source: p.input, timestamp, offset, events: [], output: undefined, closed: false, recent: this.images.slice(-5) };
      this.cells.push(cell); this.active.set(p.call_id, cell); this.generation++;
      return;
    }
    if (record.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
      const cell = this.active.get(p.call_id);
      if (cell) {
        retain();
        cell.output = cell.output === undefined ? p.output : [...(Array.isArray(cell.output) ? cell.output : [{ type: 'text', text: cell.output }]), ...(Array.isArray(p.output) ? p.output : [{ type: 'text', text: p.output }])];
        // Yielded execs need an explicit continuation association; do not pretend
        // the output closes the computation or associate later images by timing.
        cell.yielded = textBlocks(p.output).some(t => /Script running with cell ID/.test(t));
        cell.closed = !cell.yielded; this.active.delete(p.call_id); this.generation++;
        const yieldedId = textBlocks(p.output).map(t => t.match(/Script running with cell ID ([\w-]+)/)?.[1]).find(Boolean);
        if (yieldedId) this.yielded.set(yieldedId, cell);
        if (cell.closed) for (const [id, value] of this.yielded) if (value === cell) this.yielded.delete(id);
      }
      for (const text of textBlocks(p.output)) {
        let value; try { value = JSON.parse(text); } catch { /* rendered text */ }
        for (const candidate of [value?.hint, value?.output_hint, value?.result?.output_hint, text.startsWith('Generated images are saved to ') ? text : undefined]) {
          if (typeof candidate !== 'string') continue;
          const starts = [...candidate.matchAll(/Generated images are saved to /g)].map(m => m.index);
          for (let i = 0; i < starts.length; i++) {
            const hint = candidate.slice(starts[i], starts[i + 1] ?? candidate.length).trim();
            const id = hint.match(/\/(exec-[\w-]+)\.png\b/)?.[1];
            if (id && hint.length < 8192) {
              this.hints.set(id, hint); this.generation++;
              if (Array.isArray(value?.keys) && value.keys.every(key => typeof key === 'string')) this.resultKeys.set(id, value.keys);
            }
          }
        }
      }
      return;
    }
    const item = p.item;
    if (record.type === 'event_msg' && p.type === 'item_completed' && isObject(item)) {
      const generation = item.kind === 'image_gen.generation' || item.type === 'imageGeneration';
      const active = new Set([...this.active.values(), ...this.yielded.values()]);
      if (active.size === 1) { retain(); active.values().next().value.events.push({ item, offset }); }
      this.generation++;
      if (generation && item.status !== 'failed' && !item.failure && (item.savedPath || item.result?.__tesseraImage?.length > 0)) {
        this.images.push({ sourceMessageId: `hist-tool-${item.id}`, source: 'generated', label: 'Generated image',
          locator: item.result?.__tesseraCachedImage?.path ? { kind: 'cache', path: item.result.__tesseraCachedImage.path }
            : item.savedPath ? { kind: 'path', path: item.savedPath } : { kind: 'cache', path: '' } });
      }
      if (item.type === 'ImageView' && typeof item.path === 'string') {
        let path = item.path;
        try { path = decodeURI(path).replace(/^file:\/\//, ''); } catch { /* retain original */ }
        this.images.push({ sourceMessageId: `hist-tool-${item.id}`, source: 'file', label: 'Viewed image', locator: { kind: 'path', path } });
      }
      if (this.images.length > 5) this.images.splice(0, this.images.length - 5);
    }
    if (record.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      if (p.content.some(b => b.type === 'input_image')) retain();
      for (const [ordinal, b] of p.content.entries()) if (b.type === 'input_image' && b.image_url?.__tesseraImage) {
        this.images.push({ sourceMessageId: `image-${offset}-${ordinal}`, source: 'conversation', label: 'Conversation image',
          locator: { kind: 'cache', path: b.image_url.__tesseraCachedImage?.path ?? '' } });
      }
      this.images = this.images.slice(-5);
    }
  }
}

async function prefixHash(file, offset) {
  const buffer = Buffer.alloc(Math.min(offset, 256));
  await file.read(buffer, 0, buffer.length, offset - buffer.length);
  return createHash('sha256').update(buffer).digest('hex');
}

// Read bounded windows and release each completed prefix after replay. The VM
// remains alive across windows, so store/load can retain Maps, proxies and other
// values without serializing them or keeping the transcript that created them.
async function* streamCells(recording, filePath, end) {
  let offset = 0, count = 0;
  while (offset < end) {
    const scanned = await readMetadataRecords(filePath, { start: offset, end, maxBytes: 256 * 1024 }, (record, position) => {
      recording.append(record, position);
    });
    if (scanned.offset === offset) break;
    offset = scanned.offset;
    while (recording.cells[0]?.closed) {
      const cell = recording.cells[0];
      if (++count > MAX_CELLS) throw Error('Replay cell limit exceeded');
      yield cell;
      recording.cells.shift();
      for (const { item } of cell.events) {
        recording.hints.delete(item.id); recording.resultKeys.delete(item.id);
      }
    }
    // Only unfinished calls count toward the retained-record limit. Include
    // their complete metadata, not just their JavaScript source.
    recording.metadataBytes = recording.cells.reduce((n, cell) => n + Buffer.byteLength(cell.source ?? ''), 0);
    recording.retainedBytes = Buffer.byteLength(JSON.stringify(recording.cells));
  }
  for (const cell of recording.cells) {
    if (++count > MAX_CELLS) throw Error('Replay cell limit exceeded');
    yield cell;
  }
}

class ReplaySession {
  constructor() { this.path = ''; this.boundary = ''; this.identity = ''; this.offset = 0; this.lastResult = null; }
  async read(filePath, cutoff, reset = false) {
    const file = await fs.open(filePath, 'r');
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      const end = Math.min(cutoff, stat.size);
      const boundary = await prefixHash(file, end);
      if (reset || this.path !== filePath || this.identity !== identity || this.offset !== end || this.boundary !== boundary) this.lastResult = null;
      this.path = filePath; this.identity = identity; this.offset = end; this.boundary = boundary;
    } finally { await file.close(); }
  }
  async run() {
    if (this.lastResult) return this.lastResult;
    const recording = new Recording();
    // Re-read on append: unfinished executions may now have new return values.
    // A fresh VM avoids applying their store mutations twice. Unchanged polls
    // reuse lastResult and perform no replay.
    this.lastResult = await replayCells(recording, { cells: streamCells(recording, this.path, this.offset) });
    return this.lastResult;
  }
}

async function replayCells(recording, { cellTimeoutMs = 2000, memoryLimitBytes = MAX_STATE, cells = recording.cells } = {}) {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime(); runtime.setMemoryLimit(memoryLimitBytes); runtime.setMaxStackSize(512 * 1024);
  let deadline = performance.now() + cellTimeoutMs;
  runtime.setInterruptHandler(() => performance.now() > deadline);
  const vm = runtime.newContext();
  const invocations = [], diagnostics = [];
  let cell, unknown, captured, commandCursor, usedResults;
  const evaluate = code => {
    const result = vm.evalCode(code);
    if (result.error) {
      let value; try { value = vm.dump(result.error); } finally { result.error.dispose(); }
      throw Error(value?.message ?? 'Replay evaluation failed');
    }
    try { return vm.dump(result.value); } finally { result.value.dispose(); }
  };
  const unknownValue = reason => { unknown = reason; return { unknown: reason }; };
  const native = vm.newFunction('__recordedTool', (nameHandle, argsHandle) => {
    try {
      const name = vm.getString(nameHandle), encoded = vm.getString(argsHandle);
      if (encoded.length > MAX_ARGUMENTS) return vm.newString(JSON.stringify(unknownValue('Tool arguments exceeded replay limit')));
      const args = JSON.parse(encoded);
      let reply;
      if (name === 'image_gen__imagegen') {
        const parsed = imageArguments(args);
        if (!parsed || unknown) reply = unknownValue('Image arguments could not be reconstructed');
        else {
          const results = cell.events.filter(e => (e.item.kind === 'image_gen.generation' || e.item.type === 'imageGeneration')
            && e.item.revisedPrompt === parsed.prompt && !usedResults.has(e.item.id));
          // A unique exact prompt inside this outer call is evidence. Arrival
          // order alone and fuzzy prompt similarity are not evidence.
          const event = results.length === 1 ? results[0] : undefined;
          if (event) usedResults.add(event.item.id);
          const invocation = { callId: cell.id, ordinal: captured++, timestamp: cell.timestamp, ...parsed,
            status: event ? event.item.status === 'failed' || event.item.failure ? 'error' : 'completed' : 'running',
            ...(event ? { resultId: event.item.id } : {}),
            ...(parsed.numLastImagesToInclude ? { recentImages: cell.recent } : {}) };
          invocations.push(invocation);
          if (!event && cell.recordedFailure) {
            // Validation can reject before a generation event exists. Preserve
            // the actual rejection and preceding store writes for later retries.
            invocation.status = 'error'; invocation.error = cell.recordedFailure;
            reply = { rejection: cell.recordedFailure };
          } else if (!event) reply = { pending: true, ordinal: invocation.ordinal };
          else if (invocation.status === 'error') {
            const observed = cell.texts.map(t => { try { return JSON.parse(t).error; } catch { return undefined; } }).find(t => typeof t === 'string');
            invocation.error = observed ?? 'Image generation failed';
            reply = { order: event.offset, rejection: observed ?? 'Image generation failed' };
          } else reply = { order: event.offset, valueRef: `generation:${event.item.id}`, partial: true };
        }
      } else if (name === 'view_image') {
        const viewEvents = cell.events.filter(e => e.item.type === 'ImageView');
        const normalize = value => { try { return decodeURI(value).replace(/^file:\/\//, ''); } catch { return value; } };
        const index = viewEvents.findIndex((e, i) => !usedResults.has(`view:${i}`) && normalize(e.item.path) === args.path);
        const block = cell.images[index];
        if (index >= 0 && block && viewEvents.length === cell.images.length) {
          usedResults.add(`view:${index}`);
          reply = { valueRef: `view:${index}`, partial: true };
        } else reply = cell.recordedFailure ? { rejection: cell.recordedFailure } : unknownValue('Image view return is absent or does not match the requested path');
      } else if (name === 'exec_command' || name === 'write_stdin') {
        const commandEvents = cell.events.filter(e => e.item.type === 'CommandExecution');
        const matches = commandEvents.filter(e => e.item.command?.at(-1) === args.cmd);
        if (name === 'exec_command' && matches.length === 1) {
          const item = matches[0].item;
          const output = item.formatted_output ?? item.aggregated_output;
          const observed = cell.commands.filter(c => c.output === output);
          if (observed.length === 1) reply = { value: observed[0], partial: true };
          else if (commandEvents.length === 1 && cell.commands.length === 1) reply = { value: cell.commands[0], partial: true };
          else if (typeof output === 'string') reply = { value: { output, exit_code: item.exit_code }, partial: true };
          else reply = unknownValue('Command return is absent from the recording');
        } else if (!commandEvents.length && cell.commands.length === 1 && commandCursor++ === 0) {
          reply = { value: cell.commands[0], partial: true };
        } else if (name === 'write_stdin' && cell.commands.length === 1 && commandCursor++ === 0) {
          reply = { value: cell.commands[0], partial: true };
        } else reply = unknownValue('Command return cannot be uniquely associated with its arguments');
      } else if (name === 'apply_patch') {
        if (cell.recordedFailure) reply = { rejection: cell.recordedFailure };
        else {
          const patch = cell.json.find(o => isObject(o) && Object.keys(o).length === 0);
          reply = patch ? { value: patch, partial: true } : unknownValue('Patch return is absent from the recording');
        }
      } else if (name === 'web__run') {
        reply = unknownValue('Web return is absent from the recording');
      } else reply = unknownValue('Tool return is not recorded: ' + name);
      return vm.newString(JSON.stringify(reply));
    } catch { return vm.newString(JSON.stringify(unknownValue('Recorded tool replay failed'))); }
  });
  const mark = vm.newFunction('__unknown', value => { unknown = vm.getString(value); return vm.undefined; });
  vm.setProp(vm.global, '__recordedTool', native); native.dispose(); vm.setProp(vm.global, '__unknown', mark); mark.dispose();
  try {
    evaluate(`(() => {
      const values = new Map();
      globalThis.store = (key, value) => values.set(key, value);
      globalThis.load = key => values.get(key);
      globalThis.__clear = () => values.clear();
      const displayImage = () => {};
      globalThis.image = displayImage;
      globalThis.text = globalThis.generatedImage = () => {};
      const targets = new WeakMap();
      let enumeration = 0;
      const keys = Object.keys;
      Object.keys = value => { enumeration++; try { return keys(value); } finally { enumeration--; } };
      globalThis.__displayImage = (fn, value) => {
        if (fn === displayImage && targets.get(value)?.image_url?.__tesseraOmittedImage) return;
        return fn(value.image_url);
      };
      globalThis.__jobs = []; globalThis.__done = false; globalThis.__error = null;
      const partial = (value, complete = false) => { const proxy = new Proxy(value, {
        get(target, key) {
          if (key === 'then' || key === 'toJSON') return undefined;
          if (key in target || typeof key === 'symbol') {
            const result = Reflect.get(target, key);
            if (result?.__tesseraOmittedImage || result?.__tesseraImage || result?.__tesseraOmitted) { const reason = 'Image body access is unavailable during metadata replay'; __unknown(reason); throw Error(reason); }
            return result !== null && typeof result === 'object' ? partial(result) : result;
          }
          const reason = 'Unrecorded return field: ' + String(key); __unknown(reason); throw Error(reason);
        },
        has(target, key) {
          if (key in target) return true;
          if (complete) return false;
          const reason = 'Unrecorded return field membership: ' + String(key); __unknown(reason); throw Error(reason);
        },
        getOwnPropertyDescriptor(target, key) {
          if (target[key]?.__tesseraOmittedImage || target[key]?.__tesseraImage || target[key]?.__tesseraOmitted) {
            if (!enumeration) { const reason = 'Image body descriptor is unavailable during metadata replay'; __unknown(reason); throw Error(reason); }
            return { configurable: true, enumerable: true, value: undefined, writable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys(target) {
          if (complete) return Reflect.ownKeys(target);
          const reason = 'Unrecorded return field enumeration'; __unknown(reason); throw Error(reason);
        }
      }); targets.set(proxy, value); return proxy; };
      globalThis.tools = new Proxy({}, {get: (_, name) => args => {
        const reply = JSON.parse(__recordedTool(String(name), JSON.stringify(args)));
        if (reply.unknown) return Promise.reject(Error(reply.unknown));
        if (reply.pending) return new Promise((resolve, reject) => { __pending[reply.ordinal] = { resolve: (value, complete) => resolve(partial(value, complete)), reject }; });
        const recordedValue = reply.valueRef !== undefined ? __recordedValues[reply.valueRef] : reply.value;
        const value = reply.partial ? partial(recordedValue, __completeValues[reply.valueRef] === true) : recordedValue;
        if (reply.order !== undefined) return new Promise((resolve,reject) => __jobs.push({order:reply.order,run:()=> reply.rejection ? reject(reply.rejection) : resolve(value)}));
        if (reply.rejection) return Promise.reject(reply.rejection);
        return Promise.resolve(value);
      }});
    })();void 0;`);
    let cellCount = 0;
    for await (cell of cells) {
      cellCount++;
      unknown = undefined; captured = 0; commandCursor = 0; usedResults = new Set();
      deadline = performance.now() + cellTimeoutMs;
      if (typeof cell.source !== 'string' || cell.source.length > MAX_SOURCE) { evaluate('__clear();void 0;'); continue; }
      let source;
      try { source = displayOnlySource(cell.source); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Parsing precedes execution: none of this cell's store writes or tool
        // calls happened. Keep prior state and continue with a corrected retry.
        diagnostics.push({ callId: cell.id, unresolved: String(error) });
        if (!cell.closed) break;
        continue;
      }
      cell.texts = textBlocks(cell.output);
      cell.json = cell.texts.flatMap(t => { try { return [JSON.parse(t)]; } catch { return []; } });
      cell.commands = cell.json.filter(o => isObject(o) && typeof o.output === 'string' && ('exit_code' in o || 'session_id' in o));
      cell.images = Array.isArray(cell.output) ? cell.output.filter(b => b?.type === 'input_image' && b.image_url?.__tesseraImage) : [];
      cell.recordedFailure = cell.texts.find(t => t.startsWith('Script error:\n'))?.slice('Script error:\n'.length);
      deadline = performance.now() + cellTimeoutMs;
      try {
        const recordedValues = Object.fromEntries(cell.images.map((b, i) => [`view:${i}`, { image_url: { __tesseraOmittedImage: true }, detail: b.detail }]));
        const completeValues = {};
        for (const { item } of cell.events) if (item.kind === 'image_gen.generation' || item.type === 'imageGeneration') {
          recordedValues[`generation:${item.id}`] = {
            ...(item.result?.__tesseraImage ? { image_url: { __tesseraOmittedImage: true } } : {}),
            ...(recording.hints.has(item.id) ? { output_hint: recording.hints.get(item.id) } : {}),
          };
          const keys = recording.resultKeys.get(item.id);
          completeValues[`generation:${item.id}`] = !!keys && keys.length === Object.keys(recordedValues[`generation:${item.id}`]).length
            && keys.every(key => Object.hasOwn(recordedValues[`generation:${item.id}`], key));
        }
        evaluate(`__completeValues=${JSON.stringify(completeValues)};__recordedValues=${JSON.stringify(recordedValues)};__jobs=[];__pending={};__done=false;__error=null;void 0;`);
        evaluate(`(async()=>{${source}\n})().then(()=>__done=true,e=>{__done=true;__error=String(e)});void 0;`);
        for (;;) {
          while (runtime.hasPendingJob()) {
            const result = runtime.executePendingJobs();
            if (result.error) {
              let error; try { error = vm.dump(result.error); } finally { result.error.dispose(); }
              throw Error(error?.message ?? 'Replay interrupted');
            }
          }
          const currentCalls = invocations.filter(i => i.callId === cell.id);
          const queuedOrders = evaluate('__jobs.map(job=>job.order)');
          const ambiguous = currentCalls.filter(i => i.resultId
            && queuedOrders.includes(cell.events.find(e => e.item.id === i.resultId)?.offset)
            && currentCalls.some(other => other !== i && other.prompt === i.prompt
              && (!other.resultId || queuedOrders.includes(cell.events.find(e => e.item.id === other.resultId)?.offset))));
          if (ambiguous.length) {
            const blockedOrders = [];
            for (const invocation of ambiguous) {
              const event = cell.events.find(e => e.item.id === invocation.resultId);
              if (event) blockedOrders.push(event.offset);
              usedResults.delete(invocation.resultId);
              delete invocation.resultId;
              invocation.status = cell.closed ? 'error' : 'running';
              invocation.inputResolutionError = 'Repeated prompts cannot be uniquely associated with image results.';
            }
            unknown = 'Repeated prompts cannot be uniquely associated with image results.';
            evaluate(`__jobs=__jobs.filter(job=>!${JSON.stringify(blockedOrders)}.includes(job.order));void 0;`);
          }
          if (!evaluate('__jobs.length')) {
            // Wait until synchronous/parallel invocation discovery finishes before
            // applying the single-call/single-result rule. Never assign one result
            // to the first of several concurrent calls merely by arrival order.
            const calls = invocations.filter(i => i.callId === cell.id);
            const events = cell.events.filter(e => e.item.kind === 'image_gen.generation' || e.item.type === 'imageGeneration');
            if (calls.length === 1 && !calls[0].resultId && calls[0].status !== 'error' && events.length === 1 && !usedResults.has(events[0].item.id)) {
              const invocation = calls[0], event = events[0];
              usedResults.add(event.item.id);
              invocation.resultId = event.item.id;
              invocation.status = event.item.status === 'failed' || event.item.failure ? 'error' : 'completed';
              if (invocation.status === 'error') {
                invocation.error = typeof event.item.failure === 'string' ? event.item.failure : 'Image generation failed';
                evaluate(`__pending[0].reject(${JSON.stringify(invocation.error)});delete __pending[0];void 0;`);
              } else {
                evaluate(`__pending[0].resolve(__recordedValues[${JSON.stringify(`generation:${event.item.id}`)}],__completeValues[${JSON.stringify(`generation:${event.item.id}`)}]);delete __pending[0];void 0;`);
              }
              continue;
            }
            break;
          }
          evaluate('__jobs.sort((a,b)=>a.order-b.order).shift().run();void 0;');
        }
        const done = evaluate('__done'), error = evaluate('__error');
        diagnostics.push({ callId: cell.id, unresolved: unknown, error, done });
        // Unknown tool effects may invalidate old values. Never let later cells
        // use stale bindings after a replay divergence.
        if (unknown || (!done && cell.closed) || (error && !cell.recordedFailure)) evaluate('__clear();void 0;');
        // A closed ambiguous cell must not suppress independent later calls.
        if (!done && cell.closed) {
          for (const invocation of invocations.filter(i => i.callId === cell.id && !i.resultId)) { invocation.status = 'error'; invocation.inputResolutionError = 'Image result association is absent from the recording.'; }
        }
        if (!cell.closed) break;
      } catch (error) {
        diagnostics.push({ callId: cell.id, unresolved: String(error) });
        // CPU/heap exhaustion invalidates the whole isolate; do not continue it.
        break;
      }
    }
    return { invocations, diagnostics, cells: cellCount };
  } finally { runtime.setInterruptHandler(() => false); vm.dispose(); runtime.dispose(); }
}

module.exports = { Recording, ReplaySession, replayCells, imageArguments };
