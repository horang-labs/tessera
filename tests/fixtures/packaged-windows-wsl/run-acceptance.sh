#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-acceptance.sh --repo PATH [--session-id ID] [--fixture-root PATH]

Builds and exercises one isolated packaged Windows Electron parent/backend with
a WSL provider fixture. The runner is destructive only to launcher-owned test
roots bearing the generated ownership token. It never reads provider secrets.
EOF
}

repo=
session_id="t349-$(date +%m%d-%H%M%S)"
agent_home=${HOME:-}
[[ $agent_home =~ ^/home/[A-Za-z0-9._-]+$ ]] || { printf 'Acceptance requires a WSL /home directory\n' >&2; exit 2; }
fixture_root="$agent_home/.tessera/test-fixtures/t349-$(date +%m%d-%H%M%S)"
while (($#)); do
  case "$1" in
    --repo) repo=$2; shift 2 ;;
    --session-id) session_id=$2; shift 2 ;;
    --fixture-root) fixture_root=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n $repo ]] || { usage >&2; exit 2; }
repo=$(realpath "$repo")
[[ $session_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$ ]] || { printf 'Unsafe session id\n' >&2; exit 2; }
[[ $fixture_root =~ ^/home/[A-Za-z0-9._-]+/\.tessera/test-fixtures/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'Unsafe fixture root: %s\n' "$fixture_root" >&2
  exit 2
}
[[ ! -e $fixture_root ]] || { printf 'Fixture already exists: %s\n' "$fixture_root" >&2; exit 3; }

driver="$repo/tests/fixtures/packaged-windows-wsl/drive-electron.cjs"
setup="$repo/tests/fixtures/packaged-windows-wsl/setup.sh"
integrity_checker="$repo/tests/fixtures/packaged-windows-wsl/integrity-check.py"
launcher="$repo/scripts/launch-electron-test-instances.ps1"
stopper="$repo/scripts/stop-electron-test-session.ps1"
for required in "$driver" "$setup" "$integrity_checker" "$launcher" "$stopper"; do
  [[ -f $required ]] || { printf 'Missing acceptance dependency: %s\n' "$required" >&2; exit 4; }
done

artifact_wsl=
app_dir_wsl=
launched=0
owned_session=0
final_cleanup=0
package_output=
test_root_windows=
test_root_owner_token=
test_root_owned=0

remove_owned_test_root() {
  ((test_root_owned)) || return 0
  TEST_ROOT_WINDOWS="$test_root_windows" TEST_ROOT_OWNER_TOKEN="$test_root_owner_token" \
    WSLENV="TEST_ROOT_WINDOWS:TEST_ROOT_OWNER_TOKEN:${WSLENV:-}" \
    powershell.exe -NoProfile -Command \
    '$ErrorActionPreference="Stop"; $root=$env:TEST_ROOT_WINDOWS; $token=$env:TEST_ROOT_OWNER_TOKEN; $marker=Join-Path $root ".tessera-owner"; if(-not (Test-Path -LiteralPath $marker -PathType Leaf)){exit 44}; $recorded=(Get-Content -LiteralPath $marker -Raw).Trim(); if($recorded -ne $token){exit 45}; Remove-Item -LiteralPath $root -Recurse -Force'
  test_root_owned=0
}

cleanup() {
  local exit_code=$?
  local session_cleanup_ok=1
  if ((owned_session)) && ((final_cleanup == 0)); then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$stopper")" \
      -SessionId "$session_id" -TestRoot "$test_root_windows" -RemoveData >/dev/null 2>&1 || session_cleanup_ok=0
  fi
  if ((session_cleanup_ok)); then
    remove_owned_test_root >/dev/null 2>&1 || true
  fi
  for owned_download in "$artifact_wsl" "$app_dir_wsl"; do
    if [[ -n $owned_download && -e $owned_download ]]; then
      gio trash "$owned_download" >/dev/null 2>&1 || true
    fi
  done
  if [[ -e $fixture_root ]]; then
    gio trash "$fixture_root" >/dev/null 2>&1 || true
  fi
  if [[ -n $package_output && -e $package_output ]]; then
    gio trash "$package_output" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

installed_snapshot() {
  powershell.exe -NoProfile -Command \
    '$all = @(Get-CimInstance Win32_Process); $servers = @($all | Where-Object { $_.Name -eq "Tessera.exe" -and $_.CommandLine -match "server-child" -and $_.CommandLine -notmatch "TesseraTestInstances|electron-dev" }); $ids = @($servers.ProcessId) + @($servers.ParentProcessId); $p = $all | Where-Object { $_.ProcessId -in $ids } | Sort-Object ProcessId | Select-Object ProcessId,ParentProcessId; $l = Get-NetTCPConnection -State Listen -LocalPort 32123 -ErrorAction SilentlyContinue | Sort-Object LocalAddress | Select-Object LocalAddress,LocalPort,OwningProcess; [ordered]@{processes=@($p);listeners=@($l)} | ConvertTo-Json -Compress -Depth 4' \
    | tr -d '\r'
}

run_driver() {
  local cdp=$1 phase=$2
  shift 2
  local driver_windows repo_windows fixture_windows command
  driver_windows=$(wslpath -w "$driver")
  repo_windows=$(wslpath -w "$repo")
  fixture_windows=$(wslpath -w "$fixture_root")
  command="& 'C:\\Program Files\\nodejs\\node.exe' '$driver_windows' '--repo=$repo_windows' '--cdp=$cdp' '--phase=$phase' '--fixture-root=$fixture_windows'"
  local argument
  for argument in "$@"; do
    [[ $argument != *"'"* ]] || { printf 'Unsafe driver argument\n' >&2; return 2; }
    command+=" '$argument'"
  done
  powershell.exe -NoProfile -Command "$command" | tr -d '\r'
}

parse_instance() {
  local json_file=$1 key=$2
  jq -r "if type == \"array\" then .[0].$key else .$key end" "$json_file"
}

build_and_launch() {
  cd "$repo"
  local package_candidate="$repo/.tessera-acceptance-package-$session_id"
  [[ ! -e $package_candidate ]] || { printf 'Owned package output already exists: %s\n' "$package_candidate" >&2; return 5; }
  mkdir "$package_candidate"
  package_output=$package_candidate
  NEXT_PUBLIC_TESSERA_LOG_LEVEL=debug npm run electron:prebuild
  npx electron-builder --win portable --x64 --publish never \
    -c.extraMetadata.tesseraLogLevel=debug \
    --config.directories.output="$package_output" \
    --config.compression=store
  local artifact_source app_source windows_home downloads output_name output_dir_name
  artifact_source=$(find "$package_output" -maxdepth 1 -type f -iname '*.exe' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')
  app_source="$package_output/win-unpacked"
  [[ -f $artifact_source && -f $app_source/Tessera.exe ]] || {
    printf 'Packaged Windows outputs are incomplete\n' >&2
    return 5
  }
  local packaged_log_level
  packaged_log_level=$(node - "$app_source/resources/app.asar" <<'NODE'
const asar = require('@electron/asar');
const [asarPath] = process.argv.slice(2);
const manifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
process.stdout.write(typeof manifest.tesseraLogLevel === 'string' ? manifest.tesseraLogLevel : '');
NODE
  )
  [[ $packaged_log_level == debug ]] || {
    printf 'Packaged metadata did not bake in debug logging\n' >&2
    return 5
  }
  windows_home=$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("UserProfile")' | tr -d '\r')
  downloads=$(wslpath -u "$windows_home\\Downloads")
  output_name="Tessera-issue349-$session_id.exe"
  output_dir_name="Tessera-issue349-$session_id-unpacked"
  artifact_wsl="$downloads/$output_name"
  app_dir_wsl="$downloads/$output_dir_name"
  [[ ! -e $artifact_wsl && ! -e $app_dir_wsl ]] || {
    printf 'Refusing to overwrite Downloads acceptance artifacts\n' >&2
    return 6
  }
  cp -- "$artifact_source" "$artifact_wsl"
  cp -a -- "$app_source" "$app_dir_wsl"
  local executable_windows instances
  executable_windows=$(wslpath -w "$app_dir_wsl/Tessera.exe")
  # The manifest preflight above proved this ID was absent. From this point any
  # manifest bearing it belongs to this runner, including a partial launch.
  owned_session=1
  instances=$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$launcher")" \
    -Executable "$executable_windows" -Count 1 -SessionId "$session_id" \
    -TestRoot "$test_root_windows" \
    -SeedDataDir "$(wslpath -w "$fixture_root/tessera-data")" -WslDistro Ubuntu-24.04 | tr -d '\r')
  printf 'ARTIFACT_WINDOWS=%s\n' "$(wslpath -w "$artifact_wsl")"
  printf 'ARTIFACT_WSL=%s\n' "$artifact_wsl"
  printf 'ARTIFACT_SHA256=%s\n' "$(sha256sum "$artifact_wsl" | awk '{print $1}')"
  printf 'APP_DIR_WINDOWS=%s\n' "$(wslpath -w "$app_dir_wsl")"
  printf 'LAUNCH_EXECUTABLE_WINDOWS=%s\n' "$executable_windows"
  printf 'LAUNCH_EXECUTABLE_SHA256=%s\n' "$(sha256sum "$app_dir_wsl/Tessera.exe" | awk '{print $1}')"
  printf 'PACKAGED_LOG_LEVEL=%s\n' "$packaged_log_level"
  printf 'INSTANCES_JSON_BEGIN\n%s\nINSTANCES_JSON_END\n' "$instances"
}

sh "$setup" "$fixture_root" >/dev/null
chmod 700 "$fixture_root"
test_root_windows=$(powershell.exe -NoProfile -Command "Join-Path \$env:LOCALAPPDATA 'TesseraAcceptance\\$session_id'" | tr -d '\r')
test_root_owner_token=$(powershell.exe -NoProfile -Command '[Guid]::NewGuid().ToString("N")' | tr -d '\r')
if ! TEST_ROOT_WINDOWS="$test_root_windows" TEST_ROOT_OWNER_TOKEN="$test_root_owner_token" \
  WSLENV="TEST_ROOT_WINDOWS:TEST_ROOT_OWNER_TOKEN:${WSLENV:-}" \
  powershell.exe -NoProfile -Command \
  '$ErrorActionPreference="Stop"; $root=$env:TEST_ROOT_WINDOWS; $token=$env:TEST_ROOT_OWNER_TOKEN; $created=$false; try { New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null; $created=$true; Set-Content -LiteralPath (Join-Path $root ".tessera-owner") -Value $token -NoNewline -Encoding ASCII -ErrorAction Stop; exit 0 } catch { if($created -and (Test-Path -LiteralPath $root)){Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}; exit 1 }'; then
  printf 'Refusing a pre-existing acceptance test root: %s\n' "$test_root_windows" >&2
  exit 7
fi
test_root_owned=1
before_installed=$(installed_snapshot)
native_home_windows=$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("UserProfile")' | tr -d '\r')
native_home=$(wslpath -u "$native_home_windows")
integrity_snapshot="$fixture_root/evidence/protected-integrity-before.json"
python3 "$integrity_checker" snapshot \
  --agent-home "$agent_home" --native-home "$native_home" --snapshot "$integrity_snapshot"
integrity_snapshot_sha256=$(sha256sum "$integrity_snapshot" | awk '{print $1}')

unset TESSERA_DEV_PORT ELECTRON_RUN_AS_NODE CODEX_HOME TESSERA_CODEX_HOME \
  TESSERA_CLI_COMMAND TESSERA_PROJECT_ID TESSERA_WORKTREE_ID TESSERA_SESSION_ID \
  TESSERA_PANE_TOKEN TESSERA_HOOK_PORT CLAUDE_CONFIG_DIR XDG_CONFIG_HOME XDG_DATA_HOME
export TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT=$fixture_root
export WSLENV="TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT:${WSLENV:-}"

build_output="$fixture_root/evidence/build-launch.txt"
build_and_launch >"$build_output"
artifact_wsl=$(sed -n 's/^ARTIFACT_WSL=//p' "$build_output")
artifact_sha256=$(sed -n 's/^ARTIFACT_SHA256=//p' "$build_output")
app_dir_windows=$(sed -n 's/^APP_DIR_WINDOWS=//p' "$build_output")
app_dir_wsl=$(wslpath -u "$app_dir_windows")
executable_windows=$(sed -n 's/^LAUNCH_EXECUTABLE_WINDOWS=//p' "$build_output")
launch_executable_sha256=$(sed -n 's/^LAUNCH_EXECUTABLE_SHA256=//p' "$build_output")
packaged_log_level=$(sed -n 's/^PACKAGED_LOG_LEVEL=//p' "$build_output")
[[ $packaged_log_level == debug ]] || { printf 'Acceptance did not launch a debug package\n' >&2; exit 30; }
instances_json="$fixture_root/evidence/instances-initial.json"
sed -n '/^INSTANCES_JSON_BEGIN$/,/^INSTANCES_JSON_END$/p' "$build_output" | sed '1d;$d' >"$instances_json"
[[ -s $instances_json ]] || { printf 'Launcher did not return an owned instance manifest\n' >&2; exit 8; }
launched=1
cdp=$(parse_instance "$instances_json" cdpUrl)
server_port=$(parse_instance "$instances_json" serverPort)
wsl_state_root=$(parse_instance "$instances_json" wslStateRoot)
data_dir_windows=$(parse_instance "$instances_json" dataDir)
data_dir_wsl=$(wslpath -u "$data_dir_windows")

run_driver "$cdp" configure >"$fixture_root/evidence/configure.json"
run_driver "$cdp" install >"$fixture_root/evidence/install.json"
run_driver "$cdp" start "--work-dir=$repo" >"$fixture_root/evidence/start.json"
managed_session=$(jq -r '.created.body.sessionId' "$fixture_root/evidence/start.json")
run_driver "$cdp" terminal-create "--session-id=$managed_session" "--work-dir=$repo" >"$fixture_root/evidence/initial-terminal.json"
run_driver "$cdp" terminal-input "--session-id=$managed_session" >"$fixture_root/evidence/input.json"

ZDOTDIR="$fixture_root/shell" env -u CODEX_HOME -u TESSERA_CLI_COMMAND \
  -u TESSERA_PROJECT_ID -u TESSERA_WORKTREE_ID -u TESSERA_SESSION_ID \
  zsh -ilc 'codex acceptance-external' >/dev/null

python3 - "$fixture_root" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
hooks = json.loads((root / "codex-home/hooks.json").read_text())
session_hooks = hooks["hooks"]["SessionStart"]
assert len(session_hooks) == 2, session_hooks
assert (root / "evidence/user-hook.log").read_text().count("user-hook") >= 2
assert json.loads((root / "evidence/external.jsonl").read_text().splitlines()[-1])["managed"] is False
for skill in (
    root / "codex-home/skills/tessera-cli/SKILL.md",
    root / "claude-home/skills/tessera-cli/SKILL.md",
    root / "xdg-config/opencode/skills/tessera-cli/SKILL.md",
):
    assert skill.is_file(), skill
launch = json.loads((root / "evidence/launches.jsonl").read_text().splitlines()[-1])
assert launch["home"] == str(root / "codex-home") and launch["legacyOverlay"] is None
control = json.loads((root / "evidence/control-ran.json").read_text())
assert control["statusCode"] == 0 and control["statusOk"]
assert control["projectScoped"] and control["callerWorktreeId"] is None
assert control["listCode"] == 0 and control["listedWorktrees"] == 0
assert control["createCode"] == 1 and control["createError"] == "CONTROL_AUTHORITY_DENIED"
assert control["auditCode"] == 0 and control["auditRecords"] >= 1
assert control["foreignCode"] == 1 and control["foreignError"] == "CONTROL_AUTHORITY_DENIED"
assert all({"projectId", "sourceSessionId", "operation", "target", "occurredAt", "outcome"} <= set(row) for row in control["auditMetadata"])
PY

before_restart_history=$(wc -l <"$fixture_root/codex-home/history.jsonl")
before_restart_transitions=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$fixture_root/codex-home/.fixture-transitions.json")
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$stopper")" \
  -SessionId "$session_id" -TestRoot "$test_root_windows" >"$fixture_root/evidence/stop-for-restart.json"
launched=0

restart_json="$fixture_root/evidence/instances-restart.json"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$launcher")" \
  -Executable "$executable_windows" -Count 1 -SessionId "$session_id" \
  -TestRoot "$test_root_windows" \
  -SeedDataDir "$(wslpath -w "$fixture_root/tessera-data")" -WslDistro Ubuntu-24.04 \
  | tr -d '\r' >"$restart_json"
launched=1
cdp=$(parse_instance "$restart_json" cdpUrl)
run_driver "$cdp" lifecycle-status --expect-health=healthy --expect-trust=trusted \
  --expect-state=installed >"$fixture_root/evidence/restart-status.json"
run_driver "$cdp" terminal-create "--session-id=$managed_session" "--work-dir=$repo" \
  >"$fixture_root/evidence/restart-terminal.json"
after_restart_history=$(wc -l <"$fixture_root/codex-home/history.jsonl")
((after_restart_history > before_restart_history)) || { printf 'Provider history did not survive restart\n' >&2; exit 10; }
python3 - "$fixture_root" "$before_restart_transitions" <<'PY'
import json, pathlib, sys
root, before = pathlib.Path(sys.argv[1]), int(sys.argv[2])
transitions = json.loads((root / "codex-home/.fixture-transitions.json").read_text())
auth = json.loads((root / "codex-home/auth.json").read_text())
mcp = json.loads((root / "codex-home/mcp-state.json").read_text())
config = (root / "codex-home/config.toml").read_text()
assert len(transitions) > before
assert auth["fixture"] == "synthetic-auth" and auth["refresh"] == len(transitions)
assert mcp["fixture-mcp"]["enabled"] is True and isinstance(mcp["fixture-mcp"]["authenticated"], bool)
assert transitions[-1] in config
PY

run_driver "$cdp" skills-remove >"$fixture_root/evidence/skills-optional-remove.json"
run_driver "$cdp" create-only "--work-dir=$repo" >"$fixture_root/evidence/create-no-skills.json"
no_skills_session=$(jq -r '.created.body.sessionId' "$fixture_root/evidence/create-no-skills.json")
run_driver "$cdp" terminal-create "--session-id=$no_skills_session" "--work-dir=$repo" >"$fixture_root/evidence/launch-no-skills.json"
run_driver "$cdp" skills-install >"$fixture_root/evidence/skills-optional-reinstall.json"

run_driver "$cdp" create-only "--work-dir=$repo" >"$fixture_root/evidence/create-legacy.json"
legacy_session=$(jq -r '.created.body.sessionId' "$fixture_root/evidence/create-legacy.json")
run_driver "$cdp" create-only "--work-dir=$repo" >"$fixture_root/evidence/create-derived.json"
derived_session=$(jq -r '.created.body.sessionId' "$fixture_root/evidence/create-derived.json")
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$stopper")" \
  -SessionId "$session_id" -TestRoot "$test_root_windows" >"$fixture_root/evidence/stop-for-legacy-seed.json"
launched=0

python3 - "$data_dir_wsl/tessera.db" "$fixture_root" "$wsl_state_root" "$legacy_session" "$derived_session" <<'PY'
import json, pathlib, sqlite3, sys
db_path, fixture, state, legacy, derived = sys.argv[1:]
fixture = pathlib.Path(fixture)
account_sessions = fixture / "codex-home/sessions/2026/08/12"
account_sessions.mkdir(parents=True, exist_ok=True)
now = "2026-08-12T00:00:00.000Z"
rows = [
    (legacy, "legacy-provider-349", pathlib.Path(state) / "codex-overlay" / f"session-{legacy}" / "sessions/2026/08/12/rollout-legacy-provider-349.jsonl"),
    (derived, "derived-provider-349", pathlib.Path(state) / "codex-overlay" / "session-parent-349" / "sessions/2026/08/12/rollout-derived-provider-349.jsonl"),
]
with sqlite3.connect(db_path) as db:
    for session, provider, transcript in rows:
        db.execute("UPDATE sessions SET provider_state = ? WHERE id = ?", (json.dumps({"kind": "terminal", "codexSessionId": provider}), session))
        db.execute("INSERT OR REPLACE INTO terminal_provider_sessions(provider_id,provider_session_id,tessera_session_id,transcript_path,created_at,updated_at) VALUES(?,?,?,?,?,?)", ("codex", provider, session, str(transcript), now, now))
        (account_sessions / f"rollout-{provider}.jsonl").write_text(json.dumps({"type":"session_meta","payload":{"id":provider,"session_id":provider}}) + "\n")
PY
rm -f "$fixture_root/evidence/control-ran.json"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$launcher")" \
  -Executable "$executable_windows" -Count 1 -SessionId "$session_id" \
  -TestRoot "$test_root_windows" \
  -SeedDataDir "$(wslpath -w "$fixture_root/tessera-data")" -WslDistro Ubuntu-24.04 \
  | tr -d '\r' >"$fixture_root/evidence/instances-legacy.json"
launched=1
cdp=$(parse_instance "$fixture_root/evidence/instances-legacy.json" cdpUrl)
run_driver "$cdp" terminal-create "--session-id=$legacy_session" "--work-dir=$repo" >"$fixture_root/evidence/legacy.json"
run_driver "$cdp" terminal-create "--session-id=$derived_session" "--work-dir=$repo" >"$fixture_root/evidence/derived.json"
run_driver "$cdp" terminal-create "--session-id=$managed_session" "--work-dir=$repo" >"$fixture_root/evidence/pre-degraded-running.json"

python3 - "$fixture_root" "$wsl_state_root" "$legacy_session" <<'PY'
import json, pathlib, sys
root, state, legacy = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
launches = [json.loads(line) for line in (root / "evidence/launches.jsonl").read_text().splitlines()]
legacy_row = next(row for row in launches if row["providerSessionId"] == "legacy-provider-349")
derived_row = next(row for row in launches if row["providerSessionId"] == "derived-provider-349")
legacy_home = state / "codex-overlay" / f"session-{legacy}"
assert legacy_row["home"] == str(legacy_home) and legacy_row["legacyOverlay"] == str(legacy_home) and legacy_row["resume"]
assert derived_row["home"] == str(root / "codex-home") and derived_row["legacyOverlay"] is None and derived_row["resume"]
control = json.loads((root / "evidence/control-ran.json").read_text())
assert control["auditRecords"] >= 2, control
PY

touch "$fixture_root/modes/hook-api-unavailable"
run_driver "$cdp" lifecycle-status --expect-health=blocked --expect-trust=unavailable \
  --expect-state=unavailable >"$fixture_root/evidence/degraded.json"
run_driver "$cdp" session-health "--session-id=$managed_session" --expect-health=degraded >"$fixture_root/evidence/degraded-session-health.json"
run_driver "$cdp" terminal-input "--session-id=$managed_session" --input=acceptance-degraded-control >"$fixture_root/evidence/degraded-running.json"
python3 - "$fixture_root/evidence/control-ran.json" <<'PY'
import json, pathlib, sys
control = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert control["statusCode"] == 0 and control["listCode"] == 0
assert control["createCode"] == 1 and control["createError"] == "CONTROL_AUTHORITY_DENIED"
assert control["auditRecords"] >= 3
PY
run_driver "$cdp" create-only "--work-dir=$repo" >"$fixture_root/evidence/create-blocked.json"
blocked_session=$(jq -r '.created.body.sessionId' "$fixture_root/evidence/create-blocked.json")
run_driver "$cdp" terminal-create-blocked "--session-id=$blocked_session" "--work-dir=$repo" \
  >"$fixture_root/evidence/fail-closed.json"
rm "$fixture_root/modes/hook-api-unavailable"
cp "$fixture_root/codex-home/skills/tessera-cli/SKILL.md" "$fixture_root/evidence/codex-skill-original.md"
printf '\nfixture external modification\n' >>"$fixture_root/codex-home/skills/tessera-cli/SKILL.md"
run_driver "$cdp" skills-remove-conflict >"$fixture_root/evidence/remove-incomplete.json"
cp "$fixture_root/evidence/codex-skill-original.md" "$fixture_root/codex-home/skills/tessera-cli/SKILL.md"
run_driver "$cdp" remove >"$fixture_root/evidence/remove.json"

python3 - "$fixture_root" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
hooks = json.loads((root / "codex-home/hooks.json").read_text())
session_hooks = hooks["hooks"]["SessionStart"]
assert len(session_hooks) == 1
assert "user-hook.log" in session_hooks[0]["hooks"][0]["command"]
assert "__tessera" not in json.dumps(hooks)
for skill in (
    root / "codex-home/skills/tessera-cli",
    root / "claude-home/skills/tessera-cli",
    root / "xdg-config/opencode/skills/tessera-cli",
):
    assert not skill.exists(), skill
PY

[[ $(sha256sum "$integrity_snapshot" | awk '{print $1}') == "$integrity_snapshot_sha256" ]] || {
  printf 'Integrity invariant changed: protected evidence snapshot\n' >&2
  exit 20
}
python3 "$integrity_checker" verify \
  --agent-home "$agent_home" --native-home "$native_home" --snapshot "$integrity_snapshot" \
  || exit 20

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$stopper")" \
  -SessionId "$session_id" -TestRoot "$test_root_windows" -RemoveData >/dev/null
launched=0
owned_session=0
remove_owned_test_root
[[ ! -e $fixture_root ]] || { printf 'Fixture cleanup incomplete\n' >&2; exit 22; }
[[ ! -e $wsl_state_root ]] || { printf 'WSL state cleanup incomplete\n' >&2; exit 23; }
[[ ! -e $data_dir_wsl ]] || { printf 'Windows copied data cleanup incomplete\n' >&2; exit 24; }
if powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort $server_port -ErrorAction SilentlyContinue) { exit 1 }"; then :; else
  printf 'Packaged server port remains open\n' >&2; exit 25
fi
after_installed=$(installed_snapshot)
[[ $before_installed == "$after_installed" ]] || { printf 'Installed Tessera process/port invariant changed\n' >&2; exit 26; }
if powershell.exe -NoProfile -Command "if (Test-Path -LiteralPath '$test_root_windows') { exit 1 }"; then :; else
  printf 'Windows acceptance test root cleanup incomplete\n' >&2; exit 28
fi

gio trash "$artifact_wsl" "$app_dir_wsl"
[[ ! -e $artifact_wsl && ! -e $app_dir_wsl ]] || { printf 'Downloads artifact cleanup incomplete\n' >&2; exit 27; }
artifact_wsl=
app_dir_wsl=
if [[ -n $package_output && -e $package_output ]]; then
  gio trash "$package_output"
  package_output=
fi
final_cleanup=1
trap - EXIT

printf '{"issue":349,"packagedTopology":"windows-electron/windows-backend/wsl-agent","build":"debug","packagedLogLevel":"%s","sessionId":"%s","serverPort":%s,"artifactSha256":"%s","launchExecutableSha256":"%s","assertionsPassed":true,"cleanupComplete":true}\n' \
  "$packaged_log_level" "$session_id" "$server_port" "$artifact_sha256" "$launch_executable_sha256"
