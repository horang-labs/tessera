import type { ContentBlock } from '@/lib/ws/message-types';
import type { EnhancedMessage } from '@/types/chat';

export type ImageLocator =
  | { kind: 'inline'; data: string; mimeType: string }
  | { kind: 'path'; path: string };

export type ImageTraceSource = 'conversation' | 'generated' | 'file' | 'explicit-path';

export interface ResolvedTraceImage {
  source: ImageTraceSource;
  label: string;
  locator: ImageLocator;
  /** Path reported by the agent runtime, suitable for inserting back into its PTY. */
  agentPath?: string;
  sourceMessageId?: string;
}

export interface ImageGenerationTrace {
  id: string;
  invocationMessageId: string;
  prompt: string;
  referencedImagePaths?: string[];
  numLastImagesToInclude?: number;
  inputs: ResolvedTraceImage[];
  unresolvedInputCount: number;
  status: 'running' | 'completed' | 'error';
  revisedPrompt?: string;
  error?: string;
  result?: ResolvedTraceImage;
  timestamp: string;
}

export interface PublicImageGenerationTrace extends Omit<ImageGenerationTrace, 'inputs' | 'result'> {
  inputs: Array<Omit<ResolvedTraceImage, 'locator'> & { url: string }>;
  result?: Omit<ResolvedTraceImage, 'locator'> & { url: string; path?: string };
}

interface ImageGenerationInvocation {
  prompt: string;
  referencedImagePaths?: string[];
  numLastImagesToInclude?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readQuoted(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      if (next === undefined) return undefined;
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
      value += escapes[next] ?? next;
      index += 1;
      continue;
    }
    if (character === quote) return { value, end: index + 1 };
    // Template interpolation would require evaluating code, so do not guess.
    if (quote === '`' && character === '$' && source[index + 1] === '{') return undefined;
    value += character;
  }
  return undefined;
}

function extractBalancedObject(source: string, start: number): { source: string; end: number } | undefined {
  if (source[start] !== '{') return undefined;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const quoted = readQuoted(source, index);
      if (!quoted) return undefined;
      index = quoted.end - 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return { source: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return undefined;
}

function findProperty(objectSource: string, name: string): number | undefined {
  let depth = 0;
  for (let index = 1; index < objectSource.length - 1; index += 1) {
    const character = objectSource[index];
    if (character === '"' || character === "'" || character === '`') {
      const quoted = readQuoted(objectSource, index);
      if (!quoted) return undefined;
      if (depth === 0 && quoted.value === name) {
        let cursor = quoted.end;
        while (/\s/.test(objectSource[cursor] ?? '')) cursor += 1;
        if (objectSource[cursor] === ':') return cursor + 1;
      }
      index = quoted.end - 1;
      continue;
    }
    if (character === '{' || character === '[' || character === '(') depth += 1;
    else if (character === '}' || character === ']' || character === ')') depth -= 1;
    else if (depth === 0 && (/[A-Za-z_$]/.test(character))) {
      const match = objectSource.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (match === name) {
        let cursor = index + match.length;
        while (/\s/.test(objectSource[cursor] ?? '')) cursor += 1;
        if (objectSource[cursor] === ':') return cursor + 1;
      }
      if (match) index += match.length - 1;
    }
  }
  return undefined;
}

function skipSpace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function readStringProperty(source: string, name: string): string | undefined {
  const property = findProperty(source, name);
  if (property === undefined) return undefined;
  return readQuoted(source, skipSpace(source, property))?.value;
}

function readIntegerProperty(source: string, name: string): number | undefined {
  const property = findProperty(source, name);
  if (property === undefined) return undefined;
  const match = source.slice(skipSpace(source, property)).match(/^\d+/)?.[0];
  if (!match) return undefined;
  const value = Number(match);
  return Number.isSafeInteger(value) ? value : undefined;
}

function readStringArrayProperty(source: string, name: string): string[] | undefined {
  const property = findProperty(source, name);
  if (property === undefined) return undefined;
  let cursor = skipSpace(source, property);
  if (source[cursor] !== '[') return undefined;
  cursor += 1;
  const values: string[] = [];
  while (cursor < source.length) {
    cursor = skipSpace(source, cursor);
    if (source[cursor] === ']') return values;
    const item = readQuoted(source, cursor);
    if (!item) return undefined;
    values.push(item.value);
    cursor = skipSpace(source, item.end);
    if (source[cursor] === ']') return values;
    if (source[cursor] !== ',') return undefined;
    cursor += 1;
  }
  return undefined;
}

function findCodeMarkers(source: string, marker: string): number[] {
  const matches: number[] = [];
  let quote: '"' | "'" | '`' | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (source.startsWith(marker, index)) {
      matches.push(index);
      index += marker.length - 1;
    }
  }
  return matches;
}

