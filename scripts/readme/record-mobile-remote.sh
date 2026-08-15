#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
seed_dir=/home/work/.tessera_demo
output_dir="$repo_root/docs/assets/readme"
gif="$output_dir/mobile-remote.gif"
webm=""
candidate_gif=""
palette=""
contact_sheet=/home/work/tmp/tessera-readme-mobile-final-contact-sheet.png
server_pid=""
session_name="readme-mobile-remote-$$"

fail() {
  printf 'record-mobile-remote: %s\n' "$*" >&2
  exit 1
}

command -v playwright-cli >/dev/null || fail 'playwright-cli is required'
command -v ffmpeg >/dev/null || fail 'ffmpeg is required'
command -v montage >/dev/null || fail 'ImageMagick montage is required'
command -v sqlite3 >/dev/null || fail 'sqlite3 is required'
command -v codex >/dev/null || fail 'codex is required'
command -v jq >/dev/null || fail 'jq is required'
test -d "$repo_root/node_modules" || fail 'run npm ci first'
test -f "$repo_root/.next/BUILD_ID" || fail 'run npm run build first'
test -f "$seed_dir/tessera.db" || fail "missing read-only seed: $seed_dir/tessera.db"

seed_before=$(sha256sum "$seed_dir/tessera.db" "$seed_dir/tessera-dev.db" | sha256sum | cut -d' ' -f1)
run_root=$(mktemp -d /home/work/tmp/tessera-readme-mobile-recording-XXXXXX)
webm="$run_root/mobile-remote.webm"
candidate_gif="$run_root/mobile-remote.gif"
data_dir="$run_root/data"
demo_home="$run_root/home"
server_log="$run_root/server.log"
safe_project="$run_root/mobile-demo"
palette="$run_root/palette.png"
mkdir -p "$data_dir" "$demo_home/.codex" "$safe_project" "$output_dir"
cp -a "$seed_dir/." "$data_dir"
cp -a /home/work/.codex/auth.json /home/work/.codex/config.toml "$demo_home/.codex/"
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

clean_path="$repo_root/node_modules/.bin:/home/work/.local/bin:$(dirname "$(command -v node)"):/usr/bin:/bin"

