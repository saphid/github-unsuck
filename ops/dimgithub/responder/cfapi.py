"""Cloudflare API access and the budget arithmetic, mirroring the worker's guard.

The token is fetched from 1Password through op-agent at call time, held only in
memory, and never printed. In simulation mode every write is refused here, at
the transport, whatever the caller asks for.
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import time
import urllib.error
import urllib.request

import drcommon

API = "https://api.cloudflare.com/client/v4/"
PAUSE_SECRET = "POSTHOG_PAUSED_MONTH"


class CloudflareError(RuntimeError):
    pass


class UsageUnavailable(CloudflareError):
    pass


_TOKEN_CACHE: dict = {}  # process memory only; the long-running monitor re-reads every 6 h
TOKEN_TTL_S = 6 * 3600


def op_token_provider(cfg: dict):
    cache = _TOKEN_CACHE

    def provide() -> str:
        if "token" in cache and time.monotonic() - cache["at"] > TOKEN_TTL_S:
            cache.clear()
        if "token" not in cache:
            creds = cfg["credentials"]
            result = subprocess.run(
                [creds["op_agent"], "read", creds["cloudflare_token_ref"]],
                capture_output=True, text=True, timeout=60,
            )
            token = result.stdout.strip()
            if result.returncode != 0 or not token:
                raise CloudflareError("Could not read the Cloudflare token from 1Password (op-agent exit %d)" % result.returncode)
            cache.update(token=token, at=time.monotonic())
        return cache["token"]

    return provide


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None, timeout: float):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except ValueError:
            payload = {}
        return error.code, payload


# ---- budget arithmetic (must match ops/dimgithub/budget.current.mjs; see tests) ----

def js_iso(moment: dt.datetime) -> str:
    """Date.prototype.toISOString(): UTC with millisecond precision, as the worker sends it."""
    moment = moment.astimezone(dt.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (moment.microsecond // 1000)


def budget_start(now: dt.datetime, budget_start_at: str) -> dt.datetime:
    deployed = drcommon.parse_iso(budget_start_at)
    if deployed is None:
        raise CloudflareError("Deployed BUDGET_START_AT is missing or unparseable")
    month_start = now.astimezone(dt.timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return max(month_start, deployed)


def budget_decision(cfg: dict, usage: dict) -> dict:
    b = cfg["budget"]
    requests, subrequests = usage["requests"], usage["subrequests"]
    for value in (requests, subrequests):
        if not isinstance(value, (int, float)) or value < 0:
            raise UsageUnavailable("Invalid usage data")
    worker_spend = requests * b["worker_dollars_per_request"]
    analytics_spend = subrequests * b["posthog_dollars_per_subrequest"]
    return {
        "requests": requests,
        "subrequests": subrequests,
        "worker_spend_usd": round(worker_spend, 4),
        "analytics_spend_usd": round(analytics_spend, 4),
        "worker_cap_usd": b["worker_cutoff_dollars"],
        "analytics_cap_usd": b["analytics_cutoff_dollars"],
        "worker_fraction": round(worker_spend / b["worker_cutoff_dollars"], 4),
        "analytics_fraction": round(analytics_spend / b["analytics_cutoff_dollars"], 4),
        "stopSite": worker_spend >= b["worker_cutoff_dollars"],
        "pauseAnalytics": analytics_spend >= b["analytics_cutoff_dollars"],
    }


class Cloudflare:
    def __init__(self, cfg: dict, token_provider=None, transport=None, read_only: bool = False, sleep=time.sleep):
        self.cfg = cfg
        self.token = token_provider or op_token_provider(cfg)
        self.transport = transport or urllib_transport
        self.scenario = (cfg.get("scenario") or {}).get("cloudflare") or {}
        self.read_only = read_only or cfg.get("scenario") is not None
        self.sleep = sleep
        self.account = cfg["account_id"]
        self.worker = cfg["worker"]

    # -- transport --
    def _call(self, method: str, path: str, body=None, timeout: float = 20):
        is_read = method == "GET" or path == "graphql"
        if self.read_only and not is_read:
            raise CloudflareError("Refusing %s %s: simulation/dry-run transport is read-only" % (method, path))
        headers = {"Authorization": "Bearer " + self.token(), "Content-Type": "application/json"}
        data = json.dumps(body).encode() if body is not None else None
        try:
            status, payload = self.transport(method, API + path, headers, data, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise CloudflareError("Cloudflare %s %s failed: %s" % (method, path, type(error).__name__)) from None
        if status in (401, 403):
            _TOKEN_CACHE.clear()  # rotated token in 1Password: re-read next time
        if status >= 400 or payload.get("success") is False or (payload.get("errors") and path != "graphql"):
            codes = [e.get("code") for e in payload.get("errors") or [] if isinstance(e, dict)]
            raise CloudflareError("Cloudflare %s %s returned HTTP %s %s" % (method, path, status, codes or ""))
        return payload

    def _sim(self) -> dict:
        path = drcommon.state_dir() / "sim.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def _sim_set(self, **fields) -> None:
        path = drcommon.state_dir() / "sim.json"
        data = self._sim()
        data.update(fields)
        path.write_text(json.dumps(data))

    # -- reads --
    def domains(self) -> list:
        rows = self._call("GET", f"accounts/{self.account}/workers/domains")["result"]
        if not isinstance(rows, list):
            raise CloudflareError("Invalid domain list")
        rows = [r for r in rows if r.get("service") == self.worker]
        if "domains_present" in self.scenario and not self._sim().get("healed_domains"):
            keep = set(self.scenario["domains_present"])
            rows = [r for r in rows if r.get("hostname") in keep]
        return rows

    def bindings(self) -> list:
        result = self._call("GET", f"accounts/{self.account}/workers/scripts/{self.worker}/settings")["result"]
        rows = [{"name": b.get("name"), "type": b.get("type"), **({"text": b.get("text")} if b.get("type") == "plain_text" else {})}
                for b in result.get("bindings", [])]
        if self.scenario.get("pause_secret") and not self._sim().get("healed_pause"):
            if not any(r["name"] == PAUSE_SECRET for r in rows):
                rows.append({"name": PAUSE_SECRET, "type": "secret_text"})
        return rows

    def zone(self) -> dict:
        zones = self._call("GET", "zones?name=" + self.cfg["zone"])["result"]
        if not zones:
            raise CloudflareError("Zone %s not found in this account" % self.cfg["zone"])
        z = zones[0]
        out = {"id": z["id"], "status": z.get("status"), "paused": z.get("paused"), "name_servers": z.get("name_servers")}
        if self.scenario.get("zone_status"):
            out["status"] = self.scenario["zone_status"]
        return out

    def deployments(self) -> list:
        data = self._call("GET", f"accounts/{self.account}/workers/scripts/{self.worker}/deployments")["result"]
        return [{"created_on": d.get("created_on"), "versions": [v.get("version_id") for v in d.get("versions", [])]}
                for d in data.get("deployments", [])[:3]]

    def usage(self, start: dt.datetime, attempts: int = 3) -> dict:
        if self.scenario.get("usage_error"):
            raise UsageUnavailable("Simulated usage-read failure")
        query = ("{viewer{accounts(filter:{accountTag:%s}){workersInvocationsAdaptive(limit:1,filter:{scriptName:%s,datetime_geq:%s}){sum{requests subrequests}}}}}"
                 % (json.dumps(self.account), json.dumps(self.worker), json.dumps(js_iso(start))))
        last = "unknown"
        for attempt in range(attempts):
            try:
                payload = self._call("POST", "graphql", {"query": query}, timeout=10)
                if payload.get("errors"):
                    raise CloudflareError("GraphQL errors")
                groups = (((payload.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("workersInvocationsAdaptive")
                if not isinstance(groups, list):
                    raise CloudflareError("Missing usage data")
                usage = {"requests": 0, "subrequests": 0}
                for row in groups:
                    total = row.get("sum") if isinstance(row, dict) else None
                    for field in ("requests", "subrequests"):
                        value = total.get(field) if isinstance(total, dict) else None
                        # The worker turns a missing field into NaN and fails closed; so do we.
                        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0:
                            raise CloudflareError("Malformed usage row")
                        usage[field] += value
                if "usage" in self.scenario:
                    usage = {**usage, **self.scenario["usage"], "simulated": True}
                return usage
            except CloudflareError as error:
                last = str(error)
                if attempt < attempts - 1:
                    self.sleep(1 + attempt)
        raise UsageUnavailable("Usage read failed after %d attempts: %s" % (attempts, last))

    def recent_invocations(self, minutes: int = 15) -> list:
        """Invocation outcomes for the last few minutes (read-only GraphQL; best effort)."""
        since = js_iso(drcommon.utcnow() - dt.timedelta(minutes=minutes))
        query = ("{viewer{accounts(filter:{accountTag:%s}){workersInvocationsAdaptive(limit:20,filter:{scriptName:%s,datetime_geq:%s}){sum{requests errors subrequests} dimensions{status}}}}}"
                 % (json.dumps(self.account), json.dumps(self.worker), json.dumps(since)))
        payload = self._call("POST", "graphql", {"query": query}, timeout=10)
        if payload.get("errors"):
            raise CloudflareError("GraphQL errors")
        groups = (((payload.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("workersInvocationsAdaptive") or []
        return [{"status": (g.get("dimensions") or {}).get("status"), **(g.get("sum") or {})} for g in groups]

    def budget(self, bindings: list | None = None) -> dict:
        bindings = bindings if bindings is not None else self.bindings()
        start_at = next((b.get("text") for b in bindings if b["name"] == "BUDGET_START_AT"), None)
        start = budget_start(drcommon.utcnow(), start_at)
        usage = self.usage(start)
        decision = budget_decision(self.cfg, usage)
        decision["since"] = drcommon.iso(start)
        decision["budget_start_at"] = start_at
        if usage.get("simulated"):
            decision["simulated"] = True
        return decision

    # -- writes (guarded by ops.py; read-only transport refuses them in simulation) --
    def put_domain(self, hostname: str, zone_id: str, dry_run: bool) -> dict:
        body = {"hostname": hostname, "zone_id": zone_id, "service": self.worker, "environment": "production"}
        if dry_run:
            if self.cfg.get("scenario", {}) and self.cfg["scenario"].get("heal_on_write"):
                self._sim_set(healed_domains=True)
            return {"hostname": hostname, "dry_run": True}
        result = self._call("PUT", f"accounts/{self.account}/workers/domains", body)["result"]
        return {"hostname": result.get("hostname"), "id": result.get("id")}

    def delete_pause_secret(self, dry_run: bool) -> dict:
        if dry_run:
            if self.cfg.get("scenario", {}) and self.cfg["scenario"].get("heal_on_write"):
                self._sim_set(healed_pause=True)
            return {"deleted": PAUSE_SECRET, "dry_run": True}
        self._call("DELETE", f"accounts/{self.account}/workers/scripts/{self.worker}/secrets/{PAUSE_SECRET}")
        return {"deleted": PAUSE_SECRET}