/** Parse literal imagegen calls without evaluating arbitrary transcript JavaScript. */
export function parseImageGenerationInvocations(source: string): ImageGenerationInvocation[] {
  const marker = 'tools.image_gen__imagegen';
  const calls: ImageGenerationInvocation[] = [];
  for (const markerIndex of findCodeMarkers(source, marker)) {
    let cursor = skipSpace(source, markerIndex + marker.length);
    if (source[cursor] !== '(') continue;
    cursor = skipSpace(source, cursor + 1);
    const object = extractBalancedObject(source, cursor);
    if (!object) continue;
    const prompt = readStringProperty(object.source, 'prompt');
    if (prompt !== undefined) {
      const referencedImagePaths = readStringArrayProperty(object.source, 'referenced_image_paths');
      const numLastImagesToInclude = readIntegerProperty(object.source, 'num_last_images_to_include');
      calls.push({
        prompt,
        ...(referencedImagePaths ? { referencedImagePaths } : {}),
        ...(numLastImagesToInclude !== undefined ? { numLastImagesToInclude } : {}),
      });
    }
  }
  return calls;
}

function inlineImages(content: string | ContentBlock[], messageId: string): ResolvedTraceImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => block.type === 'image'
    ? [{
        source: 'conversation' as const,
        label: `Conversation image ${index + 1}`,
        locator: { kind: 'inline' as const, data: block.source.data, mimeType: block.source.media_type },
        sourceMessageId: messageId,
      }]
    : []);
}

function invocationSource(message: Extract<EnhancedMessage, { type: 'tool_call' }>): string | undefined {
  for (const key of ['input', 'source', 'code', 'command', 'arguments']) {
    const value = message.toolParams[key];
    if (typeof value === 'string' && value.includes('image_gen__imagegen')) return value;
  }
  return undefined;
}

function imageFromTool(
  message: Extract<EnhancedMessage, { type: 'tool_call' }>,
  generatedByInvocation: boolean,
): ResolvedTraceImage | undefined {
  const result = message.toolUseResult;
  if (isRecord(result) && result.kind === 'file_read' && result.contentType === 'image') {
    const source = generatedByInvocation ? 'generated' as const : 'file' as const;
    const label = generatedByInvocation
      ? 'Generated image'
      : (typeof result.path === 'string' ? result.path : 'Tool image');
    if (typeof result.base64 === 'string') {
      return {
        source,
        label,
        locator: { kind: 'inline', data: result.base64, mimeType: typeof result.mimeType === 'string' ? result.mimeType : 'image/png' },
        sourceMessageId: message.id,
      };
    }
    if (typeof result.path === 'string') {
      return { source, label, locator: { kind: 'path', path: result.path }, sourceMessageId: message.id };
    }
  }
  const path = message.toolParams.path ?? message.toolParams.file_path;
  if (typeof path === 'string' && /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) {
    return { source: 'file', label: path, locator: { kind: 'path', path }, sourceMessageId: message.id };
  }
  return undefined;
}

function sameImage(left: ResolvedTraceImage, right: ResolvedTraceImage): boolean {
  if (left.locator.kind !== right.locator.kind) return false;
  if (left.locator.kind === 'path' && right.locator.kind === 'path') {
    return left.locator.path === right.locator.path;
  }
  if (left.locator.kind === 'inline' && right.locator.kind === 'inline') {
    return left.locator.mimeType === right.locator.mimeType && left.locator.data === right.locator.data;
  }
  return false;
}

function isImageGenerationResult(message: Extract<EnhancedMessage, { type: 'tool_call' }>): boolean {
  return message.toolName === 'ImageGeneration'
    || message.toolName === 'imageGeneration'
    || message.toolParams.itemType === 'imageGeneration';
}

