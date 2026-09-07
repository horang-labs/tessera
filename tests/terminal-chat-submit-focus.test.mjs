import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the component's actual async submit callback with a deferred transport.
const source = fs.readFileSync(new URL('../src/components/chat/terminal-chat-composer.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('composer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'submit') callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);

for (const phone of [true, false]) {
  for (const accepted of [true, false]) {
    test(`${phone ? 'mobile' : 'desktop'} focus after ${accepted ? 'accepted' : 'rejected'} submission`, async () => {
      let focused = true, draft = 'hello', complete;
      const frames = [];
      const transport = new Promise(resolve => { complete = resolve; });
      const submit = vm.runInNewContext(`(${callback})`, {
        value: draft, isBlocked: false, isUploadingImage: false,
        submittingRef: { current: false }, retrySubmissionRef: { current: null },
        textareaRef: { current: { blur() { focused = false; }, focus() { focused = true; } } },
        isPhoneViewport: () => phone, setIsSubmitting() {}, uuidv4: () => 'submission',
        sessionId: 'test', sendTerminalChatMessage: () => transport,
        toast: { error() {} }, t: key => key,
        registerPendingTerminalChatMessage() {},
        setValue: update => { draft = update(draft); },
        requestAnimationFrame: callback => { frames.push(callback); },
      });
      const pending = submit();
      assert.equal(focused, !phone, 'Mobile must blur before transport finishes');
      focused = false; // The browser can also blur a disabled desktop textarea.
      complete({ accepted, reason: 'server' });
      await pending;
      frames.forEach(frame => frame());
      assert.equal(focused, !phone, 'Only desktop restores focus after transport finishes');
      assert.equal(draft, accepted ? '' : 'hello');
    });
  }
}
