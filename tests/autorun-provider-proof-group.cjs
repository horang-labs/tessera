// Owned WSL process group; never kill wsl.exe or an unowned provider process.
const fs = require('node:fs');
const cp = require('node:child_process');
const base = process.env.PROOF_ROOT;
const label = process.env.PROOF_LABEL;
const launch = JSON.parse(fs.readFileSync(base + '/' + label + '-launch.json', 'utf8'));
const script = label.endsWith('cancel') ? 'sleep 300 & exec "$@"' : 'exec "$@"';
const child = cp.spawn('/bin/sh', ['-c', script, 'proof-cli', launch.command, ...launch.args], {
  detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
function members() {
  const result = [];
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === child.pid) result.push({ pid: Number(pid), state: fields[0], start: fields[19] });
    } catch { /* process exited during observation */ }
  }
  return result;
}
const manifest = { pid: child.pid, members: [] };
setTimeout(() => {
  manifest.members = members();
  fs.writeFileSync(base + '/' + label + '-pid.json', JSON.stringify(manifest));
}, 200);
let cancelled = false;
const timer = setInterval(() => {
  if (!fs.existsSync(base + '/' + label + '-abort')) return;
  cancelled = true;
  clearInterval(timer);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => {
    if (members().some(p => p.state !== 'Z')) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }, 300);
}, 100);
child.on('exit', () => {
  // Descendants retaining stdout must not keep the owned wrapper alive.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
});
child.on('close', code => {
  clearInterval(timer);
  const remaining = members();
  fs.writeFileSync(base + '/' + label + '-closed.json', JSON.stringify({
    code, cancelled, remaining, quiescent: remaining.every(p => p.state === 'Z'),
  }));
  process.exitCode = cancelled ? 124 : code;
});
