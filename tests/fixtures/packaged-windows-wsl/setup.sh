#!/bin/sh
set -eu

root=${1:-}
case "$root" in
  /home/*/.tessera/test-fixtures/[A-Za-z0-9]*) ;;
  *) printf '%s\n' "unsafe fixture root: $root" >&2; exit 2 ;;
esac
if [ -e "$root" ]; then
  printf '%s\n' "fixture root already exists: $root" >&2
  exit 3
fi

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$root/bin" "$root/shell" "$root/evidence" "$root/modes" \
  "$root/codex-home" "$root/claude-home" "$root/xdg-config/opencode" \
  "$root/xdg-data/opencode" \
  "$root/tessera-data"
: > "$root/tessera-data/tessera.db"
install -m 700 "$source_dir/fake-codex.py" "$root/bin/codex"
install -m 700 "$source_dir/fake-claude.sh" "$root/bin/claude"
install -m 700 "$source_dir/fake-opencode.sh" "$root/bin/opencode"
install -m 600 "$source_dir/zshenv" "$root/shell/.zshenv"

/usr/bin/python3 - "$root" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
codex_home = root / "codex-home"
(codex_home / "auth.json").write_text(
    json.dumps({"fixture": "synthetic-auth", "credential": "not-a-secret"}) + "\n",
    encoding="utf-8",
)
(codex_home / "config.toml").write_text('fixture_mode = "initial"\n', encoding="utf-8")
(codex_home / "mcp-state.json").write_text(
    json.dumps({"fixture-mcp": {"enabled": True, "authenticated": False}}) + "\n",
    encoding="utf-8",
)
(codex_home / "history.jsonl").write_text(
    json.dumps({"event": "fixture-created"}) + "\n",
    encoding="utf-8",
)
user_command = (
    "payload=$(cat); "
    "printf '%s\\n' user-hook >> "
    '"$TESSERA_ACCEPTANCE_FIXTURE_ROOT/evidence/user-hook.log"'
)
hooks = {
    "hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "timeout": 10, "command": user_command}]}]
    }
}
(codex_home / "hooks.json").write_text(json.dumps(hooks, indent=2) + "\n", encoding="utf-8")
PY

printf '%s\n' "$root"
