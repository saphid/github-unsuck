"""Shared configuration, state, locking and event log for the dimgithub responder.

Standard library only (runs on lxso1's system python3 and the Mac's).
Nothing in this module ever handles a credential.
"""
from __future__ import annotations

import contextlib
import copy
import datetime as dt
import fcntl
import json
import os
import pathlib
import re
import secrets
import tempfile

APP_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_STATE_DIR = pathlib.Path.home() / ".local/state/dimgithub-responder"
DEFAULT_USER_CONFIG = pathlib.Path.home() / ".config/dimgithub-responder/config.json"


def utcnow() -> dt.datetime:
    override = os.environ.get("DIMGITHUB_NOW")  # tests only
    if override:
        return dt.datetime.fromisoformat(override.replace("Z", "+00:00"))
    return dt.datetime.now(dt.timezone.utc)


def iso(moment: dt.datetime | None = None) -> str:
    return (moment or utcnow()).astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def deep_merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def strip_jsonc(text: str) -> str:
    # wrangler.jsonc may carry // or /* */ comments; strings in it never contain them.
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join(re.sub(r"(^|\s)//.*$", "", line) for line in text.splitlines())


def find_wrangler(cfg: dict) -> pathlib.Path:
    candidates = [pathlib.Path(cfg.get("wrangler_config") or "")] if cfg.get("wrangler_config") else []
    candidates += [APP_DIR / "wrangler.jsonc", APP_DIR.parent / "wrangler.jsonc"]
    for path in candidates:
        if path and path.is_file():
            return path
    raise FileNotFoundError("wrangler.jsonc not found next to the responder or in its parent")


def load_config() -> dict:
    cfg = json.loads((APP_DIR / "config.default.json").read_text())
    user_path = pathlib.Path(os.environ.get("DIMGITHUB_CONFIG") or DEFAULT_USER_CONFIG)
    if user_path.is_file():
        cfg = deep_merge(cfg, json.loads(user_path.read_text()))
    wrangler = json.loads(strip_jsonc(find_wrangler(cfg).read_text()))
    if wrangler.get("name") != cfg["worker"] or wrangler.get("account_id") != cfg["account_id"]:
        raise ValueError("wrangler.jsonc does not describe the configured worker/account")
    cfg["expected_hostnames"] = sorted(
        r["pattern"] for r in wrangler.get("routes", []) if r.get("custom_domain")
    )
    if not cfg["expected_hostnames"]:
        raise ValueError("wrangler.jsonc lists no custom domains")
    scenario_path = os.environ.get("DIMGITHUB_SCENARIO")
    cfg["scenario"] = json.loads(pathlib.Path(scenario_path).read_text()) if scenario_path else None
    if cfg["scenario"] is not None:
        cfg["scenario"]["_path"] = scenario_path
    return cfg


def state_dir() -> pathlib.Path:
    path = pathlib.Path(os.environ.get("DIMGITHUB_STATE_DIR") or DEFAULT_STATE_DIR)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


EMPTY_STATE = {
    "monitor": {},
    "incidents": {},
    "open_incident": None,
    "restores": [],
    "outbox": [],
    "notes": {},
}


def _read_state(path: pathlib.Path) -> dict:
    if not path.exists():
        return copy.deepcopy(EMPTY_STATE)
    data = json.loads(path.read_text() or "{}")
    return deep_merge(EMPTY_STATE, data)


def _write_state(path: pathlib.Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".state.", suffix=".tmp")
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, indent=1, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


@contextlib.contextmanager
def state_txn():
    """Serialised read-modify-write of state.json (monitor, responder and ops share it)."""
    directory = state_dir()
    with open(directory / "state.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / "state.json"
        data = _read_state(path)
        yield data
        _write_state(path, data)


_MUTATION_DEPTH = [0]


@contextlib.contextmanager
def mutation_lock():
    """Serialise every production-mutating command and escalation across processes (re-entrant within one)."""
    if _MUTATION_DEPTH[0]:
        _MUTATION_DEPTH[0] += 1
        try:
            yield
        finally:
            _MUTATION_DEPTH[0] -= 1
        return
    with open(state_dir() / "mutation.lock", "a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        _MUTATION_DEPTH[0] = 1
        try:
            yield
        finally:
            _MUTATION_DEPTH[0] = 0


def read_state() -> dict:
    directory = state_dir()
    with open(directory / "state.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        return _read_state(directory / "state.json")


def log_event(event: str, **fields) -> dict:
    record = {"at": iso(), "event": event, **fields}
    with open(state_dir() / "events.jsonl", "a") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    return record


class HeldLock:
    """Non-blocking exclusive flock held for the life of the object (or process)."""

    def __init__(self, name: str):
        self.path = state_dir() / name
        self.handle = open(self.path, "a+")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.handle.close()
            raise

    def release(self) -> None:
        if not self.handle.closed:
            fcntl.flock(self.handle, fcntl.LOCK_UN)
            self.handle.close()


def lock_is_held(name: str) -> bool:
    try:
        lock = HeldLock(name)
    except BlockingIOError:
        return True
    lock.release()
    return False


BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}")
LONG_RUN = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])")


def _long_run(match: re.Match) -> str:
    text = match.group(0)
    # Our own unit names and incident ids are long hyphenated words, not credentials.
    return text if text.startswith("dimgithub-") else "<redacted>"


def scrub(text: str, limit: int = 4000) -> str:
    """Remove anything token-shaped and clip; used on every agent/tool output we store or send."""
    text = BEARER.sub(lambda m: m.group(1) + "<redacted>", str(text))
    text = LONG_RUN.sub(_long_run, text)
    return text if len(text) <= limit else text[: limit - 20] + "\n…[clipped]"


def new_incident_id(sim: bool) -> str:
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    return ("SIM-" if sim else "INC-") + stamp + "-" + secrets.token_hex(2)
