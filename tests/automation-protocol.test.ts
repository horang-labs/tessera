import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

test('consumer fixtures compile: legacy WS compatibility, epochs/acks, nullable wake and explicit fresh selection', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(['tests/fixtures/automation-protocol.ts', 'tests/automation-contracts.test.ts', 'tests/automation-client-state.test.ts', 'tests/automation-runtime-bridge.test.ts'], {
    ...parsed.options, incremental: false, noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => '\n',
  }));
});
