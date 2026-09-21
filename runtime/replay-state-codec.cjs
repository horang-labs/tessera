'use strict';

// Evaluated inside QuickJS only. Media bodies are already omitted by the reader.
const BOOTSTRAP = String.raw`
globalThis.__installReplayStateCodec = ({ unwrap, wrap }) => {
  const NativeMap = Map, NativeSet = Set, NativeDate = Date, NativeArray = Array;
  const NativeError = Error, nativeString = String, nativeNumber = Number, nativeBigInt = BigInt;
  const stringify = JSON.stringify, parse = JSON.parse;
  const create = Object.create, define = Object.defineProperty, is = Object.is;
  const finite = Number.isFinite, isArray = Array.isArray;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const mapPrototype = Map.prototype, setPrototype = Set.prototype, datePrototype = Date.prototype;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const mapSet = Map.prototype.set, mapGet = Map.prototype.get, mapHas = Map.prototype.has, mapClear = Map.prototype.clear;
  const setAdd = Set.prototype.add;
  let values = new NativeMap();
  const fail = message => { throw NativeError('Replay state unavailable: ' + message); };
  const own = Object.getOwnPropertyDescriptors;
  const keys = Reflect.ownKeys;
  const proto = Object.getPrototypeOf;
  const mapEntries = Map.prototype.entries;
  const setValues = Set.prototype.values;
  const dateTime = Date.prototype.getTime;
  const encode = root => {
    const nodes = [], seen = new NativeMap();
    const value = item => {
      if (item === undefined) return { t: 'u' };
      if (typeof item === 'bigint') return { t: 'b', v: nativeString(item) };
      if (typeof item === 'number' && (!finite(item) || is(item, -0))) return { t: 'n', v: is(item, -0) ? '-0' : nativeString(item) };
      if (item === null || ['string', 'boolean', 'number'].includes(typeof item)) return item;
      if (typeof item !== 'object') return fail('unsupported ' + typeof item);
      if (call(mapHas, seen, item)) return { r: call(mapGet, seen, item) };
      const id = nodes.length;
      call(mapSet, seen, item, id); nodes.push(null);
      const partial = unwrap(item);
      if (partial) {
        nodes[id] = { t: 'p', raw: value(partial.raw), complete: partial.complete === true };
      } else {
        const prototype = proto(item);
        const descriptors = own(item);
        for (const key of keys(descriptors)) {
          if (typeof key !== 'string') return fail('symbol property');
          if (!('value' in descriptors[key])) return fail('accessor property');
        }
        const properties = skip => keys(descriptors).filter(key => key !== skip).map(key => {
          const d = descriptors[key];
          return [key, value(d.value), d.enumerable, d.writable, d.configurable];
        });
        if (isArray(item) && prototype === arrayPrototype) nodes[id] = { t: 'a', length: descriptors.length.value, props: properties('length') };
        else if (prototype === objectPrototype || prototype === null) nodes[id] = { t: 'o', nil: prototype === null, props: properties() };
        else if (prototype === mapPrototype) {
          if (keys(descriptors).length) return fail('custom Map properties');
          nodes[id] = { t: 'm', entries: NativeArray.from(call(mapEntries, item), pair => pair.map(value)) };
        } else if (prototype === setPrototype) {
          if (keys(descriptors).length) return fail('custom Set properties');
          nodes[id] = { t: 's', entries: NativeArray.from(call(setValues, item), value) };
        } else if (prototype === datePrototype) {
          if (keys(descriptors).length) return fail('custom Date properties');
          nodes[id] = { t: 'd', time: value(call(dateTime, item)) };
        } else return fail('unsupported object prototype');
      }
      return { r: id };
    };
    const encoded = value(root);
    return stringify({ root: encoded, nodes });
  };
  const decode = serialized => {
    const graph = parse(serialized), objects = [];
    const value = item => {
      if (item === null || typeof item !== 'object') return item;
      if ('r' in item) return objects[item.r];
      if (item.t === 'u') return undefined;
      if (item.t === 'b') return nativeBigInt(item.v);
      if (item.t === 'n') return item.v === '-0' ? -0 : nativeNumber(item.v);
      return fail('invalid primitive');
    };
    for (const node of graph.nodes) {
      objects.push(node.t === 'a' ? new NativeArray(node.length) : node.t === 'o' ? create(node.nil ? null : objectPrototype)
        : node.t === 'm' ? new NativeMap() : node.t === 's' ? new NativeSet() : node.t === 'd' ? new NativeDate(value(node.time)) : undefined);
    }
    // Partial proxies point to ordinary metadata objects, allocated above. Wrap
    // before filling their fields so cycles back to the proxy retain identity.
    graph.nodes.forEach((node, index) => {
      if (node.t === 'p') {
        const raw = value(node.raw);
        if (raw === null || typeof raw !== 'object') return fail('invalid partial target');
        objects[index] = wrap(raw, node.complete);
      }
    });
    graph.nodes.forEach((node, index) => {
      const target = objects[index];
      if (node.t === 'a' || node.t === 'o') for (const [key, encoded, enumerable, writable, configurable] of node.props) {
        define(target, key, { value: value(encoded), enumerable, writable, configurable });
      }
      else if (node.t === 'm') for (const [key, encoded] of node.entries) call(mapSet, target, value(key), value(encoded));
      else if (node.t === 's') for (const encoded of node.entries) call(setAdd, target, value(encoded));
    });
    return value(graph.root);
  };
  globalThis.store = (key, value) => {
    if (typeof key !== 'string') return fail('store key must be a string');
    call(mapSet, values, key, value);
  };
  globalThis.load = key => call(mapGet, values, key);
  globalThis.__clear = () => call(mapClear, values);
  globalThis.__exportState = () => encode(values);
  globalThis.__importState = serialized => { values = decode(serialized); };
};
`;

module.exports = { BOOTSTRAP };
