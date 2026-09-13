'use strict';
const fs = require('node:fs/promises');
const MAX_METADATA = 1024 * 1024;
const MAX_STRING = 256 * 1024;
const imageMarker = span => ({ __tesseraImage: span });

/** Byte-oriented JSONL tokenizer: image strings are skipped, never concatenated. */
class MetadataDecoder {
  constructor(start = 0) {
    this.recordStart = start;
    this.output = Buffer.alloc(4096);
    this.reset();
  }
  reset() {
    this.length = 0; this.stack = []; this.string = null; this.primitive = false; this.invalid = false;
  }
  emit(bytes) {
    if (this.length + bytes.length > MAX_METADATA) throw Error('Image replay metadata record exceeds 1 MiB');
    if (this.output.length < this.length + bytes.length) {
      const next = Buffer.alloc(Math.min(MAX_METADATA, Math.max(this.output.length * 2, this.length + bytes.length)));
      this.output.copy(next, 0, 0, this.length); this.output = next;
    }
    bytes.copy(this.output, this.length); this.length += bytes.length;
  }
  valuePath() {
    const top = this.stack.at(-1);
    return top ? [...top.path, top.kind === 'array' ? top.index : top.key] : [];
  }
  consumed() {
    const top = this.stack.at(-1);
    if (top?.kind === 'array') top.index++;
    else if (top) top.key = undefined;
  }
  startString(offset) {
    const top = this.stack.at(-1), key = top?.kind === 'object' && top.expectKey;
    const path = this.valuePath();
    const image = !key && (path.at(-1) === 'image_url' || path.join('.') === 'payload.item.result'
      || ['base64', 'data'].includes(path.at(-1)));
    this.string = { key, image, start: offset + 1, path, parts: [], size: 0, escaped: false, unicode: 0, omitted: false };
  }
  addString(bytes) {
    const s = this.string;
    if (s.image || s.omitted) return;
    s.size += bytes.length;
    if (s.size > MAX_STRING) { s.parts = []; s.omitted = true; return; }
    // Copy only retained metadata; never hold a slice backing a payload read buffer.
    s.parts.push(Buffer.from(bytes));
  }
  endString(offset) {
    const s = this.string;
    let value;
    if (s.image) value = imageMarker({ offset: s.start, length: offset - s.start, dataUrl: s.path.at(-1) === 'image_url' });
    else if (s.omitted) value = { __tesseraOmitted: true };
    else {
      try { value = JSON.parse('"' + Buffer.concat(s.parts).toString('utf8') + '"'); }
      catch { this.invalid = true; value = null; }
      if (!s.key && typeof value === 'string' && /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/.test(value)) {
        value = imageMarker({ offset: s.start, length: offset - s.start, dataUrl: true });
      }
    }
    if (s.key) {
      if (typeof value !== 'string') { this.invalid = true; value = ''; }
      const top = this.stack.at(-1);
      if (top) { top.key = value; top.expectKey = false; }
    } else this.consumed();
    this.emit(Buffer.from(JSON.stringify(value)));
    this.string = null;
  }
  push(buffer, absoluteOffset) {
    const records = [];
    for (let i = 0; i < buffer.length;) {
      const byte = buffer[i];
      if (this.string) {
        const s = this.string;
        // The common base64 run is skipped in one search, not one JS allocation per byte.
        if (!s.escaped && !s.unicode) {
          const quote = buffer.indexOf(34, i), slash = buffer.indexOf(92, i), newline = buffer.indexOf(10, i);
          const candidates = [quote, slash, newline].filter(n => n >= 0);
          const end = candidates.length ? Math.min(...candidates) : buffer.length;
          if (end > i) { this.addString(buffer.subarray(i, end)); i = end; if (i === buffer.length) break; }
        }
        const current = buffer[i];
        if (s.unicode) {
          if (!((current >= 48 && current <= 57) || (current >= 65 && current <= 70) || (current >= 97 && current <= 102))) this.invalid = true;
          this.addString(buffer.subarray(i, i + 1)); s.unicode--; i++; continue;
        }
        if (s.escaped) {
          if (current === 117) s.unicode = 4;
          else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(current)) this.invalid = true;
          this.addString(buffer.subarray(i, i + 1)); s.escaped = false; i++; continue;
        }
        if (current === 34) { this.endString(absoluteOffset + i); i++; continue; }
        if (current === 92) { this.addString(buffer.subarray(i, i + 1)); s.escaped = true; i++; continue; }
        if (current === 10) { this.invalid = true; this.string = null; continue; }
        this.addString(buffer.subarray(i, i + 1)); i++; continue;
      }
      if (byte === 10) {
        if (this.length && !this.invalid) {
          try {
            const record = JSON.parse(this.output.subarray(0, this.length).toString('utf8'));
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              record.__tesseraRecordOffset ??= this.recordStart;
              records.push({ record, offset: this.recordStart, end: absoluteOffset + i + 1 });
            }
          } catch { /* Ignore malformed JSONL records, but still advance their byte boundary. */ }
        }
        if (!records.length || records.at(-1).end !== absoluteOffset + i + 1) records.push({ record: null, offset: this.recordStart, end: absoluteOffset + i + 1 });
        this.recordStart = absoluteOffset + i + 1; this.reset(); i++; continue;
      }
      if (this.primitive && [44, 93, 125, 32, 9, 13].includes(byte)) { this.primitive = false; this.consumed(); }
      if (byte === 34) { this.startString(absoluteOffset + i); i++; continue; }
      if (byte === 123 || byte === 91) {
        if (this.stack.length >= 64) throw Error('Image replay metadata nesting limit exceeded');
        this.stack.push({ kind: byte === 123 ? 'object' : 'array', path: this.valuePath(), expectKey: byte === 123, index: 0 });
      }
      else if (byte === 125 || byte === 93) { this.stack.pop(); this.consumed(); }
      else if (byte === 44) { const top = this.stack.at(-1); if (top?.kind === 'object') top.expectKey = true; }
      else if (![58, 32, 9, 13].includes(byte)) this.primitive = true;
      this.emit(buffer.subarray(i, i + 1)); i++;
    }
    return records;
  }
}

async function readMetadataRecords(filePath, options, consume) {
  const file = await fs.open(filePath, 'r');
  try {
    const size = (await file.stat()).size, end = Math.min(options.end ?? size, size);
    const start = options.start ?? 0, decoder = new MetadataDecoder(start), began = Date.now();
    const buffer = Buffer.alloc(64 * 1024);
    let position = start, offset = start;
    while (position < end && !options.signal?.aborted) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (!bytesRead) break;
      const records = decoder.push(buffer.subarray(0, bytesRead), position); position += bytesRead;
      for (const entry of records) {
        if (options.signal?.aborted) return { offset, bytesRead: offset - start, more: offset < end };
        if (entry.record) await consume(entry.record, entry.offset);
        offset = entry.end;
        if (offset - start >= (options.maxBytes ?? Infinity) || Date.now() - began >= (options.maxMs ?? Infinity)) {
          return { offset, bytesRead: offset - start, more: offset < end };
        }
      }
    }
    return { offset, bytesRead: offset - start, more: options.signal?.aborted ? offset < end : false };
  } finally { await file.close(); }
}
module.exports = { MetadataDecoder, readMetadataRecords };
