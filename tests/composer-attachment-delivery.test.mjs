// Ticket #254 — an attachment the composer is holding must reach the CLI.
//
// The composer marks each attachment with a placeholder (`[📷 1]`, `[📎 2]`) inside the
// textarea, and the send builders reconstruct the outgoing content by matching those
// placeholders. That coupling is what breaks: the placeholder is ordinary editable text
// in a field the user (and the app itself) rewrites, so it can go missing while the
// attachment is still attached — and the builders then dropped the attachment silently.
// QA measured exactly that at the socket: a `send_message` frame with no attachment field
// of any kind while a blob preview was on screen.
//
// The named imports below could not resolve until #278 raised the tsx floor — see
// `mjs-ts-named-import-contract.test.mjs` for why, and before reaching for the
// `import * as ns` workaround the older `.test.mjs` files use.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMessageInputDisplayContent,
  buildMessageInputSendContent,
  dropAttachmentPlaceholders,
} from '../src/lib/chat/attachment-content.ts';

const imageAttachment = (id) => ({
  kind: 'image',
  id,
  blob: null,
  base64: `base64-of-image-${id}`,
  mediaType: 'image/png',
  previewUrl: `blob:preview-${id}`,
});

const fileAttachment = (id) => ({
  kind: 'file',
  id,
  fileName: `notes-${id}.txt`,
  serverPath: `/uploads/notes-${id}.txt`,
});

test('an image whose placeholder is still in the text is sent where the placeholder sits', () => {
  const content = buildMessageInputSendContent('look at [📷 1] please', [imageAttachment(1)]);

  assert.deepEqual(content, [
    { type: 'text', text: 'look at' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-1' } },
    { type: 'text', text: 'please' },
  ]);
});

test('an image whose placeholder is gone is still sent, after the text', () => {
  // The user attached an image and then rewrote the message, taking the placeholder with
  // it. The image is still attached — the preview is still on screen — so it still goes.
  const content = buildMessageInputSendContent('the placeholder is gone', [imageAttachment(1)]);

  assert.deepEqual(content, [
    { type: 'text', text: 'the placeholder is gone' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-1' } },
  ]);
});

test('an attached image survives an empty composer', () => {
  const content = buildMessageInputSendContent('', [imageAttachment(7)]);

  assert.deepEqual(content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-7' } },
  ]);
});

test('only the images the text lost are appended, and each is sent once', () => {
  const content = buildMessageInputSendContent('first [📷 1] then', [
    imageAttachment(1),
    imageAttachment(2),
  ]);

  assert.deepEqual(content, [
    { type: 'text', text: 'first' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-1' } },
    { type: 'text', text: 'then' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-2' } },
  ]);
});

test('an uploaded file whose placeholder is gone still hands its path to the CLI', () => {
  // A file attachment is a path the CLI has to read. Losing the placeholder loses the
  // path, and the CLI is told to look at nothing.
  const content = buildMessageInputSendContent('read this', [fileAttachment(3)]);

  assert.equal(content, 'read this\n/uploads/notes-3.txt');
});

test('a file placeholder still in the text is replaced in place, not appended twice', () => {
  const content = buildMessageInputSendContent('read [📎 3] now', [fileAttachment(3)]);

  assert.equal(content, 'read /uploads/notes-3.txt now');
});

test('the display copy shows the lost file by name rather than by path', () => {
  const display = buildMessageInputDisplayContent('read this', [fileAttachment(3)]);

  assert.equal(display, 'read this\n📎 notes-3.txt');
});

test('the display copy renders a lost image as a thumbnail block', () => {
  const display = buildMessageInputDisplayContent('the placeholder is gone', [imageAttachment(1)]);

  assert.deepEqual(display, [
    { type: 'text', text: 'the placeholder is gone' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64-of-image-1' } },
  ]);
});

test('a draft left behind loses the markers of the attachments being discarded', () => {
  // Attachments belong to the composer, not to a session, so leaving a session
  // discards them — and a marker pointing at a discarded attachment is worse
  // than no marker, because the CLI would be handed the literal text.
  const draft = dropAttachmentPlaceholders('before [📷 1] middle [📎 2] after', [
    imageAttachment(1),
    fileAttachment(2),
  ]);

  assert.equal(draft, 'before middle after');
});

test('discarding attachments leaves markers that belong to something else alone', () => {
  const draft = dropAttachmentPlaceholders('keep [📷 9] drop [📷 1]', [imageAttachment(1)]);

  assert.equal(draft, 'keep [📷 9] drop');
});

test('discarding a marker leaves the rest of the draft spaced as it was', () => {
  // Only the gap the marker left is the builder's business. A draft can hold a
  // pasted code block, and re-flowing its indentation would be a change the user
  // never asked for.
  const draft = dropAttachmentPlaceholders(
    'see [📷 1] this:\n    indented = 1\n        deeper = 2',
    [imageAttachment(1)],
  );

  assert.equal(draft, 'see this:\n    indented = 1\n        deeper = 2');
});

test('a draft with nothing to discard is returned untouched', () => {
  assert.equal(dropAttachmentPlaceholders('  spacing  matters  ', []), '  spacing  matters  ');
});

test('text with no attachments is left exactly as typed', () => {
  assert.equal(buildMessageInputSendContent('just words', []), 'just words');
  assert.equal(buildMessageInputDisplayContent('just words', []), 'just words');
});
