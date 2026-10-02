import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { runtimeFixture, authorityFixture } from './fixtures/automation';
import * as bridge from '../src/lib/automation/runtime-bridge';

// Separate evaluations stand in for independently bundled Next/server module graphs.
function secondGraph(): typeof bridge {
  const source = readFileSync('src/lib/automation/runtime-bridge.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports) { ${compiled}\n})`)(exports);
  return exports as typeof bridge;
}

test('absent ports are unavailable; both module graphs share registration and owned cleanup', () => {
  const other = secondGraph();
  assert.equal(bridge.getAutomationRuntime(), null);
  assert.equal(other.getAutomationAuthority(), null);
  const runtime = runtimeFixture();
  const authority = authorityFixture();
  const removeRuntime = bridge.installAutomationRuntime(runtime);
  const removeAuthority = other.installAutomationAuthority(authority);
  try {
    assert.equal(other.getAutomationRuntime(), runtime);
    assert.equal(bridge.getAutomationAuthority(), authority);
    assert.throws(() => other.installAutomationRuntime({ ...runtime }));
    assert.throws(() => bridge.installAutomationAuthority({ ...authority }));
  } finally {
    removeRuntime();
    removeAuthority();
  }
  assert.equal(other.getAutomationRuntime(), null);
  assert.equal(bridge.getAutomationAuthority(), null);
  const removeReplacement = other.installAutomationRuntime(runtime);
  removeRuntime(); // stale cleanup must not uninstall a later registration, even of the same object
  assert.equal(bridge.getAutomationRuntime(), runtime);
  removeReplacement();
});
