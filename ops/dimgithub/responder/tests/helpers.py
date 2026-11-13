"""Test fixtures: temp state dir, fake Cloudflare transport, scripted probes. No network, no credentials."""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import unittest

APP = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

import cfapi  # noqa: E402
import drcommon  # noqa: E402

FAKE_TOKEN = "fake-token-SHOULD-NEVER-APPEAR-0123456789abcdefghijklmnop"


class FakeCloudflare:
    """Implements just the endpoints the responder uses, and records every call."""

    def __init__(self, hostnames, requests=9000, subrequests=8000, pause=False, usage_fails=0, zone_status="active"):
        self.expected = list(hostnames)
        self.domains = [{"hostname": h, "service": "dimgithub", "environment": "production", "id": "d%d" % i, "zone_id": "z1"}
                        for i, h in enumerate(hostnames)]
        self.requests, self.subrequests = requests, subrequests
        self.pause = pause
        self.usage_fails = usage_fails
        self.zone_status = zone_status
        self.calls = []

    def writes(self):
        return [c for c in self.calls if c[0] not in ("GET",) and not c[1].endswith("graphql")]

    def __call__(self, method, url, headers, body, timeout):
        assert headers["Authorization"] == "Bearer " + FAKE_TOKEN
        path = url.split("/client/v4/", 1)[1]
        self.calls.append((method, path))
        if path.endswith("/workers/domains") and method == "GET":
            if self.domains is None:
                return 503, {}
            return 200, {"success": True, "result": list(self.domains)}
        if path.endswith("/workers/domains") and method == "PUT":
            data = json.loads(body)
            self.domains.append({"hostname": data["hostname"], "service": data["service"], "environment": "production",
                                 "id": "new-" + data["hostname"], "zone_id": data["zone_id"]})
            return 200, {"success": True, "result": {"hostname": data["hostname"], "id": "new-" + data["hostname"]}}
        if path.endswith("/settings"):
            bindings = [{"name": "BUDGET_START_AT", "type": "plain_text", "text": "2026-11-10T23:39:20.437756Z"},
                        {"name": "CLOUDFLARE_BUDGET_TOKEN", "type": "secret_text"}]
            if self.pause:
                bindings.append({"name": "POSTHOG_PAUSED_MONTH", "type": "secret_text"})
            return 200, {"success": True, "result": {"bindings": bindings}}
        if path.startswith("zones?name="):
            return 200, {"success": True, "result": [{"id": "z1", "status": self.zone_status, "name_servers": ["ben.ns.cloudflare.com", "mary.ns.cloudflare.com"]}]}
        if path == "graphql":
            if self.usage_fails > 0:
                self.usage_fails -= 1
                return 503, {}
            query = json.loads(body)["query"]
            if "dimensions" in query:
                return 200, {"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": 10, "errors": 0, "subrequests": 1}, "dimensions": {"status": "success"}}]}]}}}
            return 200, {"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {"requests": self.requests, "subrequests": self.subrequests}}]}]}}}
        if "/secrets/POSTHOG_PAUSED_MONTH" in path and method == "DELETE":
            self.pause = False
            return 200, {"success": True, "result": None}
        if path.endswith("/deployments"):
            return 200, {"success": True, "result": {"deployments": [{"created_on": "2026-11-13T00:16:36Z", "versions": [{"version_id": "v2"}]}]}}
        return 404, {"success": False, "errors": [{"code": 404}]}


class StateTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {"DIMGITHUB_STATE_DIR": self.tmp.name, "DIMGITHUB_CONFIG": os.path.join(self.tmp.name, "config.json")}
        pathlib.Path(self.env["DIMGITHUB_CONFIG"]).write_text(json.dumps({
            "notify": {"channels": ["file"], "file_path": os.path.join(self.tmp.name, "notifications.txt")},
            "agent": {"launcher": "test"},
        }))
        self._old = {k: os.environ.get(k) for k in list(self.env) + ["DIMGITHUB_SCENARIO", "DIMGITHUB_NOW"]}
        os.environ.update(self.env)
        os.environ.pop("DIMGITHUB_SCENARIO", None)
        self.addCleanup(self._restore_env)
        self.cfg = drcommon.load_config()
        self.fake = FakeCloudflare(self.cfg["expected_hostnames"])
        original = cfapi.Cloudflare.__init__

        def patched(obj, cfg, token_provider=None, transport=None, read_only=False, sleep=None):
            original(obj, cfg, token_provider=lambda: FAKE_TOKEN, transport=self.fake, read_only=read_only, sleep=lambda s: None)
        cfapi.Cloudflare.__init__ = patched
        self.addCleanup(setattr, cfapi.Cloudflare, "__init__", original)

    def _restore_env(self):
        for key, value in self._old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def notifications(self) -> str:
        path = pathlib.Path(self.tmp.name, "notifications.txt")
        return path.read_text() if path.exists() else ""

    def open_incident(self, sim=False, status="open"):
        incident_id = "SIM-T" if sim else "INC-T"
        with drcommon.state_txn() as st:
            st["incidents"][incident_id] = {"id": incident_id, "kind": "outage", "class": "dns-missing", "sim": sim,
                                            "status": status, "opened_at": drcommon.iso(), "first_failure_at": drcommon.iso(),
                                            "trigger": {"summary": "x"}, "runs": [], "actions": [], "restores": 0, "pause_clears": 0}
            st["open_incident"] = incident_id
        return incident_id


def host_result(host, auth="answer", http_ok=True, local_ok=True, status=200):
    result = {"host": host, "authoritative": {"state": auth, "ips": ["104.21.70.36"] if auth == "answer" else [], "per_ns": []},
              "local": {"ok": local_ok, "ips": []}}
    if auth == "answer":
        result["http"] = {"via": "104.21.70.36", "status": status if not http_ok or status != 200 else 200, "ok": http_ok, "ms": 5}
    result["ok"] = auth == "answer" and http_ok
    return result
