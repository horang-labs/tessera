/** Guest-only Linux containment. A subreaper adopts detached/double-forked descendants:
 * https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
 * Completion requires kernel waitpid ECHILD after the sole launch, never an empty /proc scan.
 * Signals use pidfds for positively identified direct children, preventing PID reuse targeting.
 * Python/prctl/pidfd unavailability fails before launch. No privileges or server-side home needed.
 */
export const AUTORUN_CONTAINMENT_GUARDIAN = String.raw`
import ctypes, errno, json, os, signal, subprocess, sys, time
root = sys.argv[1]
attempt_root = sys.argv[2] if len(sys.argv) > 2 else None
state_file = attempt_root + '/state.json' if attempt_root else None
def read(file):
    with open(file) as f: return json.load(f)
def write(file, value):
    temp = file + '.guardian.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f); f.flush(); os.fsync(f.fileno())
    os.replace(temp, file)
    fd = os.open(os.path.dirname(file), os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def stat(pid):
    with open('/proc/' + str(pid) + '/stat') as f: fields = f.read().rsplit(') ', 1)[1].split()
    return {'pid': pid, 'state': fields[0], 'parent': int(fields[1]), 'start': fields[19]}
def now(): return int(time.time() * 1000)
launch = read(root + '/launch.json')
state = read(state_file) if state_file else None
if state:
    manifest = read(state['ledgerRoot'] + '/invocation.json')
    keys = ['version', 'userId', 'agentEnvironment', 'invocationId', 'provider', 'launchId']
    if state['phase'] != 'prelaunch' or any(state[k] != manifest[k] for k in keys) or state['attemptId'] not in manifest['attemptIds']:
        sys.exit(1)
    if manifest['closedAt'] is not None or now() >= manifest['deadlineAt']:
        state.update(phase='settled', spawned=False, noLaunchReason='authorization-sealed' if manifest['closedAt'] is not None else 'deadline', quiescent=True, remaining=[], settledAt=now())
        write(state_file, state); sys.exit(1)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, ctypes.c_ulong(1), 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), 'subreaper unavailable')
enabled = ctypes.c_int()
if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1: raise RuntimeError('subreaper not enabled')
fd = os.pidfd_open(os.getpid(), 0)
try: signal.pidfd_send_signal(fd, 0)
finally: os.close(fd)
signal.signal(signal.SIGCHLD, signal.SIG_DFL)
stopped = False
def cancel(_sig, _frame):
    global stopped
    stopped = True
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, cancel)
guardian = {k: v for k, v in stat(os.getpid()).items() if k in ('pid', 'start')}
with open('/proc/sys/kernel/random/boot_id') as f: guardian['bootId'] = f.read().strip()
if state:
    state.update(phase='starting', guardian=guardian)
    write(state_file, state)  # Durable admission/guardian identity before any launcher can execute.
marker = root + '/group-exit.json'
try: os.unlink(marker)
except FileNotFoundError: pass
launcher = None
try: launcher = subprocess.Popen(['node', root + '/group.cjs', root] + ([attempt_root] if attempt_root else []))
except OSError: stopped = True
launcher_code = None
stop_at = None
signalled = set()
def owned_descendant(pid):
    original = stat(pid)
    parent = original['parent']
    seen = {pid}
    while parent != os.getpid():
        if parent <= 1 or parent in seen: return None
        seen.add(parent)
        parent = stat(parent)['parent']
    return original
def signal_owned(sig):
    for name in os.listdir('/proc'):
        if not name.isdecimal(): continue
        pid = int(name)
        try:
            owned = owned_descendant(pid)
            if owned is None or owned['state'] == 'Z': continue
            if launcher and pid == launcher.pid and sig == signal.SIGTERM: continue  # Allow final output to drain.
            key = (pid, owned['start'])
            if sig == signal.SIGTERM and key in signalled: continue
            fd = os.pidfd_open(pid, 0)
            try:
                current = owned_descendant(pid)
                if current is not None and current['start'] == owned['start']:
                    signal.pidfd_send_signal(fd, sig); signalled.add(key)
            finally: os.close(fd)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ESRCH): raise
def finish(quiescent):
    code = launcher_code
    try:
        result = read(marker)
        if result.get('attemptId') == (state['attemptId'] if state else None): code = result.get('exitCode')
    except (OSError, ValueError): pass
    receipt = {'exitCode': code, 'quiescent': quiescent, 'remaining': [], 'settledAt': now(),
        'containment': {'kind': 'linux-subreaper-v1', 'guardian': guardian, 'terminal': 'ECHILD' if quiescent else 'unresolved'}}
    if state:
        current = read(state_file)
        current.update(receipt, phase='settled', spawned=launcher is not None)
        if launcher is None: current['noLaunchReason'] = 'spawn-error'
        write(state_file, current)
    write(root + '/settled.json', receipt)
    sys.exit(0 if code == 0 and quiescent else 1)
while True:
    # Subreaper adoption + ECHILD proves every descendant reaped, including new groups/sessions.
    # This guardian has exactly one Popen site and cannot grant another launch after this point.
    try:
        while True:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0: break
            if launcher and pid == launcher.pid:
                launcher_code = os.waitstatus_to_exitcode(status); stopped = True
    except ChildProcessError: finish(True)
    if os.path.exists(marker) or os.path.exists(root + '/abort') or now() >= launch['deadlineAt']: stopped = True
    if stopped:
        if stop_at is None: stop_at = time.monotonic()
        elapsed = time.monotonic() - stop_at
        try: signal_owned(signal.SIGKILL if elapsed >= 5 else signal.SIGTERM)
        except OSError: pass  # No unverified signal; lack of containment settlement stays unknown.
        if elapsed >= 7: finish(False)
    time.sleep(0.025)
`;
