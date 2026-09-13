import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { MetadataDecoder } = require('../runtime/image-record-reader.cjs');
function decode(value, chunkSize) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const decoder = new MetadataDecoder(); let records = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) records.push(...decoder.push(bytes.subarray(offset, offset + chunkSize), offset));
  return { bytes, record: records[0].record };
}
test('streaming preserves nested metadata across UTF-8, escaped keys and primitive boundaries', () => {
  const value = { type:'response_item',payload:{list:[1,true,null,{ '한글"key': 'hello\\\n😀', number:-12.5e3 },['x','y']],input:'store("path",`/한글/a.png`);'}};
  for (const size of [1,2,3,7,64]) assert.deepEqual(decode(value,size).record,{...value,__tesseraRecordOffset:0});
});
test('image payloads become exact byte spans, independent of payload size or field order', () => {
  const value = {payload:{item:{result:'QUJD'.repeat(1000),id:'x',kind:'image_gen.generation'},content:[{image_url:'data:image/png;base64,YQ=='}],output:[{type:'image',data:'Yg==',mimeType:'image/png'}]}};
  for (const size of [1,7,65536]) {
    const {record,bytes} = decode(value,size);
    const span = record.payload.item.result.__tesseraImage;
    assert.equal(bytes.subarray(span.offset,span.offset+span.length).toString(),value.payload.item.result);
    assert.ok(record.payload.content[0].image_url.__tesseraImage.dataUrl);
    assert.ok(record.payload.output[0].data.__tesseraImage);
    assert.ok(JSON.stringify(record).length<1024);
  }
});
test('oversized unstructured text and embedded image text never reach replay as large strings', () => {
  const value={payload:{output:[{text:'x'.repeat(300000)},{text:'result {"image_url":"data:image/png;base64,YQ=="}'}]}};
  const {record}=decode(value,65536);
  assert.deepEqual(record.payload.output[0].text,{__tesseraOmitted:true});
  assert.ok(record.payload.output[1].text.__tesseraImage);
});
