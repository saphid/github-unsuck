"""Outage probes that do not trust any recursive resolver.

Ground truth for "is the site up" is: ask Cloudflare's authoritative nameservers
for each probe host, then fetch /api/health from the returned address with curl
--resolve. Local and public resolvers are recorded as evidence only, so a stale
negative cache (this Mac, the home resolver, 1.1.1.1) can neither fake an outage
nor hide one.

Classes:
  healthy          every probe host answers authoritatively and returns {"ok":true}
  dns-missing      an authoritative server says the host has no address (bindings gone)
  http-failing     addresses exist but /api/health fails, and the control URL works
  vantage-broken   nameservers unreachable, or HTTP fails everywhere including the control URL
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time

import drcommon

DOWN_CLASSES = ("dns-missing", "http-failing")
A_RECORD = re.compile(r"^\S+\s+\d+\s+IN\s+A\s+(\d+\.\d+\.\d+\.\d+)\s*$", re.M)
STATUS = re.compile(r"status: ([A-Z]+)")


def run(argv: list, timeout: float) -> tuple[int, str]:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def dig(host: str, ns: str, timeout: float) -> dict:
    code, out = run(["dig", "+time=%d" % max(1, int(timeout)), "+tries=1", "+noall", "+comments", "+answer",
                     "@" + ns, host, "A"], timeout + 3)
    status = STATUS.search(out)
    if code != 0 or not status:
        return {"ns": ns, "status": "UNREACHABLE"}
    return {"ns": ns, "status": status.group(1), "ips": A_RECORD.findall(out)}


def dig_ns(host: str, ns: str, cfg: dict) -> dict:
    """Query one authoritative server by its fixed IPs first, so the home resolver is not needed to find it."""
    timeout = cfg["probe"]["dns_timeout_s"]
    for ip in cfg["probe"].get("authoritative_ns_ips", {}).get(ns, [])[:2]:
        result = dig(host, ip, timeout)
        if result["status"] != "UNREACHABLE":
            return {**result, "ns": ns, "via": ip}
    return {**dig(host, ns, timeout), "ns": ns, "via": "hostname"}


def authoritative(host: str, cfg: dict) -> dict:
    per_ns = [dig_ns(host, ns, cfg) for ns in cfg["probe"]["authoritative_ns"]]
    ips = sorted({ip for r in per_ns for ip in r.get("ips", [])})
    negative = [r for r in per_ns if r["status"] in ("NOERROR", "NXDOMAIN") and not r.get("ips")]
    needed = min(2, len(per_ns))
    if ips:
        state = "answer"
    elif len(negative) >= needed:
        state = "empty"  # corroborated by at least two authoritative servers
    else:
        state = "unreachable"  # uncorroborated or no answer: not evidence of an outage
    return {"state": state, "ips": ips, "per_ns": per_ns}


def http_health(host: str, ip: str | None, cfg: dict) -> dict:
    url = "https://%s%s" % (host, cfg["probe"]["health_path"])
    argv = ["curl", "-sS", "-m", str(cfg["probe"]["http_timeout_s"]), "-o", "-", "-w", "\n%{http_code}"]
    if ip:
        argv += ["--resolve", "%s:443:%s" % (host, ip)]
    started = time.monotonic()
    code, out = run(argv + [url], cfg["probe"]["http_timeout_s"] + 3)
    elapsed = int((time.monotonic() - started) * 1000)
    body, _, status = out.rpartition("\n")
    status = int(status) if status.strip().isdigit() else 0
    ok = False
    if code == 0 and status == 200:
        try:
            parsed = json.loads(body)
            ok = isinstance(parsed, dict) and parsed.get("ok") is True
        except ValueError:
            ok = False
    result = {"via": ip or "system-resolver", "status": status, "ok": ok, "ms": elapsed}
    if code != 0:
        result["error"] = drcommon.scrub(out.strip().splitlines()[-1] if out.strip() else "curl exit %d" % code, 200)
    return result


def control(cfg: dict) -> dict:
    code, out = run(["curl", "-sS", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", cfg["probe"]["control_url"]], 11)
    return {"ok": code == 0 and out.strip().endswith("200"), "detail": drcommon.scrub(out.strip(), 200)}


def local_resolve(host: str) -> dict:
    if shutil.which("getent"):
        code, out = run(["getent", "ahostsv4", host], 6)
    else:  # macOS (tests / manual runs)
        code, out = run(["dscacheutil", "-q", "host", "-a", "name", host], 6)
    ips = sorted(set(re.findall(r"(\d+\.\d+\.\d+\.\d+)", out))) if code == 0 else []
    return {"ok": bool(ips), "ips": ips}


def doh(host: str, endpoint: str) -> dict:
    code, out = run(["curl", "-sS", "-m", "6", "-H", "accept: application/dns-json",
                     "%s?name=%s&type=A" % (endpoint, host)], 9)
    try:
        data = json.loads(out)
    except ValueError:
        return {"endpoint": endpoint, "state": "unreachable"}
    ips = [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]
    return {"endpoint": endpoint, "state": "answer" if ips else "empty", "ips": ips, "rcode": data.get("Status")}


def _sim(cfg: dict) -> tuple[dict, dict]:
    scenario = (cfg.get("scenario") or {}).get("probe") or {}
    sim_state = {}
    path = drcommon.state_dir() / "sim.json"
    if path.exists():
        sim_state = json.loads(path.read_text())
    return scenario, sim_state


def probe_host(host: str, cfg: dict, include_local: bool = True) -> dict:
    scenario, sim_state = _sim(cfg)
    auth = authoritative(host, cfg)
    if host in scenario.get("authoritative_empty", []) and not sim_state.get("healed_domains"):
        auth = {"state": "empty", "ips": [], "per_ns": [{"ns": ns, "status": "NXDOMAIN", "ips": [], "simulated": True}
                                                       for ns in cfg["probe"]["authoritative_ns"]]}
    if scenario.get("vantage_down"):
        auth = {"state": "unreachable", "ips": [], "per_ns": [{"ns": ns, "status": "UNREACHABLE", "simulated": True}
                                                             for ns in cfg["probe"]["authoritative_ns"]]}
    result = {"host": host, "authoritative": auth}
    if auth["state"] == "answer":
        attempts = []
        for ip in auth["ips"][:2]:  # a routing problem on one edge address is not an outage
            attempts.append(http_health(host, ip, cfg))
            if attempts[-1]["ok"]:
                break
        result["http"] = attempts[-1]
        if len(attempts) > 1:
            result["http_attempts"] = attempts
        forced = scenario.get("http_status", {}).get(host)
        if forced:
            result["http"] = {"via": auth["ips"][0], "status": forced, "ok": False, "simulated": True}
    if include_local:
        result["local"] = local_resolve(host)
        if host in scenario.get("local_dns_fail", []):
            result["local"] = {"ok": False, "ips": [], "simulated": True}
    result["ok"] = auth["state"] == "answer" and result.get("http", {}).get("ok", False)
    return result


def classify(hosts: list, control_result: dict | None) -> str:
    if all(h["ok"] for h in hosts):
        return "healthy"
    if any(h["authoritative"]["state"] == "empty" for h in hosts):
        return "dns-missing"
    failing = [h for h in hosts if not h["ok"]]
    if all(h["authoritative"]["state"] == "unreachable" for h in failing):
        return "vantage-broken"
    # The site answered with an HTTP status, or another monitored host works: this vantage can reach the edge.
    got_status = any((h.get("http") or {}).get("status") for h in failing)
    if got_status or any(h["ok"] for h in hosts):
        return "http-failing"
    if control_result is not None and not control_result["ok"]:
        return "vantage-broken"
    return "http-failing"


def fast_probe(cfg: dict) -> dict:
    hosts = [probe_host(h, cfg) for h in cfg["probe"]["hosts"]]
    control_result = None
    if not all(h["ok"] for h in hosts):
        control_result = control(cfg)
        if (cfg.get("scenario") or {}).get("probe", {}).get("vantage_down"):
            control_result = {"ok": False, "detail": "simulated", "simulated": True}
    cls = classify(hosts, control_result)
    local_ok = all(h.get("local", {}).get("ok", True) for h in hosts)
    out = {"at": drcommon.iso(), "class": cls, "hosts": hosts, "local_dns_ok": local_ok}
    if control_result is not None:
        out["control"] = control_result
    if cls == "healthy" and not local_ok:
        out["note"] = "local-dns-only: site healthy via authoritative path; this vantage's resolver is stale or broken"
    out["summary"] = summarize(out)
    return out


def public_view(cfg: dict) -> list:
    host = cfg["probe"]["hosts"][0]
    return [doh(host, "https://cloudflare-dns.com/dns-query"), doh(host, "https://dns.google/resolve")]


def summarize(result: dict) -> str:
    parts = []
    for h in result["hosts"]:
        auth = h["authoritative"]["state"]
        http = h.get("http")
        http_text = ("http %s" % (http["status"] or http.get("error", "error"))) if http else "http skipped"
        local = "local-dns ok" if h.get("local", {}).get("ok") else "local-dns FAIL"
        parts.append("%s: auth-dns %s, %s, %s" % (h["host"], auth, http_text, local))
    return "%s | %s" % (result["class"], "; ".join(parts))
