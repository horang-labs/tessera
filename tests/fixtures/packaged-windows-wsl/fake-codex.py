#!/usr/bin/python3
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time


EVENT_NAMES = {
    "SessionStart": "sessionStart",
    "UserPromptSubmit": "userPromptSubmit",
    "PreToolUse": "preToolUse",
    "PermissionRequest": "permissionRequest",
    "PostToolUse": "postToolUse",
    "Stop": "stop",
}


def fixture_paths():
    root = pathlib.Path(os.environ.get("TESSERA_ACCEPTANCE_FIXTURE_ROOT", ""))
    home = pathlib.Path(os.environ.get("CODEX_HOME", ""))
    safe_home = root.is_absolute() and home.is_absolute() and root in home.parents
    if not safe_home and home.is_absolute():
        try:
            marker = json.loads((home / ".tessera-overlay.json").read_text(encoding="utf-8"))
            account_home = pathlib.Path(marker.get("accountHome", ""))
            expected_overlay = pathlib.Path.home() / ".tessera" / "test-instances"
            safe_home = (
                marker.get("kind") == "tessera-codex-overlay"
                and account_home == root / "codex-home"
                and expected_overlay in home.parents
                and "codex-overlay" in home.parts
                and home.name.startswith("session-")
            )
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            safe_home = False
    if not safe_home:
        raise RuntimeError("fixture Codex refused a non-isolated CODEX_HOME")
    evidence = root / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    return root, home, evidence


def append_json(path, value):
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, sort_keys=True) + "\n")


