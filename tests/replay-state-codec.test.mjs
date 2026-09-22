import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { getQuickJS } = require('quickjs-emscripten');
const { BOOTSTRAP } = require('../runtime/replay-state-codec.cjs');

async function context() {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  const vm = runtime.newContext();
  const evaluate = source => {
    const result = vm.evalCode(source);
    const handle = result.error ?? result.value;
    try {
      const value = vm.dump(handle);
      if (result.error) throw Error(value.message);
      return value;
    } finally { handle.dispose(); }
  };
  evaluate(BOOTSTRAP + `
    const partials = new WeakMap();
    globalThis.wrap = (raw, complete) => {
      const proxy = new Proxy(raw, { get(target, key) {
        if (key === 'image_url') throw Error('image body unavailable');
        return target[key];
      }});
      partials.set(proxy, {raw, complete});
      return proxy;
    };
    __installReplayStateCodec({unwrap: value => partials.get(value), wrap});
    void 0;
  `);
  return { evaluate, close: () => { vm.dispose(); runtime.dispose(); } };
}

test('state survives a fresh context with graph identity, cycles and metadata values', async () => {
  const first = await context(), second = await context();
  try {
    first.evaluate(`
      const root = Object.create(null);
      root.self = root;
      root.array = [undefined, 12n, NaN, Infinity, -Infinity, -0];
      root.map = new Map([[root, new Set([root])]]);
      root.date = new Date('2026-09-21T00:00:00Z');
      root.invalidDate = new Date(NaN);
      root.sparse = new Array(4); root.sparse[2] = root;
      Object.defineProperty(root, 'hidden', {value: 'secret', enumerable: false});
      store('root', root); store('alias', root); globalThis.leaked = 'wrong';
      void 0;
    `);
    const encoded = first.evaluate('__exportState()');
    second.evaluate(`__importState(${JSON.stringify(encoded)});void 0;`);
    assert.equal(second.evaluate(`(() => {
      const r = load('root');
      return r === r.self && r === load('alias') && Object.getPrototypeOf(r) === null
        && r.array[0] === undefined && r.array[1] === 12n && Number.isNaN(r.array[2])
        && r.array[3] === Infinity && r.array[4] === -Infinity && Object.is(r.array[5], -0)
        && r.map.get(r).has(r) && r.date.toISOString() === '2026-09-21T00:00:00.000Z'
        && Number.isNaN(r.invalidDate.getTime()) && r.sparse.length === 4
        && !(0 in r.sparse) && r.sparse[2] === r && r.hidden === 'secret'
        && !Object.keys(r).includes('hidden') && typeof leaked === 'undefined';
    })()`), true);
  } finally { first.close(); second.close(); }
});

test('partial result metadata round trips without reading omitted image bodies', async () => {
  const first = await context(), second = await context();
  try {
    first.evaluate(`
      const raw = {image_url: {__tesseraOmittedImage:true}, output_hint:'/a.png'};
      const proxy = wrap(raw, true); raw.self = proxy;
      store('partial', proxy); store('raw', raw); void 0;
    `);
    const encoded = first.evaluate('__exportState()');
    second.evaluate(`__importState(${JSON.stringify(encoded)});void 0;`);
    assert.equal(second.evaluate(`load('partial').output_hint`), '/a.png');
    assert.equal(second.evaluate(`load('partial').self === load('partial') && load('raw').self === load('partial')`), true);
    assert.throws(() => second.evaluate(`load('partial').image_url`), /image body unavailable/);
    assert.equal(second.evaluate(`__exportState()`), encoded);
  } finally { first.close(); second.close(); }
});

test('functions, accessors, symbols and unsupported types fail without invoking getters', async () => {
  const instance = await context();
  try {
    for (const expression of ['()=>{}', '/regexp/', 'Symbol("unknown")', 'Object.create({custom:true})']) {
      instance.evaluate(`__clear();store('bad', ${expression});void 0;`);
      assert.throws(() => instance.evaluate('__exportState()'), /Replay state unavailable/);
    }
    instance.evaluate(`__clear();globalThis.reads=0;store('bad',{get value(){reads++;return '/fabricated.png'}});void 0;`);
    assert.throws(() => instance.evaluate('__exportState()'), /accessor property/);
    assert.equal(instance.evaluate('reads'), 0);
    instance.evaluate(`__clear();store('bad',{[Symbol('key')]:'value'});void 0;`);
    assert.throws(() => instance.evaluate('__exportState()'), /symbol property/);
  } finally { instance.close(); }
});

test('common global and Map method overrides cannot forge exported state', async () => {
  const first = await context(), second = await context();
  try {
    first.evaluate(`
      store('ref', '/correct.png');
      JSON.stringify = () => 'forged';
      Object.getOwnPropertyDescriptors = () => ({});
      Map.prototype.get = () => '/wrong.png';
      Map.prototype.set = () => {};
      globalThis.String = () => 'wrong';
      store('next', 123n); void 0;
    `);
    const encoded = first.evaluate('__exportState()');
    second.evaluate(`__importState(${JSON.stringify(encoded)});void 0;`);
    assert.equal(second.evaluate('load("ref")'), '/correct.png');
    assert.equal(second.evaluate('load("next") === 123n'), true);
  } finally { first.close(); second.close(); }
});
