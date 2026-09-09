import { parse, type Expression, type Node, type Pattern } from 'acorn';
import { parseImageGenerationInvocations, type ImageGenerationInvocation } from './traces';

type Value = string | number | null | Value[];
export interface ImageReferenceBindings { stored: Array<[string, Value]> }
const MAX_SOURCE = 128 * 1024;
const MAX_VALUE = 16 * 1024;
const MAX_BINDINGS = 64;

function isReferenceValue(value: Value): boolean {
  if (Array.isArray(value)) return value.every(isReferenceValue);
  if (typeof value !== 'string') return true;
  // Persist path data only. Other exec stores can contain image base64, shell
  // output or entire documents and must not become long-lived image state.
  return !/[\r\n\0]/.test(value) && !/^[A-Za-z0-9+/=]{256,}$/.test(value)
    && (/^(?:\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|file:\/\/)/.test(value)
      || /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(value));
}

/** Interpret only data expressions, never execute transcript JavaScript. Locals
 * belong to one exec cell; only store/load bindings survive the byte checkpoint. */
export function parseImageReferenceScript(source: string, bindings: ImageReferenceBindings): ImageGenerationInvocation[] {
  const stored = new Map(bindings.stored);
  const locals = new Map<string, Value>();
  const calls: ImageGenerationInvocation[] = [];
  const forget = () => { locals.clear(); stored.clear(); };
  const put = (map: Map<string, Value>, key: string, value: Value | undefined) => {
    map.delete(key);
    if (value !== undefined && key.length <= 256 && JSON.stringify(value).length <= MAX_VALUE) {
      if (map.size >= MAX_BINDINGS) map.delete(map.keys().next().value!);
      map.set(key, structuredClone(value));
    }
  };
  const text = (node: Node) => source.slice(node.start, node.end);
  const isTool = (node: Node) => /^tools\.[A-Za-z_$][\w$]*$/.test(text(node));

  // Unsupported control flow may overwrite bindings. Invalidate affected data
  // rather than treating a conditional write as an unconditional assignment.
  function invalidate(node: Node): void {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') forget();
    if (node.type === 'VariableDeclaration') locals.clear();
    if (node.type === 'CallExpression') {
      const call = node as Extract<Expression, { type: 'CallExpression' }>;
      if (text(call.callee) === 'store' || (!isTool(call.callee)
        && !['load', 'image', 'text', 'generatedImage'].includes(text(call.callee)))) forget();
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') invalidate(child);
      } else if (value && typeof value === 'object' && 'type' in value) invalidate(value as Node);
    }
  }

  function evaluate(node: Expression | undefined | null, depth = 0): Value | undefined {
    if (!node || depth > 32) return undefined;
    const read = (expression: Expression) => evaluate(expression, depth + 1);
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' || typeof node.value === 'number' || node.value === null
          ? node.value : undefined;
      case 'Identifier': return locals.get(node.name);
      case 'ArrayExpression': {
        if (node.elements.length > 64) return undefined;
        const values: Value[] = [];
        let known = true;
        for (const item of node.elements) {
          if (!item) { known = false; continue; }
          const value = read(item.type === 'SpreadElement' ? item.argument : item);
          if (value === undefined) { known = false; continue; }
          if (item.type === 'SpreadElement') {
            if (!Array.isArray(value)) known = false;
            else values.push(...value);
          } else values.push(value);
          if (values.length > 64 || JSON.stringify(values).length > MAX_VALUE) return undefined;
        }
        return known ? values : undefined;
      }
      case 'ObjectExpression':
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') read(property.argument);
          else {
            if (property.computed) read(property.key as Expression);
            if (property.kind === 'init') read(property.value as Expression);
          }
        }
        return undefined;
      case 'TemplateLiteral': {
        let value = node.quasis[0].value.cooked ?? '';
        for (let index = 0; index < node.expressions.length; index++) {
          const part = read(node.expressions[index]);
          if (typeof part !== 'string' && typeof part !== 'number') return undefined;
          value += String(part) + (node.quasis[index + 1].value.cooked ?? '');
          if (value.length > MAX_VALUE) return undefined;
        }
        return value;
      }
      case 'BinaryExpression': {
        const left = read(node.left as Expression), right = read(node.right);
        if (node.operator !== '+' || typeof left !== 'string' || typeof right !== 'string') return undefined;
        return left.length + right.length <= MAX_VALUE ? left + right : undefined;
      }
      case 'MemberExpression': {
        const object = read(node.object as Expression);
        const index = node.computed ? read(node.property as Expression) : undefined;
        return Array.isArray(object) && typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
          ? object[index] : undefined;
      }
      case 'AwaitExpression': return read(node.argument);
      case 'SequenceExpression': {
        let value: Value | undefined;
        for (const expression of node.expressions) value = read(expression);
        return value;
      }
      case 'AssignmentExpression': {
        const value = read(node.right);
        if (node.left.type === 'Identifier') put(locals, node.left.name, node.operator === '=' ? value : undefined);
        else forget(); // Includes mutations through array aliases and load() values.
        return node.operator === '=' ? value : undefined;
      }
      case 'CallExpression': {
        const name = text(node.callee);
        if (node.callee.type === 'MemberExpression') {
          read(node.callee.object as Expression);
          if (node.callee.computed) read(node.callee.property as Expression);
        }
        if (name === 'tools.image_gen__imagegen') {
          const [invocation] = parseImageGenerationInvocations(text(node));
          if (!invocation) return undefined;
          const object = node.arguments[0];
          if (object?.type === 'ObjectExpression') {
            const patches: Array<{ start: number; end: number; value: string }> = [];
            const keys = new Set<string>();
            let ambiguous = false;
            for (const property of object.properties) {
              if (property.type !== 'Property' || property.computed || property.kind !== 'init') continue;
              const key = property.key.type === 'Identifier' ? property.key.name
                : property.key.type === 'Literal' ? property.key.value : undefined;
              const value = read(property.value as Expression);
              if (!['referenced_image_paths', 'num_last_images_to_include', 'prompt'].includes(String(key))) continue;
              if (keys.has(String(key))) ambiguous = true;
              keys.add(String(key));
              if (value !== undefined) patches.push({ start: property.start - node.start, end: property.end - node.start,
                value: `${JSON.stringify(key)}:${JSON.stringify(value)}` });
            }
            let rewritten = text(node);
            for (const patch of patches.reverse()) rewritten = rewritten.slice(0, patch.start) + patch.value + rewritten.slice(patch.end);
            const resolved = parseImageGenerationInvocations(rewritten)[0];
            // Spread/computed properties can override an otherwise literal reference.
            if (ambiguous || object.properties.some((property) => property.type !== 'Property' || property.computed || property.kind !== 'init')) {
              resolved.referencesUnresolved = true;
            }
            calls.push(resolved);
          } else calls.push(invocation);
          return undefined;
        }
        if (name === 'load' && node.arguments.length === 1 && node.arguments[0].type !== 'SpreadElement') {
          const key = read(node.arguments[0]);
          return typeof key === 'string' ? structuredClone(stored.get(key)) : undefined;
        }
        if (name === 'store' && node.arguments.length === 2 && node.arguments.every((argument) => argument.type !== 'SpreadElement')) {
          const key = read(node.arguments[0] as Expression), value = read(node.arguments[1] as Expression);
          if (typeof key === 'string') put(stored, key, value !== undefined && isReferenceValue(value) ? value : undefined);
          else stored.clear();
          return undefined;
        }
        // JS evaluates arguments before calling a wrapper, including Promise.all.
        for (const argument of node.arguments) read(argument.type === 'SpreadElement' ? argument.argument : argument);
        if (!isTool(node.callee) && !['image', 'text', 'generatedImage', 'Promise.all', 'Promise.allSettled'].includes(name)) forget();
        return undefined;
      }
      default: invalidate(node); return undefined;
    }
  }

  try {
    if (source.length > MAX_SOURCE) throw new Error('Reference script too large');
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    // A shadowed helper is user code, not the exec runtime's store/load API.
    const reserved = new Set(['store', 'load', 'tools', 'Promise', 'image', 'text', 'generatedImage']);
    function bindsHelper(node: Pattern): boolean {
      switch (node.type) {
        case 'Identifier': return reserved.has(node.name);
        case 'ObjectPattern': return node.properties.some((property) => bindsHelper(
          property.type === 'RestElement' ? property.argument : property.value as Pattern));
        case 'ArrayPattern': return node.elements.some((element) => element && bindsHelper(element));
        case 'RestElement': return bindsHelper(node.argument);
        case 'AssignmentPattern': return bindsHelper(node.left);
        case 'MemberExpression': return bindsHelper(node.object as Pattern);
        default: return false;
      }
    }
    function hasShadow(node: Node): boolean {
      if (node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration'
        || node.type === 'ClassDeclaration' || node.type === 'AssignmentExpression') {
        const target = (node as Node & { id?: Node; left?: Node }).id ?? (node as Node & { left?: Node }).left;
        if (target && bindsHelper(target as Pattern)) return true;
      }
      return Object.values(node).some((value) => Array.isArray(value)
        ? value.some((child) => child && typeof child.type === 'string' && hasShadow(child))
        : value && typeof value === 'object' && 'type' in value && hasShadow(value as Node));
    }
    if (hasShadow(program)) throw new Error('Reference helpers or assignment targets are ambiguous');
    for (const statement of program.body) {
      if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations) {
          const value = evaluate(declaration.init);
          if (declaration.id.type === 'Identifier') put(locals, declaration.id.name, value);
          else locals.clear();
        }
      } else if (statement.type === 'ExpressionStatement') evaluate(statement.expression);
      else {
        invalidate(statement);
        calls.push(...parseImageGenerationInvocations(text(statement)).map((call) => ({ ...call, referencesUnresolved: true })));
      }
    }
  } catch {
    forget();
    return parseImageGenerationInvocations(source).map((call) => ({ ...call, referencesUnresolved: true }));
  } finally {
    bindings.stored = [...stored];
  }
  return calls;
}
