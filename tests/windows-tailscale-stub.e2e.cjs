#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const executableOption = process.argv.find((value) => value.startsWith('--executable='));
if (!executableOption) {
  throw new Error('Usage: node tests/windows-tailscale-stub.e2e.cjs --executable=<path>');
}
const executable = path.resolve(executableOption.slice('--executable='.length));
const root = path.dirname(executable);
const statePath = path.join(root, 'fake-tailscale-owned-endpoint.txt');
const logPath = path.join(root, 'fake-tailscale-invocations.tsv');

function run(args) {
  return execFileSync(executable, args, { encoding: 'utf8' }).trim();
}

assert.equal(run(['--tessera-test-marker']), 'tessera.issue-308.fake-tailscale.v1');
fs.rmSync(statePath, { force: true });
fs.rmSync(logPath, { force: true });

const nodeStatus = JSON.parse(run(['status', '--json']));
assert.equal(nodeStatus.BackendState, 'Running');
assert.equal(nodeStatus.Self.DNSName, 'localhost.');
assert.deepEqual(nodeStatus.CertDomains, ['localhost']);

const before = JSON.parse(run(['serve', 'status', '--json']));
assert.deepEqual(
  before.Web['localhost:443'].Handlers['/'],
  { Text: 'keep-background' },
);
const unrelated = {
  tcp443: before.TCP['443'],
  tcp8080: before.TCP['8080'],
  web443: before.Web['localhost:443'],
  web8080: before.Web['localhost:8080'],
  funnel: before.AllowFunnel,
  foreground: before.Foreground,
  services: before.Services,
};

const target = 'http://127.0.0.1:32124';
run(['serve', '--bg', '--yes', '--https=10443', '--set-path=/', target]);
const configured = JSON.parse(run(['serve', 'status', '--json']));
assert.deepEqual({
  tcp443: configured.TCP['443'],
  tcp8080: configured.TCP['8080'],
  web443: configured.Web['localhost:443'],
  web8080: configured.Web['localhost:8080'],
  funnel: configured.AllowFunnel,
  foreground: configured.Foreground,
  services: configured.Services,
}, unrelated);
assert.deepEqual(configured.TCP['10443'], { HTTPS: true });
assert.deepEqual(
  configured.Web['localhost:10443'].Handlers['/'],
  { Proxy: target },
);

run(['serve', '--bg', '--yes', '--https=10443', '--set-path=/', 'off']);
assert.deepEqual(JSON.parse(run(['serve', 'status', '--json'])), before);

const invocations = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => {
  const [at, pid, os, invokedExecutable, args] = line.split('\t');
  return { at, pid: Number(pid), os, invokedExecutable, args: args.split('\u001f') };
});
assert.equal(invocations.length, 6);
assert.equal(invocations.every(({ pid }) => Number.isSafeInteger(pid) && pid > 0), true);
assert.equal(invocations.every(({ os }) => /Windows/i.test(os)), true);
assert.equal(
  invocations.every(({ invokedExecutable }) => path.resolve(invokedExecutable) === executable),
  true,
);
assert.equal(invocations.some(({ args }) => args.includes('reset') || args.includes('funnel')), false);

process.stdout.write(`${JSON.stringify({
  executable,
  windowsProcessEvidence: invocations.map(({ pid, os, invokedExecutable, args }) => ({
    pid, os, invokedExecutable, args,
  })),
  unrelatedStatePreservedAcrossSetupAndRemoval: true,
  liveTailscaleTouched: false,
}, null, 2)}\n`);