start_server() {
  setsid env \
    -u TESSERA_APP_ROOT -u TESSERA_ELECTRON_SERVER -u TESSERA_ELECTRON_RUNTIME -u TESSERA_ENV \
    -u ELECTRON_CHILD -u ELECTRON_RUN_AS_NODE -u TESSERA_HOOK_PORT \
    -u TESSERA_PANE_TOKEN -u TESSERA_SESSION_ID -u TESSERA_PROJECT_ID \
    -u TESSERA_WORKTREE_ID -u TESSERA_CLI_COMMAND -u TESSERA_CODEX_HOME -u CODEX_HOME \
    HOME="$demo_home" ZDOTDIR="$demo_home" PS1='demo $ ' PATH="$clean_path" \
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production HOST=127.0.0.1 PORT="$port" \
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
source_project_id=$(sqlite3 "$db" "select id from projects where display_name='browser-operator' and id like '/home/work/%' limit 1")
test -n "$source_project_id" || fail 'the demo seed no longer contains browser-operator'
project_worktree_id=$(sqlite3 "$db" "select project_worktree_id from projects where id='$source_project_id'")
test -n "$project_worktree_id" || fail 'browser-operator has no canonical Worktree'

# Create one real Codex transcript in the isolated home. Tessera then opens the
# same conversation first as a live PTY and again through PTY Chat View.
mobile_codex_output=$(
  cd "$safe_project"
  env \
    -u TESSERA_ENV -u TESSERA_CLI_COMMAND -u TESSERA_PROJECT_ID -u TESSERA_WORKTREE_ID \
    -u TESSERA_PANE_TOKEN -u TESSERA_SESSION_ID -u TESSERA_HOOK_PORT -u TESSERA_CODEX_HOME \
    HOME="$demo_home" CODEX_HOME="$demo_home/.codex" \
    codex exec --json --model gpt-5.6-sol -c model_reasoning_effort='medium' \
      --sandbox read-only --skip-git-repo-check \
      'Reply with exactly three short bullets: Review sessions; Inspect changes; Continue work.'
)
codex_thread_id=$(printf '%s\n' "$mobile_codex_output" \
  | jq -Rr 'fromjson? | select(.type == "thread.started") | .thread_id' \
  | head -1)
test -n "$codex_thread_id" || fail 'failed to create the isolated PTY transcript'

readonly pty_session_id=8f65ef64-39b7-4e52-9fb0-bf90bcf356b7
readonly gui_session_id=3635d1db-772c-4669-b5e8-12d756ec323e
readonly gui_source_session_id=acd4f912-392b-4a24-b9bc-783883bc9c8c

sqlite3 "$db" <<SQL
PRAGMA foreign_keys=OFF;
BEGIN;
DELETE FROM sessions WHERE id IN ('$pty_session_id', '$gui_session_id');

CREATE TEMP TABLE staged_pty AS
SELECT * FROM sessions WHERE id='d63956c6-4b2d-4203-8ca0-b2ebca25deb5';
UPDATE staged_pty
SET id='$pty_session_id',
    project_id='$source_project_id',
    title='Mobile PTY workflow',
    has_custom_title=1,
    provider='codex',
    provider_state='{"kind":"terminal","launched":true,"codexSessionId":"$codex_thread_id"}',
    work_dir='$safe_project',
    worktree_branch=NULL,
    worktree_managed=0,
    worktree_id='$project_worktree_id',
    scope_branch=NULL,
    archived=0,
    archived_at=NULL,
    worktree_deleted_at=NULL,
    deleted=0,
    task_id=NULL,
    collection_id='col_bd2bd90f',
    sort_order=-2,
    created_at='2026-08-15T12:00:00.000Z',
    updated_at='2026-08-15T12:00:02.000Z',
    model='gpt-5.6-sol',
    reasoning_effort='medium';
INSERT INTO sessions SELECT * FROM staged_pty;
DROP TABLE staged_pty;

CREATE TEMP TABLE staged_gui AS
SELECT * FROM sessions WHERE id='$gui_source_session_id';
UPDATE staged_gui
SET id='$gui_session_id',
    project_id='$source_project_id',
    title='Mobile GUI workflow',
    has_custom_title=1,
    worktree_branch=NULL,
    worktree_managed=0,
    worktree_id='$project_worktree_id',
    scope_branch=NULL,
    archived=0,
    archived_at=NULL,
    worktree_deleted_at=NULL,
    deleted=0,
    task_id=NULL,
    collection_id='col_bd2bd90f',
    sort_order=-1,
    created_at='2026-08-15T12:00:01.000Z',
    updated_at='2026-08-15T12:00:01.000Z';
INSERT INTO sessions SELECT * FROM staged_gui;
DROP TABLE staged_gui;
COMMIT;
SQL

cp -a "$seed_dir/session-history/$gui_source_session_id.jsonl" \
  "$data_dir/session-history/$gui_session_id.jsonl"

for session_id in \
  acd4f912-392b-4a24-b9bc-783883bc9c8c \
  230084a9-6d71-4124-8f9f-310195947560; do
  cmp -s "$seed_dir/session-history/$session_id.jsonl" "$data_dir/session-history/$session_id.jsonl" \
    || fail "copied session history changed: $session_id"
done

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

cd "$repo_root"
playwright-cli -s="$session_name" run-code --filename scripts/readme/mobile-remote.prepare.js >/dev/null
playwright-cli -s="$session_name" video-start "$webm" --size "390x844" >/dev/null
recording_started_page_ms=$(playwright-cli -s="$session_name" --raw eval "performance.now()")
playwright-cli -s="$session_name" run-code --filename scripts/readme/mobile-remote.hero.js
demo_complete=$(playwright-cli -s="$session_name" --raw eval \
  "document.documentElement.dataset.readmeMobileDemoComplete === 'true'")
test "$demo_complete" = "true" || fail 'mobile hero did not reach its verified final scene'
hero_finished_page_ms=$(playwright-cli -s="$session_name" --raw eval \
  "Number(document.documentElement.dataset.readmeMobileDemoCompleteAt)")
playwright-cli -s="$session_name" video-stop >/dev/null
playwright-cli -s="$session_name" close >/dev/null

# Playwright takes several seconds to finalize a video after the hero has
# already finished. Keep a small end beat, but remove that mechanical tail.
max_duration=$(awk \
  -v started="$recording_started_page_ms" \
  -v finished="$hero_finished_page_ms" \
  'BEGIN {
    duration = (finished - started) / 1000 + 0.80
    if (duration <= 0) exit 1
    if (duration > 24) duration = 24
    printf "%.3f", duration
  }')

ffmpeg -y -v error -t "$max_duration" -i "$webm" -vf \
  "fps=12,palettegen=max_colors=128:stats_mode=diff" "$palette"
ffmpeg -y -v error -t "$max_duration" -i "$webm" -i "$palette" -lavfi \
  "[0:v]fps=12[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$candidate_gif"

duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$candidate_gif")
for fraction in 0.10 0.35 0.60 0.85; do
  sample=$(awk -v duration="$duration" -v fraction="$fraction" 'BEGIN { printf "%.2f", duration * fraction }')
  sample_name=${fraction/./-}
  ffmpeg -y -v error -ss "$sample" -i "$candidate_gif" -frames:v 1 "$run_root/contact-$sample_name.png"
done
montage \
  "$run_root/contact-0-10.png" \
  "$run_root/contact-0-35.png" \
  "$run_root/contact-0-60.png" \
  "$run_root/contact-0-85.png" \
  -tile 2x2 -geometry 390x844+12+12 \
  -background '#0b0b0b' "$contact_sheet"

seed_after=$(sha256sum "$seed_dir/tessera.db" "$seed_dir/tessera-dev.db" | sha256sum | cut -d' ' -f1)
test "$seed_before" = "$seed_after" || fail 'read-only demo seed changed during recording'
for session_id in \
  acd4f912-392b-4a24-b9bc-783883bc9c8c \
  230084a9-6d71-4124-8f9f-310195947560; do
  cmp -s "$seed_dir/session-history/$session_id.jsonl" "$data_dir/session-history/$session_id.jsonl" \
    || fail "session history changed during recording: $session_id"
done
test "$(stat -c %s "$candidate_gif")" -lt 8388608 || fail 'GIF exceeds 8 MiB'

ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$candidate_gif"
identify -format 'width=%w\nheight=%h\nframes=%n\n' "$candidate_gif" | awk 'NR <= 3'
cp -f "$candidate_gif" "$gif"
printf 'seed_sha256=%s\n' "$seed_after"
printf 'contact_sheet=%s\n' "$contact_sheet"
