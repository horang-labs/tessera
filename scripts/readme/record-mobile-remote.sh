#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
seed_dir=/home/work/.tessera_demo
output_dir="$repo_root/docs/assets/readme"
webm="$output_dir/mobile-remote.webm"
gif="$output_dir/mobile-remote.gif"
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
test -d "$repo_root/node_modules" || fail 'run npm ci first'
test -f "$repo_root/.next/BUILD_ID" || fail 'run npm run build first'
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

sqlite3 "$db" <<SQL
PRAGMA foreign_keys=OFF;
BEGIN;
UPDATE projects
SET id='$safe_project', decoded_path='$safe_project', visible=1, sort_order=0
WHERE id='$source_project_id';
UPDATE projects SET visible=0 WHERE id <> '$safe_project';
UPDATE sessions
SET project_id='$safe_project',
    work_dir=CASE
      WHEN work_dir='$source_project_id' THEN '$safe_project'
      WHEN work_dir LIKE '/home/work/.tessera_demo/worktrees/browser-operator/%'
        THEN replace(work_dir, '/home/work/.tessera_demo/worktrees/browser-operator/', '$safe_project/')
      ELSE work_dir
    END
WHERE project_id='$source_project_id';
UPDATE tasks
SET project_id='$safe_project',
    worktree_path=CASE
      WHEN worktree_path='$source_project_id' THEN '$safe_project'
      WHEN worktree_path LIKE '/home/work/.tessera_demo/worktrees/browser-operator/%'
        THEN replace(worktree_path, '/home/work/.tessera_demo/worktrees/browser-operator/', '$safe_project/')
      ELSE worktree_path
    END
WHERE project_id='$source_project_id';
UPDATE collections SET project_id='$safe_project' WHERE project_id='$source_project_id';
UPDATE worktrees
SET filesystem_path=CASE
      WHEN filesystem_path='$source_project_id' THEN '$safe_project'
      WHEN filesystem_path LIKE '/home/work/.tessera_demo/worktrees/browser-operator/%'
        THEN replace(filesystem_path, '/home/work/.tessera_demo/worktrees/browser-operator/', '$safe_project/')
      ELSE filesystem_path
    END,
    canonical_path_key=CASE
      WHEN canonical_path_key='$source_project_id' THEN '$safe_project'
      WHEN canonical_path_key LIKE '/home/work/.tessera_demo/worktrees/browser-operator/%'
        THEN replace(canonical_path_key, '/home/work/.tessera_demo/worktrees/browser-operator/', '$safe_project/')
      ELSE canonical_path_key
    END
WHERE filesystem_path='$source_project_id'
   OR filesystem_path LIKE '/home/work/.tessera_demo/worktrees/browser-operator/%';
COMMIT;
SQL

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
playwright-cli -s="$session_name" run-code --filename scripts/readme/mobile-remote.hero.js
playwright-cli -s="$session_name" video-stop >/dev/null
playwright-cli -s="$session_name" close >/dev/null

ffmpeg -y -v error -i "$webm" -vf \
  "crop=358:844:32:0,fps=12,palettegen=max_colors=128:stats_mode=diff" "$palette"
ffmpeg -y -v error -i "$webm" -i "$palette" -lavfi \
  "crop=358:844:32:0,fps=12[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$gif"

for sample in 0.5 2.8 6.3 10.5; do
  sample_name=${sample/./-}
  ffmpeg -y -v error -ss "$sample" -i "$gif" -frames:v 1 "$run_root/contact-$sample_name.png"
done
montage \
  "$run_root/contact-0-5.png" \
  "$run_root/contact-2-8.png" \
  "$run_root/contact-6-3.png" \
  "$run_root/contact-10-5.png" \
  -tile 2x2 -geometry 358x844+12+12 \
  -background '#0b0b0b' "$contact_sheet"

seed_after=$(sha256sum "$seed_dir/tessera.db" "$seed_dir/tessera-dev.db" | sha256sum | cut -d' ' -f1)
test "$seed_before" = "$seed_after" || fail 'read-only demo seed changed during recording'
for session_id in \
  acd4f912-392b-4a24-b9bc-783883bc9c8c \
  230084a9-6d71-4124-8f9f-310195947560; do
  cmp -s "$seed_dir/session-history/$session_id.jsonl" "$data_dir/session-history/$session_id.jsonl" \
    || fail "session history changed during recording: $session_id"
done
test "$(stat -c %s "$gif")" -lt 8388608 || fail 'GIF exceeds 8 MiB'

ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$gif"
identify -format 'width=%w\nheight=%h\nframes=%n\n' "$gif" | head -3
printf 'seed_sha256=%s\n' "$seed_after"
printf 'contact_sheet=%s\n' "$contact_sheet"