def hook_metadata(home):
    hooks_path = home / "hooks.json"
    try:
        document = json.loads(hooks_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        document = {"hooks": {}}
    try:
        trusted = json.loads((home / ".fixture-hook-trust.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        trusted = {}
    rows = []
    canonical = str(hooks_path.resolve())
    for event, groups in document.get("hooks", {}).items():
        event_name = EVENT_NAMES.get(event)
        if not event_name or not isinstance(groups, list):
            continue
        for group_index, group in enumerate(groups):
            for hook_index, hook in enumerate(group.get("hooks", [])):
                command = hook.get("command")
                if not isinstance(command, str):
                    continue
                key = f"{canonical}:{event_name}:{group_index}:{hook_index}"
                current_hash = "sha256:" + hashlib.sha256(command.encode()).hexdigest()
                rows.append({
                    "key": key,
                    "eventName": event_name,
                    "command": command,
                    "source": "user",
                    "currentHash": current_hash,
                    "trustStatus": "trusted" if trusted.get(key) == current_hash else "untrusted",
                    "enabled": True,
                })
    return {"data": [{"hooks": rows, "warnings": [], "errors": []}]}


def run_hooks(event, payload, home):
    try:
        document = json.loads((home / "hooks.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return
    body = json.dumps(payload).encode()
    for group in document.get("hooks", {}).get(event, []):
        for hook in group.get("hooks", []):
            command = hook.get("command")
            if isinstance(command, str):
                subprocess.run(
                    ["/bin/sh", "-c", command],
                    input=body,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    env=os.environ.copy(),
                    timeout=12,
                )


def persist_provider_state(home, evidence, label):
    transition_path = home / ".fixture-transitions.json"
    try:
        transitions = json.loads(transition_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        transitions = []
    transitions.append(label)
    transition_path.write_text(json.dumps(transitions) + "\n", encoding="utf-8")
    (home / "auth.json").write_text(
        json.dumps({"fixture": "synthetic-auth", "credential": "not-a-secret", "refresh": len(transitions)}) + "\n",
        encoding="utf-8",
    )
    (home / "config.toml").write_text(f'fixture_mode = "{label}"\n', encoding="utf-8")
    (home / "mcp-state.json").write_text(
        json.dumps({"fixture-mcp": {"enabled": True, "authenticated": len(transitions) % 2 == 0}}) + "\n",
        encoding="utf-8",
    )
    append_json(home / "history.jsonl", {"event": label, "sequence": len(transitions)})
    append_json(evidence / "provider-state.jsonl", {
        "home": str(home),
        "label": label,
        "sequence": len(transitions),
    })


def write_rollout(home, provider_session_id, forked_from_id=None):
    sessions = home / "sessions" / "2026" / "08" / "12"
    sessions.mkdir(parents=True, exist_ok=True)
    payload = {"session_id": provider_session_id, "id": provider_session_id}
    if forked_from_id:
        payload["forked_from_id"] = forked_from_id
    transcript = sessions / f"rollout-{provider_session_id}.jsonl"
    append_json(transcript, {"type": "session_meta", "payload": payload})
    return transcript


def run_control(evidence):
    cli = os.environ.get("TESSERA_CLI_COMMAND")
    project = os.environ.get("TESSERA_PROJECT_ID")
    worktree = os.environ.get("TESSERA_WORKTREE_ID")
    marker = evidence / "control-ran.json"
    if not cli or marker.exists():
        return

    def call(args):
        completed = subprocess.run(
            [cli, *args, "--json"],
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
            env=os.environ.copy(),
        )
        parsed = None
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            pass
        return completed.returncode, parsed

    status_code, status = call(["status"])
    list_code, listed = call(["worktree", "list", "--current"])
    probe_worktree = worktree or "acceptance-missing-worktree"
    create_code, created = call([
        "session", "create", "--worktree", probe_worktree,
        "--provider", "codex", "--title", "Acceptance control child",
    ])
    audit_code, audit = call(["project", "audit", "--current"])
    foreign_code, foreign = call([
        "project", "audit", "--project", "acceptance-foreign-project",
    ])
    records = (((audit or {}).get("data") or {}).get("records") or [])
    allowed_audit_keys = {
        "id", "projectId", "sourceSessionId", "operation", "target",
        "occurredAt", "outcome", "failureCode",
    }
    for record in records:
        unexpected = set(record) - allowed_audit_keys
        if unexpected:
            raise RuntimeError(f"control audit exposed non-metadata fields: {sorted(unexpected)}")
    serialized_raw_records = json.dumps(records, sort_keys=True)
    if any(forbidden in serialized_raw_records for forbidden in ("prompt", "keyInput", "credential")):
        raise RuntimeError("control audit retained a forbidden content field")
    public_records = [{
        key: record.get(key)
        for key in (
            "projectId", "sourceSessionId", "operation", "target",
            "occurredAt", "outcome", "failureCode",
        )
        if key in record
    } for record in records]
    caller = (((status or {}).get("data") or {}).get("callerContext") or {})
    marker.write_text(json.dumps({
        "statusCode": status_code,
        "statusOk": bool(status and status.get("ok")),
        "projectScoped": bool(project) and caller.get("projectId") == project,
        "callerWorktreeId": caller.get("worktreeId"),
        "listCode": list_code,
        "listedWorktrees": len((((listed or {}).get("data") or {}).get("worktrees") or [])),
        "createCode": create_code,
        "createError": (((created or {}).get("error") or {}).get("code")),
        "createdSessionId": (((created or {}).get("data") or {}).get("sessionId")),
        "auditCode": audit_code,
        "auditRecords": len(records),
        "auditMetadata": public_records,
        "foreignCode": foreign_code,
        "foreignError": (((foreign or {}).get("error") or {}).get("code")),
    }, sort_keys=True) + "\n", encoding="utf-8")


def app_server(root, home, evidence):
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            continue
        request_id = request.get("id")
        if request_id is None:
            continue
        method = request.get("method")
        if method == "initialize":
            result = {"models": [{"id": "gpt-5.6-sol", "displayName": "Fixture", "isDefault": True}]}
        elif method == "model/list":
            result = {"data": [{"id": "gpt-5.6-sol", "displayName": "Fixture", "isDefault": True}]}
        elif method == "hooks/list":
            if (root / "modes" / "hook-api-unavailable").exists():
                print(json.dumps({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "fixture hook API unavailable"}}), flush=True)
                continue
            result = hook_metadata(home)
        elif method == "config/batchWrite":
            values = {}
            for edit in (request.get("params") or {}).get("edits", []):
                if edit.get("keyPath") == "hooks.state" and isinstance(edit.get("value"), dict):
                    values.update({key: value.get("trusted_hash") for key, value in edit["value"].items()})
            (home / ".fixture-hook-trust.json").write_text(json.dumps(values) + "\n", encoding="utf-8")
            result = {}
        elif method in ("thread/start", "thread/resume"):
            thread_id = (request.get("params") or {}).get("threadId") or f"fixture-{os.environ.get('TESSERA_SESSION_ID', 'external')}"
            persist_provider_state(home, evidence, method)
            write_rollout(home, thread_id)
            run_control(evidence)
            result = {"thread": {"id": thread_id}}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)


def tui(root, home, evidence, args):
    if args and args[0] == "acceptance-external":
        run_hooks("SessionStart", {"session_id": "external-fixture"}, home)
        append_json(evidence / "external.jsonl", {"home": str(home), "managed": False})
        return 0
    resume_id = None
    if "resume" in args:
        index = args.index("resume")
        if index + 1 < len(args):
            resume_id = args[index + 1]
    provider_session_id = resume_id or f"fixture-{os.environ.get('TESSERA_SESSION_ID', os.getpid())}"
    transcript = write_rollout(home, provider_session_id)
    payload = {
        "session_id": provider_session_id,
        "transcript_path": str(transcript),
        "hook_event_name": "SessionStart",
    }
    persist_provider_state(home, evidence, "tui-resume" if resume_id else "tui-start")
    run_hooks("SessionStart", payload, home)
    run_control(evidence)
    append_json(evidence / "launches.jsonl", {
        "home": str(home),
        "legacyOverlay": os.environ.get("TESSERA_CODEX_HOME"),
        "managed": bool(os.environ.get("TESSERA_CLI_COMMAND")),
        "providerSessionId": provider_session_id,
        "resume": bool(resume_id),
    })
    print("Tessera packaged acceptance fixture ready", flush=True)
    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while running:
        line = sys.stdin.readline()
        if line:
            append_json(home / "history.jsonl", {"event": "input", "text": line.rstrip("\n")})
            if line.strip() == "acceptance-degraded-control":
                (evidence / "control-ran.json").unlink(missing_ok=True)
                run_control(evidence)
            print("fixture accepted input", flush=True)
        else:
            time.sleep(0.1)
    return 0


def main():
    root, home, evidence = fixture_paths()
    args = sys.argv[1:]
    if args == ["--version"]:
        print("codex-cli 0.146.0")
        return 0
    if args[:2] == ["login", "status"]:
        print("Logged in with synthetic fixture")
        return 0
    if args == ["app-server"]:
        app_server(root, home, evidence)
        return 0
    return tui(root, home, evidence, args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"fixture-codex-error: {error}", file=sys.stderr)
        raise