function resultImage(message: Extract<EnhancedMessage, { type: 'tool_call' }>): ResolvedTraceImage | undefined {
  const result = message.toolUseResult;
  const savedPath = typeof message.toolParams.savedPath === 'string' && message.toolParams.savedPath
    ? message.toolParams.savedPath
    : undefined;
  if (isRecord(result) && result.kind === 'file_read' && result.contentType === 'image' && typeof result.base64 === 'string') {
    return {
      source: 'generated',
      label: 'Generated image',
      locator: { kind: 'inline', data: result.base64, mimeType: typeof result.mimeType === 'string' ? result.mimeType : 'image/png' },
      ...(savedPath ? { agentPath: savedPath } : {}),
      sourceMessageId: message.id,
    };
  }
  if (savedPath) {
    return {
      source: 'generated',
      label: savedPath,
      locator: { kind: 'path', path: savedPath },
      agentPath: savedPath,
      sourceMessageId: message.id,
    };
  }
  return undefined;
}

/** Reconstruct imagegen calls against the exact image ledger visible at each call ordinal. */
export function projectImageGenerationTraces(messages: EnhancedMessage[]): ImageGenerationTrace[] {
  const ledger: ResolvedTraceImage[] = [];
  const traces: ImageGenerationTrace[] = [];
  const pending: ImageGenerationTrace[] = [];

  for (const message of messages) {
    if (message.type === 'text' && message.role === 'user') {
      ledger.push(...inlineImages(message.content, message.id));
      continue;
    }
    if (message.type !== 'tool_call') continue;

    if (isImageGenerationResult(message)) {
      const trace = pending.shift();
      const image = resultImage(message);
      if (trace) {
        trace.status = message.status;
        trace.revisedPrompt = typeof message.toolParams.revisedPrompt === 'string' ? message.toolParams.revisedPrompt : undefined;
        trace.error = message.error ?? (typeof message.toolParams.failure === 'string' ? message.toolParams.failure : undefined);
        trace.result = image;
      }
      if (image) {
        const previous = ledger.at(-1);
        const duplicatesInvocationResult = Boolean(
          trace
          && previous?.sourceMessageId === trace.invocationMessageId
          && sameImage(previous, image),
        );
        if (duplicatesInvocationResult) ledger[ledger.length - 1] = image;
        else ledger.push(image);
      }
      continue;
    }

    const source = invocationSource(message);
    const invocations = source ? parseImageGenerationInvocations(source) : [];
    if (invocations.length > 0) {
      for (const [callIndex, invocation] of invocations.entries()) {
        const explicit = invocation.referencedImagePaths?.map((path) => ({
          source: 'explicit-path' as const,
          label: path,
          locator: { kind: 'path' as const, path },
          sourceMessageId: message.id,
        }));
        const requested = invocation.numLastImagesToInclude ?? 0;
        const inputs = explicit ?? (requested > 0 ? ledger.slice(-requested) : []);
        const trace: ImageGenerationTrace = {
          id: `${message.toolUseId ?? message.id}-${callIndex}`,
          invocationMessageId: message.id,
          prompt: invocation.prompt,
          ...(invocation.referencedImagePaths ? { referencedImagePaths: invocation.referencedImagePaths } : {}),
          ...(invocation.numLastImagesToInclude !== undefined ? { numLastImagesToInclude: invocation.numLastImagesToInclude } : {}),
          inputs: inputs.map((input) => ({ ...input })),
          unresolvedInputCount: explicit ? 0 : Math.max(0, requested - inputs.length),
          status: 'running',
          timestamp: message.timestamp,
        };
        traces.push(trace);
        pending.push(trace);
      }
    }

    const toolImage = imageFromTool(message, invocations.length > 0);
    if (toolImage) ledger.push(toolImage);
  }
  return traces;
}

export function toPublicImageGenerationTraces(
  sessionId: string,
  traces: ImageGenerationTrace[],
): PublicImageGenerationTrace[] {
  return traces.map((trace) => {
    const { inputs, result, ...metadata } = trace;
    return {
      ...metadata,
      inputs: inputs.map(({ locator: _locator, ...input }, index) => ({
        ...input,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/image-generations/${encodeURIComponent(trace.id)}/inputs/${index}`,
      })),
      ...(result ? {
        result: {
          source: result.source,
          label: result.label,
          ...(result.agentPath ? { path: result.agentPath } : {}),
          ...(result.sourceMessageId ? { sourceMessageId: result.sourceMessageId } : {}),
          url: `/api/sessions/${encodeURIComponent(sessionId)}/image-generations/${encodeURIComponent(trace.id)}/result`,
        },
      } : {}),
    };
  });
}
