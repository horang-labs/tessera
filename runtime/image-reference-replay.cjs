'use strict';

// This module runs only in the replay worker. Transcript code never runs in Node.
const { getQuickJS } = require('quickjs-emscripten');
const { parse } = require('acorn');
const { BOOTSTRAP: STATE_CODEC } = require('./replay-state-codec.cjs');
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

// Calls overlap when a yielded exec is still alive while another exec starts.
// Shared-state ordering cannot be inferred by running each whole cell in turn.
function mayUseSharedState(source) {
  try {
    const visit = node => {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'ThisExpression' || node.type === 'Identifier' && ['store', 'load', 'eval', 'Function', 'globalThis'].includes(node.name)) return true;
      return Object.values(node).some(value => Array.isArray(value) ? value.some(visit) : visit(value));
    };
    return visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  } catch { return true; }
}

class Recording {
  constructor() {
    this.cells = []; this.active = new Map(); this.yielded = new Map(); this.hints = new Map(); this.resultKeys = new Map(); this.offset = 0;
    this.images = []; this.generation = 0; this.metadataBytes = 0; this.retainedBytes = 0;
    this.unownedEvents = new Map();
    this.incompleteTurns = new Set();
  }
  omitRecord(reason, offset, timestamp = '') {
    if (this.cells.length >= MAX_CELLS) throw Error('Replay cell limit exceeded');
    this.cells.push({ id: `omitted-${offset}`, omitted: reason, timestamp, offset, events: [], closed: true });
    this.incompleteTurns.add(this.turnId ?? '');
    // The omitted record may have changed state or introduced a newer image.
    this.images = [];
    for (const cell of new Set([...this.active.values(), ...this.yielded.values()])) cell.stateOverlap = true;
    this.generation++;
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
    if (record.__tesseraOmittedRecord) { this.omitRecord(record.__tesseraOmittedRecord, offset); return; }
    const p = record.payload;
    if (!isObject(p)) return;
    if ((record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'task_started'))
      && typeof p.turn_id === 'string') this.turnId = p.turn_id;
    const timestamp = record.timestamp ?? '';
    const retain = (extraBytes = 0) => {
      this.retainedBytes += Buffer.byteLength(JSON.stringify(record)) + extraBytes;
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
      if (typeof p.input !== 'string') { this.omitRecord('Recorded JavaScript source is unavailable', offset, timestamp); return; }
      if (this.cells.length >= MAX_CELLS) throw Error('Replay cell limit exceeded');
      this.metadataBytes += Buffer.byteLength(p.input ?? '');
      if (this.metadataBytes > 16 * 1024 * 1024) throw Error('Replay source limit exceeded');
      retain();
      const cell = { id: p.call_id, source: p.input, timestamp, offset, events: [], output: undefined, closed: false, recent: this.images.slice(-5) };
      cell.turnId = this.turnId;
      cell.mayUseState = mayUseSharedState(p.input);
      for (const other of new Set([...this.active.values(), ...this.yielded.values()])) {
        if (cell.mayUseState && other.mayUseState) cell.stateOverlap = other.stateOverlap = true;
      }
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
        cell.terminated = textBlocks(p.output).some(t => /^Script terminated|^aborted by user/.test(t));
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
              // A returned result ID identifies its exec even while other
              // yielded execs are still alive. Never assign by arrival order.
              if (cell && this.unownedEvents.has(id)) {
                cell.events.push(this.unownedEvents.get(id));
                this.unownedEvents.delete(id);
              }
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
      const active = new Set([...this.active.values(), ...this.yielded.values()].filter(cell =>
        !p.turn_id || !cell.turnId || cell.turnId === p.turn_id));
      const completeScope = !this.incompleteTurns.has(p.turn_id ?? this.turnId ?? '');
      if (active.size === 1 && completeScope) { retain(); active.values().next().value.events.push({ item, offset }); }
      else if (generation && typeof item.id === 'string' && !this.unownedEvents.has(item.id)) {
        // Preserve the eligible execs AT THIS EVENT, not whichever exec happens
        // to be current when replay ends. Turn changes and later invocations
        // must not turn a matching prompt into false ownership evidence.
        const scope = {
          candidateCallIds: [...active].map(cell => cell.id),
          knownTurn: completeScope && typeof p.turn_id === 'string' && [...active].every(cell => cell.turnId === p.turn_id),
        };
        retain(Buffer.byteLength(JSON.stringify(scope)));
        this.unownedEvents.set(item.id, { item, offset, ...scope });
      }
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

// Read bounded windows and release each completed prefix after replay. Only the
// bounded store snapshot crosses cell boundaries, never their source or globals.
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
    recording.retainedBytes = Buffer.byteLength(JSON.stringify([recording.cells, [...recording.unownedEvents.values()]]));
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

/** Repair captured arguments, without executing an unrecorded continuation.
 * A yielded exec can outlive ALL its image calls. Exec liveness only bounds the
 * candidates; unique pending image invocations establish the final association.
 * Require a one-to-one exact match in both directions before changing anything.
 */
function resolvePendingImages(recording, invocations, bounds, opaqueCalls) {
  const assigned = new Set(invocations.map(i => i.resultId).filter(Boolean));
  const pending = new Map();
  for (const invocation of invocations) {
    if (invocation.resultId) continue;
    const group = pending.get(invocation.prompt) ?? [];
    group.push(invocation); pending.set(invocation.prompt, group);
  }
  const byInvocation = new Map(), matches = [];
  for (const event of recording.unownedEvents.values()) {
    if (!event.knownTurn || assigned.has(event.item.id)
      || event.candidateCallIds.some(id => opaqueCalls.has(id))) continue;
    const scope = new Set(event.candidateCallIds);
    const candidates = (pending.get(event.item.revisedPrompt) ?? []).filter(invocation =>
      scope.has(invocation.callId) && bounds.get(invocation) <= event.offset);
    for (const invocation of candidates) byInvocation.set(invocation, (byInvocation.get(invocation) ?? 0) + 1);
    // Ambiguous edges still block every involved invocation, but retaining their
    // complete cross product would defeat the metadata memory bound.
    if (candidates.length === 1) matches.push({ event, invocation: candidates[0] });
  }
  for (const { event, invocation } of matches) {
    if (byInvocation.get(invocation) !== 1) continue;
    invocation.resultId = event.item.id;
    invocation.status = event.item.status === 'failed' || event.item.failure ? 'error' : 'completed';
    delete invocation.error;
    if (invocation.status === 'error') invocation.error = typeof event.item.failure === 'string'
      ? event.item.failure : 'Image generation failed';
    delete invocation.inputResolutionError;
  }
}

async function replayCells(recording, { cells = recording.cells, ...options } = {}) {
  const invocations = [], diagnostics = [];
  const invocationBounds = new WeakMap();
  const opaqueCalls = new Set();
  let state, count = 0, stateComplete = true;
  for await (const cell of cells) {
    let result;
    try {
      result = cell.omitted
        ? { invocations: [], diagnostics: [{ callId: cell.id, unresolved: `Recorded metadata unavailable: ${cell.omitted}` }], stateInvalid: true }
        : await replayCell(recording, cell, { ...options, state, stateComplete, invocationBounds });
    }
    catch (error) {
      result = { invocations: [], diagnostics: [{ callId: cell.id, unresolved: String(error) }], stateInvalid: true };
    }
    count++;
    state = result.state;
    // Failure before reaching any image call is not evidence that this exec
    // had none. Do not let its missing candidates manufacture uniqueness.
    if (result.stateInvalid && !result.invocations.length) opaqueCalls.add(cell.id);
    if (result.stateInvalid || !cell.closed) stateComplete = false;
    invocations.push(...result.invocations);
    const resultIds = cell.events.filter(e => e.item.kind === 'image_gen.generation' || e.item.type === 'imageGeneration').map(e => e.item.id);
    diagnostics.push(...result.diagnostics.map(d => ({ ...d, resultIds })));
    // A missing terminal output is local to this exec. Later independent calls
    // still have useful evidence, but cannot inherit an unfinished snapshot.
    if (!cell.closed) state = undefined;
  }
  resolvePendingImages(recording, invocations, invocationBounds, opaqueCalls);
  return { invocations, diagnostics, cells: count };
}

async function replayCell(recording, currentCell, { cellTimeoutMs = 2000, memoryLimitBytes = MAX_STATE, state, stateComplete, invocationBounds } = {}) {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime(); runtime.setMemoryLimit(memoryLimitBytes); runtime.setMaxStackSize(512 * 1024);
  let deadline = performance.now() + cellTimeoutMs;
  let exited = false, stateAtExit;
  runtime.setInterruptHandler(() => exited || performance.now() > deadline);
  const vm = runtime.newContext();
  const invocations = [], diagnostics = [];
  let cell, unknown, captured, commandCursor, usedResults;
  let completedOffset = currentCell.offset;
  let stateInvalid = false;
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
      if (exited) return vm.newString(JSON.stringify({ unknown: 'Execution already exited' }));
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
          invocationBounds.set(invocation, completedOffset);
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
          reply = { order: viewEvents[index].offset, valueRef: `view:${index}`, partial: true };
        } else reply = cell.recordedFailure ? { rejection: cell.recordedFailure } : unknownValue('Image view return is absent or does not match the requested path');
      } else if (name === 'exec_command' || name === 'write_stdin') {
        const commandEvents = cell.events.filter(e => e.item.type === 'CommandExecution');
        const matches = commandEvents.filter(e => e.item.command?.at(-1) === args.cmd);
        if (name === 'exec_command' && matches.length === 1) {
          const item = matches[0].item;
          const output = item.formatted_output ?? item.aggregated_output;
          const observed = cell.commands.filter(c => c.output === output);
          if (observed.length === 1) reply = { order: matches[0].offset, value: observed[0], partial: true };
          else if (commandEvents.length === 1 && cell.commands.length === 1) reply = { order: matches[0].offset, value: cell.commands[0], partial: true };
          else if (typeof output === 'string') reply = { order: matches[0].offset, value: { output, exit_code: item.exit_code }, partial: true };
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
  const exitNative = vm.newFunction('__requestExit', encoded => {
    stateAtExit = vm.getString(encoded);
    if (Buffer.byteLength(stateAtExit) > 8 * 1024 * 1024) throw Error('Replay stored state memory limit exceeded');
    exited = true; return vm.undefined;
  });
  vm.setProp(vm.global, '__requestExit', exitNative); exitNative.dispose();
  const yieldNative = vm.newFunction('__canResumeYield', () => {
    const remaining = cell.events.some(e => (e.item.kind === 'image_gen.generation' || e.item.type === 'imageGeneration') && !usedResults.has(e.item.id));
    return !cell.terminated || remaining ? vm.true : vm.false;
  });
  vm.setProp(vm.global, '__canResumeYield', yieldNative); yieldNative.dispose();
  const checkState = vm.newFunction('__checkStateOrder', () => {
    if (cell.stateOverlap) {
      unknown = 'Concurrent execution state ordering is unavailable';
      return vm.newString(unknown);
    }
    return vm.undefined;
  });
  vm.setProp(vm.global, '__checkStateOrder', checkState); checkState.dispose();
  try {
    evaluate(STATE_CODEC);
    evaluate(`(() => {
      const displayImage = () => {};
      globalThis.image = displayImage;
      globalThis.text = globalThis.generatedImage = globalThis.audio = globalThis.notify = () => {};
      globalThis.yield_control = () => __canResumeYield() ? Promise.resolve() : new Promise(() => {});
      globalThis.exit = () => { __requestExit(__exportState()); throw Error('Replay exit'); };
      Object.defineProperty(globalThis, 'ALL_TOOLS', { get() {
        const reason = 'Historical tool catalog is absent from the recording'; __unknown(reason); throw Error(reason);
      }});
      let timerId = 0, clock = 0;
      const timers = new Map();
      globalThis.setTimeout = (fn, delay = 0) => {
        if (typeof fn !== 'function') throw TypeError('Timer callback must be a function');
        const id = ++timerId;
        timers.set(id, { at: clock + Math.max(0, Number(delay) || 0), fn });
        return id;
      };
      globalThis.clearTimeout = id => { timers.delete(id); };
      globalThis.__timerCount = () => timers.size;
      globalThis.__runTimer = () => {
        const [id, timer] = [...timers].sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
        timers.delete(id); clock = timer.at; timer.fn();
      };
      const targets = new WeakMap();
      let enumeration = 0;
      const keys = Object.keys;
      Object.keys = value => { enumeration++; try { return keys(value); } finally { enumeration--; } };
      globalThis.__displayImage = (fn, value) => {
        if (fn === displayImage && targets.get(value)?.raw.image_url?.__tesseraOmittedImage) return;
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
      }); targets.set(proxy, { raw: value, complete }); return proxy; };
      __installReplayStateCodec({ unwrap: value => targets.get(value), wrap: partial });
      const unrecordedValue = () => {
        const reason = 'Historical clock or random value is absent from the recording'; __unknown(reason); throw Error(reason);
      };
      Math.random = unrecordedValue;
      Date = new Proxy(Date, {
        apply: unrecordedValue,
        construct: (target, args) => args.length ? Reflect.construct(target, args) : unrecordedValue(),
        get: (target, key) => key === 'now' ? unrecordedValue : Reflect.get(target, key),
      });
      const loadState = load, hasStateKey = __hasStateKey;
      globalThis.load = key => {
        const reason = __checkStateOrder(); if (reason) throw Error(reason);
        if (!${stateComplete === true} && !hasStateKey(key)) {
          const missing = 'Replay state unavailable: earlier execution could not be reconstructed';
          __unknown(missing); throw Error(missing);
        }
        return loadState(key);
      };
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
    for (cell of [currentCell]) {
      cellCount++;
      unknown = undefined; captured = 0; commandCursor = 0; usedResults = new Set();
      if (state) evaluate(`__importState(${JSON.stringify(state)});void 0;`);
      deadline = performance.now() + cellTimeoutMs;
      if (typeof cell.source !== 'string' || cell.source.length > MAX_SOURCE) {
        state = undefined; stateInvalid = true;
        diagnostics.push({ callId: cell.id, unresolved: 'Recorded JavaScript source exceeds replay limit or is unavailable' });
        continue;
      }
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
          if (exited) throw Error('Replay exit');
          while (runtime.hasPendingJob() && !evaluate('__done')) {
            const result = runtime.executePendingJobs(1);
            if (result.error) {
              let error; try { error = vm.dump(result.error); } finally { result.error.dispose(); }
              throw Error(error?.message ?? 'Replay interrupted');
            }
          }
          if (exited) throw Error('Replay exit');
          if (evaluate('__done')) break;
          const timers = evaluate('__timerCount()');
          if (timers && (evaluate('__jobs.length') || Object.keys(evaluate('__pending')).length)) {
            unknown = 'Timer and recorded tool completion ordering is unavailable'; break;
          }
          if (timers) { evaluate('__runTimer();void 0;'); continue; }
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
              completedOffset = Math.max(completedOffset, event.offset);
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
          completedOffset = Math.max(completedOffset, evaluate('__jobs.sort((a,b)=>a.order-b.order)[0].order'));
          evaluate('__jobs.shift().run();void 0;');
        }
        const done = evaluate('__done'), error = evaluate('__error');
        const termination = !done && cell.terminated ? 'Execution was terminated before the remaining calls completed' : undefined;
        diagnostics.push({ callId: cell.id, unresolved: unknown ?? termination, error, done });
        // Unknown tool effects may invalidate old values. Never let later cells
        // use stale bindings after a replay divergence.
        if (unknown || (!done && cell.closed && !cell.terminated) || (error && !cell.recordedFailure)) {
          evaluate('__clear();void 0;'); stateInvalid = true;
        }
        // A closed ambiguous cell must not suppress independent later calls.
        if (!done && cell.closed) {
          for (const invocation of invocations.filter(i => i.callId === cell.id && !i.resultId)) { invocation.status = 'error'; invocation.inputResolutionError = 'Image result association is absent from the recording.'; }
        }
        state = evaluate('__exportState()');
        if (Buffer.byteLength(state) > 8 * 1024 * 1024) throw Error('Replay stored state memory limit exceeded');
        if (cell.stateOverlap) { state = undefined; stateInvalid = true; }
        if (!cell.closed) break;
      } catch (error) {
        diagnostics.length = 0;
        if (exited) {
          stateInvalid ||= cell.stateOverlap || Boolean(unknown);
          state = stateInvalid ? undefined : stateAtExit;
          diagnostics.push({ callId: cell.id, done: true }); break;
        }
        state = undefined; stateInvalid = true;
        diagnostics.push({ callId: cell.id, unresolved: String(error) });
        // Dispose this exhausted isolate. The coordinator creates a fresh one
        // for the next cell, including after CPU and heap limit failures.
        break;
      }
    }
    return { invocations, diagnostics, cells: cellCount, state, stateInvalid };
  } finally { runtime.setInterruptHandler(() => false); vm.dispose(); runtime.dispose(); }
}

module.exports = { Recording, ReplaySession, replayCells, imageArguments };
