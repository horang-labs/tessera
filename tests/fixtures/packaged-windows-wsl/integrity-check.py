#!/usr/bin/env python3
"""Capture and verify packaged-acceptance user-state invariants.

The snapshot contains only presence markers and content digests. Codex marketplace
refresh timestamps/revisions are provider-owned concurrent metadata; all other
configuration values remain protected.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import json
import math
import os
import pathlib
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from typing import Any, Callable


SNAPSHOT_VERSION = 1
MARKETPLACE_REFRESH_FIELDS = frozenset({"last_updated", "last_revision"})


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    label: str
    home: str
    relative_path: str
    evidence: Callable[[pathlib.Path], dict[str, str]]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_evidence(path: pathlib.Path) -> dict[str, str]:
    if not path.exists():
        return {"state": "absent"}
    if not path.is_file():
        return {"state": "unexpected-type"}
    return {"state": "file", "sha256": _sha256(path.read_bytes())}


def _canonical_toml_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _canonical_toml_value(value[key])
            for key in sorted(value)
        }
    if isinstance(value, list):
        return [_canonical_toml_value(item) for item in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return {"toml_type": type(value).__name__, "value": value.isoformat()}
    if isinstance(value, float) and not math.isfinite(value):
        return {"toml_type": "float", "value": repr(value)}
    return value


def _codex_config_evidence(path: pathlib.Path) -> dict[str, str]:
    if not path.exists():
        return {"state": "absent"}
    if not path.is_file():
        return {"state": "unexpected-type"}
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise RuntimeError(f"cannot parse protected Codex configuration {path}: {error}") from error

    protected = copy.deepcopy(config)
    marketplaces = protected.get("marketplaces")
    if isinstance(marketplaces, dict):
        for marketplace in marketplaces.values():
            if isinstance(marketplace, dict):
                for field in MARKETPLACE_REFRESH_FIELDS:
                    marketplace.pop(field, None)

    canonical = json.dumps(
        _canonical_toml_value(protected),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return {"state": "toml", "protected_sha256": _sha256(canonical)}


def _directory_evidence(path: pathlib.Path) -> dict[str, str]:
    if not path.exists():
        return {"state": "absent"}
    if not path.is_dir():
        return {"state": "unexpected-type"}

    entries: list[dict[str, str]] = []
    for current_root, directory_names, file_names in os.walk(path, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current = pathlib.Path(current_root)
        for name in directory_names:
            entry = current / name
            relative = entry.relative_to(path).as_posix()
            if entry.is_symlink():
                entries.append({"path": relative, "type": "symlink", "target": os.readlink(entry)})
            else:
                entries.append({"path": relative, "type": "directory"})
        for name in file_names:
            entry = current / name
            relative = entry.relative_to(path).as_posix()
            if entry.is_symlink():
                entries.append({"path": relative, "type": "symlink", "target": os.readlink(entry)})
            elif entry.is_file():
                entries.append({"path": relative, "type": "file", "sha256": _sha256(entry.read_bytes())})
            else:
                entries.append({"path": relative, "type": "unexpected"})

    canonical = json.dumps(entries, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {"state": "directory", "tree_sha256": _sha256(canonical)}


ARTIFACTS = (
    Artifact("database-development", "source database ~/.tessera/tessera-dev.db", "agent", ".tessera/tessera-dev.db", _file_evidence),
    Artifact("database-production", "source database ~/.tessera/tessera.db", "agent", ".tessera/tessera.db", _file_evidence),
    Artifact("codex-credential", "provider credential ~/.codex/auth.json", "agent", ".codex/auth.json", _file_evidence),
    Artifact("codex-config", "provider configuration ~/.codex/config.toml", "agent", ".codex/config.toml", _codex_config_evidence),
    Artifact("codex-hooks", "user hook ~/.codex/hooks.json", "agent", ".codex/hooks.json", _file_evidence),
    Artifact("claude-credential", "provider credential ~/.claude/.credentials.json", "agent", ".claude/.credentials.json", _file_evidence),
    Artifact("claude-config", "provider configuration ~/.claude/settings.json", "agent", ".claude/settings.json", _file_evidence),
    Artifact("opencode-credential", "provider credential ~/.local/share/opencode/auth.json", "agent", ".local/share/opencode/auth.json", _file_evidence),
    Artifact("native-codex-skill", "native provider skill ~/.codex/skills/tessera-cli", "native", ".codex/skills/tessera-cli", _directory_evidence),
    Artifact("native-claude-skill", "native provider skill ~/.claude/skills/tessera-cli", "native", ".claude/skills/tessera-cli", _directory_evidence),
    Artifact("native-opencode-skill", "native provider skill ~/.config/opencode/skills/tessera-cli", "native", ".config/opencode/skills/tessera-cli", _directory_evidence),
    Artifact("wsl-codex-skill", "real WSL provider skill ~/.codex/skills/tessera-cli", "agent", ".codex/skills/tessera-cli", _directory_evidence),
    Artifact("wsl-claude-skill", "real WSL provider skill ~/.claude/skills/tessera-cli", "agent", ".claude/skills/tessera-cli", _directory_evidence),
    Artifact("wsl-opencode-skill", "real WSL provider skill ~/.config/opencode/skills/tessera-cli", "agent", ".config/opencode/skills/tessera-cli", _directory_evidence),
)


def _capture(agent_home: pathlib.Path, native_home: pathlib.Path) -> dict[str, Any]:
    homes = {"agent": agent_home, "native": native_home}
    evidence: dict[str, Any] = {}
    for artifact in ARTIFACTS:
        evidence[artifact.artifact_id] = artifact.evidence(
            homes[artifact.home] / artifact.relative_path,
        )
    return {"version": SNAPSHOT_VERSION, "artifacts": evidence}


def _write_snapshot(path: pathlib.Path, snapshot: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            json.dump(snapshot, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _load_snapshot(path: pathlib.Path) -> dict[str, Any]:
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read integrity snapshot {path}: {error}") from error
    if snapshot.get("version") != SNAPSHOT_VERSION or not isinstance(snapshot.get("artifacts"), dict):
        raise RuntimeError(f"unsupported integrity snapshot {path}")
    return snapshot


def _absolute_directory(value: str, flag: str) -> pathlib.Path:
    path = pathlib.Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError(f"{flag} must be absolute")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("snapshot", "verify"))
    parser.add_argument("--agent-home", required=True)
    parser.add_argument("--native-home", required=True)
    parser.add_argument("--snapshot", required=True)
    arguments = parser.parse_args()

    try:
        agent_home = _absolute_directory(arguments.agent_home, "--agent-home")
        native_home = _absolute_directory(arguments.native_home, "--native-home")
        snapshot_path = pathlib.Path(arguments.snapshot)
        if not snapshot_path.is_absolute():
            raise RuntimeError("--snapshot must be absolute")

        current = _capture(agent_home, native_home)
        if arguments.command == "snapshot":
            _write_snapshot(snapshot_path, current)
            print(f"Integrity snapshot captured: {len(ARTIFACTS)} invariants")
            return 0

        expected = _load_snapshot(snapshot_path)
        changed = [
            artifact.label
            for artifact in ARTIFACTS
            if expected["artifacts"].get(artifact.artifact_id)
            != current["artifacts"].get(artifact.artifact_id)
        ]
        if changed:
            for label in changed:
                print(f"Integrity invariant changed: {label}", file=sys.stderr)
            return 1
        print(f"Integrity invariants preserved: {len(ARTIFACTS)} checked")
        return 0
    except (OSError, RuntimeError) as error:
        print(f"Integrity check failed closed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
