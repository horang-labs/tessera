#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
seed_dir=/home/work/.tessera_demo
output_dir="$repo_root/docs/assets/readme"
webm="$output_dir/mobile-remote.webm"
gif="$output_dir/mobile-remote.gif"
palette=""
server_pid=""
session_name="readme-mobile-remote-$$"

fail() {
  printf 'record-mobile-remote: %s\n' "$*" >&2
  exit 1
}

command -v playwright-cli >/dev/null || fail 'playwright-cli is required'
command -v ffmpeg >/dev/null || fail 'ffmpeg is required'
command -v sqlite3 >/dev/null || fail 'sqlite3 is required'
test -d "$repo_root/node_modules" || fail 'run npm ci first'
test -f "$seed_dir/tessera.db" || fail "missing read-only seed: $seed_dir/tessera.db"

seed_before=$(sha256sum "$seed_dir/tessera.db" "$seed_dir/tessera-dev.db" | sha256sum | cut -d' ' -f1)
run_root=$(mktemp -d /home/work/tmp/tessera-readme-mobile-recording-XXXXXX)
data_dir="$run_root/data"
demo_home="$run_root/home"
server_log="$run_root/server.log"
safe_project=/tmp/tessera-mobile-demo
palette="$run_root/palette.png"
mkdir -p "$data_dir" "$demo_home" "$safe_project" "$output_dir"
cp -a "$seed_dir/." "$data_dir"
git -C "$safe_project" init -b main >/dev/null 2>&1 || true

port=$(node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => process.stdout.write(String(port)));
});
NODE
)
origin="http://127.0.0.1:$port"

clean_path="$repo_root/node_modules/.bin:$(dirname "$(command -v node)"):/usr/bin:/bin"

start_server() {
  setsid env \
    -u TESSERA_APP_ROOT -u TESSERA_ELECTRON_SERVER -u TESSERA_ELECTRON_RUNTIME \
    -u ELECTRON_CHILD -u ELECTRON_RUN_AS_NODE -u TESSERA_HOOK_PORT \
    -u TESSERA_PANE_TOKEN -u TESSERA_SESSION_ID -u TESSERA_PROJECT_ID \
    -u TESSERA_WORKTREE_ID -u TESSERA_CLI_COMMAND -u TESSERA_CODEX_HOME -u CODEX_HOME \
    HOME="$demo_home" ZDOTDIR="$demo_home" PS1='demo $ ' PATH="$clean_path" \
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=development HOST=127.0.0.1 PORT="$port" \
    TESSERA_DATA_DIR="$data_dir" TESSERA_PRODUCTION_DB=1 LOG_LEVEL=error \
    node "$repo_root/node_modules/.bin/tsx" "$repo_root/server.ts" >"$server_log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 240); do
    if curl -fsS "$origin/login" >/dev/null 2>&1; then return; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      tail -80 "$server_log" >&2
      fail 'isolated server exited during startup'
    fi
    sleep .25
  done
  tail -80 "$server_log" >&2
  fail 'isolated server did not become ready'
}

