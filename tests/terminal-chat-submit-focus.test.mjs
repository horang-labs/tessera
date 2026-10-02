import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { v4 as uuidv4 } from 'uuid';

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

// Run the actual shared correlation helper, with only its UUID system boundary injected.
const submissionSource = fs.readFileSync(new URL('../src/lib/terminal/terminal-chat-submissions.ts', import.meta.url), 'utf8');
function submissionHelpers() {
  const exports = {};
  const compiled = ts.transpileModule(submissionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => { assert.equal(name, 'uuid'); return { v4: uuidv4 }; } });
  return exports;
}

for (const phone of [true, false]) {
  for (const result of [
    { accepted: true },
    { accepted: false, reason: 'server', code: 'terminal_input_not_accepted' },
    { accepted: false, reason: 'server', code: 'UNRESOLVED_RUN' },
    { accepted: false, reason: 'timeout' },
  ]) {
    const uncertain = result.code === 'UNRESOLVED_RUN' || result.reason === 'timeout';
    const outcome = result.accepted ? 'accepted' : uncertain ? result.reason === 'timeout' ? 'timeout' : 'unknown' : 'rejected';
    test(`${phone ? 'mobile' : 'desktop'} focus after ${outcome} submission`, async () => {
      let focused = true, draft = 'hello', complete;
      const frames = [], sent = [], pendingMessages = [];
      const helpers = submissionHelpers();
      const original = helpers.getTerminalChatSubmission('test', draft);
      const transport = new Promise(resolve => { complete = resolve; });
      const submit = vm.runInNewContext(`(${callback})`, {
        value: draft, isBlocked: false, isUploadingImage: false,
        submittingRef: { current: false },
        ...helpers,
        textareaRef: { current: { blur() { focused = false; }, focus() { focused = true; } } },
        isPhoneViewport: () => phone, setIsSubmitting() {},
        sessionId: 'test', sendTerminalChatMessage: (...args) => { sent.push(args); return transport; },
        toast: { error() {} }, t: key => key,
        registerPendingTerminalChatMessage: (...args) => { pendingMessages.push(args); },
        setValue: update => { draft = update(draft); },
        requestAnimationFrame: callback => { frames.push(callback); },
      });
      const pending = submit();
      assert.equal(focused, !phone, 'Mobile must blur before transport finishes');
      assert.deepEqual(sent, [['test', 'hello', original.id]]);
      assert.equal(draft, 'hello', 'a pending transport cannot erase the draft');
      assert.equal(helpers.getTerminalChatSubmission('test', draft).id, original.id);
      focused = false; // The browser can also blur a disabled desktop textarea.
      complete(result);
      await pending;
      frames.forEach(frame => frame());
      assert.equal(focused, !phone, 'Only desktop restores focus after transport finishes');
      assert.equal(draft, result.accepted ? '' : 'hello');
      assert.deepEqual(pendingMessages, result.accepted ? [['test', 'hello', original.submittedAt]] : []);
      const retried = helpers.getTerminalChatSubmission('test', 'hello');
      if (uncertain) assert.equal(retried.id, original.id, 'uncertain input retains its same retry ID across remounts');
      else assert.notEqual(retried.id, original.id, 'accepted or definitively rejected input clears its correlation');
    });
  }
}
