#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  runner-evidence.sh create AGENT_HOME SESSION_ID OWNER_TOKEN
  runner-evidence.sh remove AGENT_HOME SESSION_ID OWNER_TOKEN ROOT
EOF
}

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

(($# >= 4)) || { usage >&2; exit 2; }
action=$1
agent_home=$2
session_id=$3
owner_token=$4

[[ $agent_home =~ ^/home/[A-Za-z0-9._-]+$ ]] || fail 'Runner evidence requires a WSL /home directory'
[[ $session_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$ ]] || fail 'Unsafe runner evidence session id'
[[ $owner_token =~ ^[A-Fa-f0-9]{32}$ ]] || fail 'Runner evidence requires an exact GUID-N ownership token'

evidence_root="$agent_home/.tessera/test-fixtures/$session_id.runner"
owner_marker="$evidence_root/.tessera-owner"

case "$action" in
  create)
    (($# == 4)) || { usage >&2; exit 2; }
    mkdir -p "$agent_home/.tessera/test-fixtures"
    [[ ! -e $evidence_root ]] || fail "Runner evidence root already exists: $evidence_root"
    mkdir -m 700 "$evidence_root"
    if ! (umask 077; printf '%s\n' "$owner_token" >"$owner_marker"); then
      rm -rf -- "$evidence_root"
      fail "Cannot mark runner evidence root: $evidence_root"
    fi
    printf '%s\n' "$evidence_root"
    ;;
  remove)
    (($# == 5)) || { usage >&2; exit 2; }
    requested_root=$5
    [[ $requested_root == "$evidence_root" ]] || fail "Refusing to remove non-owned runner evidence root: $requested_root"
    [[ -f $owner_marker ]] || fail "Runner evidence owner marker is missing: $owner_marker"
    [[ $(wc -c <"$owner_marker") -eq 33 && $(wc -l <"$owner_marker") -eq 1 ]] \
      || fail "Runner evidence owner marker is malformed: $owner_marker"
    IFS= read -r recorded_owner <"$owner_marker"
    [[ $recorded_owner == "$owner_token" ]] || fail "Runner evidence owner mismatch: $evidence_root"
    rm -rf -- "$evidence_root"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