stop_server() {
  if [[ "$server_pid" =~ ^[0-9]+$ ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -- -"$server_pid" 2>/dev/null || kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=""
}

cleanup() {
  playwright-cli -s="$session_name" close >/dev/null 2>&1 || true
  stop_server
  rm -f "$webm"
  if [[ "$run_root" == /home/work/tmp/tessera-readme-mobile-recording-* ]]; then
    rm -rf "$run_root"
  fi
}
trap cleanup EXIT INT TERM

# First boot applies the current schema migrations to the private copy only.
start_server
stop_server

db="$data_dir/tessera.db"
source_project_id=$(sqlite3 "$db" "select id from projects where display_name='browser-operator' limit 1")
test -n "$source_project_id" || fail 'the demo seed no longer contains browser-operator'
project_worktree_id=$(sqlite3 "$db" "select project_worktree_id from projects where id='$source_project_id' limit 1")
test -n "$project_worktree_id" || fail 'the demo project has no project Worktree identity'

sqlite3 "$db" <<SQL
PRAGMA foreign_keys=OFF;
BEGIN;
UPDATE projects
SET id='$safe_project', decoded_path='$safe_project', display_name='Tessera Mobile', visible=1
WHERE id='$source_project_id';
UPDATE projects SET visible=0 WHERE id <> '$safe_project';
UPDATE worktrees SET filesystem_path='$safe_project', canonical_path_key='$safe_project'
WHERE id='$project_worktree_id';
UPDATE sessions
SET project_id='$safe_project', work_dir='$safe_project', deleted=1
WHERE project_id='$source_project_id';
UPDATE sessions SET deleted=0, archived=0, task_id=NULL, collection_id=NULL,
  chat_workflow_status='chat', title='Mobile terminal polish', sort_order=0,
  worktree_id='$project_worktree_id', scope_branch='main', worktree_branch='main', worktree_managed=0
WHERE id='8ace6e58-8689-4694-9ff6-3c9123db6561';
UPDATE sessions SET deleted=0, archived=0, task_id=NULL, collection_id=NULL,
  chat_workflow_status='chat', title='Session tabs on phone', sort_order=1,
  worktree_id='$project_worktree_id', scope_branch='main', worktree_branch='main', worktree_managed=0
WHERE id='d63956c6-4b2d-4203-8ca0-b2ebca25deb5';
UPDATE sessions SET deleted=0, archived=0, task_id=NULL, collection_id=NULL,
  chat_workflow_status='chat', title='Image attachment flow', sort_order=2,
  worktree_id='$project_worktree_id', scope_branch='main', worktree_branch='main', worktree_managed=0
WHERE id='8924f1c3-ae70-43d6-bea4-fe97c84dee2c';
UPDATE sessions SET deleted=0, archived=0, task_id=NULL, collection_id=NULL,
  chat_workflow_status='chat', title='Responsive navigation', sort_order=3,
  worktree_id='$project_worktree_id', scope_branch='main', worktree_branch='main', worktree_managed=0
WHERE id='060dd68b-0f5b-466d-ac25-e7ce7eb51079';
DELETE FROM tasks;
DELETE FROM collections;
COMMIT;
SQL

node - "$data_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dataDir = process.argv[2];
for (const name of fs.readdirSync(path.join(dataDir, 'settings'))) {
  if (!name.endsWith('.json')) continue;
  const filename = path.join(dataDir, 'settings', name);
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
  settings.theme = 'dark';
  settings.notifications = { ...(settings.notifications || {}), soundEnabled: false, showToast: false };
  settings.profile = { ...(settings.profile || {}), displayName: 'Demo' };
  fs.writeFileSync(filename, `${JSON.stringify(settings, null, 2)}\n`);
}
NODE

start_server
for _ in $(seq 1 240); do
  test -f "$data_dir/auth/private.pem" && break
  sleep .25
done
test -f "$data_dir/auth/private.pem" || fail 'isolated auth key was not created'

browser_jwt=$(node --input-type=module - "$data_dir" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
const dataDir = process.argv[2];
const [user] = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).users;
const key = fs.readFileSync(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
process.stdout.write(jwt.sign(
  { sub: user.id, username: user.username, iss: 'tessera', aud: 'tessera-users' },
  key,
  { algorithm: 'RS256', expiresIn: 3600 },
));
NODE
)

playwright-cli -s="$session_name" open "$origin/login" --persistent >/dev/null
playwright-cli -s="$session_name" resize 390 844 >/dev/null
playwright-cli -s="$session_name" cookie-set jwt "$browser_jwt" \
  --domain=127.0.0.1 --path=/ --sameSite=Lax >/dev/null
playwright-cli -s="$session_name" goto "$origin/" >/dev/null
playwright-cli -s="$session_name" localstorage-set tesseraReadmeAttachment \
  "$repo_root/docs/assets/readme/kanban-board.png" >/dev/null

cd "$repo_root"
playwright-cli -s="$session_name" run-code --filename scripts/readme/mobile-remote.prepare.js >/dev/null
playwright-cli -s="$session_name" video-start "$webm" --size "390x844" >/dev/null
playwright-cli -s="$session_name" run-code --filename scripts/readme/mobile-remote.hero.js
playwright-cli -s="$session_name" video-stop >/dev/null
playwright-cli -s="$session_name" close >/dev/null

ffmpeg -y -v error -i "$webm" -vf \
  "fps=12,scale=390:844:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" "$palette"
ffmpeg -y -v error -i "$webm" -i "$palette" -lavfi \
  "fps=12,scale=390:844:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$gif"

seed_after=$(sha256sum "$seed_dir/tessera.db" "$seed_dir/tessera-dev.db" | sha256sum | cut -d' ' -f1)
test "$seed_before" = "$seed_after" || fail 'read-only demo seed changed during recording'
test "$(stat -c %s "$gif")" -lt 8388608 || fail 'GIF exceeds 8 MiB'

ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$gif"
identify -format 'width=%w\nheight=%h\nframes=%n\n' "$gif" | head -3
printf 'seed_sha256=%s\n' "$seed_after"
