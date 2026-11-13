#!/usr/bin/env python3
"""The only tool the responder agent may run. Guardrails are enforced here, in code.

  probe                                  fast probe (no credentials)
  diagnose      --incident ID            read-only: probes, public DNS, zone, bindings, pause secret, budget, deployments
  restore-domains --incident ID [--dry-run]
                re-create missing custom domains, only if this command itself reads usage
                and the worker spend is below the cap; capped per incident and per 24 h
  clear-pause   --incident ID [--dry-run]
                delete POSTHOG_PAUSED_MONTH, only if usage is read and both spends are below cap
  watch         --incident ID --seconds N   re-probe every 30 s (<= limits.watch_max_s)
  escalate      --incident ID --reason TEXT mark the incident escalated and notify Alex

There is deliberately no command to deploy, change caps, change BUDGET_START_AT,
touch CLOUDFLARE_BUDGET_TOKEN, edit the cron, or disable the watchdog.

Exit codes: 0 ok; 1 API/other error; 2 bad usage or unknown incident; 3 limit reached
(escalated); 4 usage unavailable (refused); 5 budget cap reached (escalated); 6 precondition refused.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import cfapi
import drcommon
import notify
import probe


class Refused(Exception):
    def __init__(self, code: int, message: str, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, indent=1, sort_keys=True, default=str))
    return code


def load_incident(incident_id: str, for_write: bool) -> dict:
    st = drcommon.read_state()
    incident = st["incidents"].get(incident_id)
    if incident is None:
        raise Refused(2, "Unknown incident %s" % incident_id)
    if for_write and incident["status"] != "open":
        raise Refused(6, "Incident %s is %s; no further production writes" % (incident_id, incident["status"]))
    return incident


def record_action(incident_id: str, kind: str, **fields) -> None:
    with drcommon.state_txn() as st:
        st["incidents"][incident_id].setdefault("actions", []).append({"at": drcommon.iso(), "kind": kind, **fields})
    drcommon.log_event("action", incident=incident_id, action=kind, **fields)


def escalate(cfg: dict, incident_id: str, reason: str, evidence: dict | None = None) -> dict:
    with drcommon.mutation_lock():
        return _escalate(cfg, incident_id, reason, evidence)


def _escalate(cfg: dict, incident_id: str, reason: str, evidence: dict | None = None) -> dict:
    reason = drcommon.scrub(reason, 1500)
    with drcommon.state_txn() as st:
        incident = st["incidents"][incident_id]
        incident["status"] = "escalated"
        incident.setdefault("escalations", []).append({"at": drcommon.iso(), "reason": reason})
        incident["last_reminder"] = drcommon.iso()
        sim = incident.get("sim", False)
    drcommon.log_event("escalated", incident=incident_id, reason=reason)
    short = "🚨 dimgithub.com %s ESCALATED, needs you: %s" % (incident_id, reason)
    detail = "### dimgithub incident `%s` escalated\n\n%s\n\nThe responder stopped and made no further production writes.\n" % (incident_id, reason)
    if evidence:
        detail += "\n<details><summary>evidence</summary>\n\n```json\n%s\n```\n</details>\n" % json.dumps(evidence, indent=1, default=str)[:20000]
    notify.notify(cfg, short, detail, sim=sim)
    return {"escalated": incident_id, "reason": reason}


def make_cf(cfg: dict, incident: dict | None = None) -> cfapi.Cloudflare:
    read_only = bool(incident and incident.get("sim")) or cfg.get("scenario") is not None
    return cfapi.Cloudflare(cfg, read_only=read_only)


def safe(fn):
    try:
        return fn()
    except cfapi.CloudflareError as error:
        return {"error": str(error)}


def suggested_branch(report: dict) -> str:
    fast = report["probe"]
    zone = report.get("zone", {})
    domains = report.get("domains", {})
    budget = report.get("budget", {})
    if zone.get("error") or (zone.get("status") and zone.get("status") != "active"):
        return "D-dns-zone"
    if domains.get("missing"):
        if budget.get("error"):
            return "A3-usage-unknown"
        if budget.get("stopSite"):
            return "A2-cap-reached"
        return "A1-restore"
    if domains.get("error"):
        return "D-dns-zone" if fast["class"] in probe.DOWN_CLASSES else "E-false-alarm"
    if report.get("pause_secret_present"):
        if budget.get("error"):
            return "B3-usage-unknown"
        return "B2-pause-legitimate" if budget.get("pauseAnalytics") or budget.get("stopSite") else "B1-clear-pause"
    if fast["class"] == "dns-missing":
        return "D-dns-zone"
    if fast["class"] == "http-failing":
        return "C-worker-error"
    if fast["class"] == "vantage-broken":
        return "E-vantage"
    return "E-false-alarm"


def diagnose(cfg: dict, incident: dict | None) -> dict:
    cf = make_cf(cfg, incident)
    report = {"at": drcommon.iso(), "probe": probe.fast_probe(cfg), "public_dns": probe.public_view(cfg)}
    report["zone"] = safe(cf.zone)
    if "name_servers" in report["zone"]:
        report["zone"]["ns_match_probe_config"] = sorted(report["zone"]["name_servers"] or []) == sorted(cfg["probe"]["authoritative_ns"])
    expected = cfg["expected_hostnames"]

    def domains():
        present = sorted(r["hostname"] for r in cf.domains())
        return {"expected": len(expected), "present": len(set(present) & set(expected)),
                "missing": sorted(set(expected) - set(present)), "unexpected": sorted(set(present) - set(expected))}
    report["domains"] = safe(domains)
    bindings = safe(cf.bindings)
    if isinstance(bindings, list):
        report["binding_names"] = sorted(b["name"] for b in bindings)
        report["pause_secret_present"] = cfapi.PAUSE_SECRET in report["binding_names"]
        report["budget"] = safe(lambda: cf.budget(bindings))
    else:
        report["binding_names"] = bindings
        report["budget"] = {"error": "bindings unavailable, budget not read"}
    report["deployments"] = safe(cf.deployments)
    report["recent_invocations_15m"] = safe(cf.recent_invocations)
    if incident:
        report["incident"] = {"id": incident["id"], "status": incident["status"], "sim": incident.get("sim", False),
                              "restores_used": incident.get("restores", 0),
                              "pause_clears_used": incident.get("pause_clears", 0), "limits": cfg["limits"]}
    report["suggested_branch"] = suggested_branch(report)
    if cfg.get("scenario"):
        report["simulation"] = {"scenario": cfg["scenario"].get("name"), "writes": "dry-run only"}
    return report


def restore_domains(cfg: dict, incident_id: str, dry_run: bool) -> dict:
    with drcommon.mutation_lock():  # status, limits and writes are checked and done under one lock
        return _restore_domains(cfg, incident_id, dry_run)


def _restore_domains(cfg: dict, incident_id: str, dry_run: bool) -> dict:
    incident = load_incident(incident_id, for_write=True)
    dry_run = dry_run or incident.get("sim", False) or cfg.get("scenario") is not None
    limits = cfg["limits"]
    now = drcommon.utcnow()
    st = drcommon.read_state()
    recent = [t for t in st["restores"] if (now - drcommon.parse_iso(t)).total_seconds() < 86400]
    if incident.get("restores", 0) >= limits["restores_per_incident"] or len(recent) >= limits["restores_per_24h"]:
        reason = ("Automatic restore limit reached (%d this incident, %d in 24 h). The budget watchdog keeps "
                  "disconnecting the domains; looping would not help." % (incident.get("restores", 0), len(recent)))
        escalate(cfg, incident_id, reason)
        raise Refused(3, reason)
    cf = make_cf(cfg, incident)
    bindings = cf.bindings()
    try:
        budget = cf.budget(bindings)
    except cfapi.UsageUnavailable as error:
        raise Refused(4, "Not restoring: could not read usage myself (%s). Spend below cap is unconfirmed." % error)
    if budget["stopSite"]:
        reason = ("Worker spend %.2f USD has reached the %s USD cap since %s. The shutdown is the guardrail working; "
                  "not restoring, not raising the cap." % (budget["worker_spend_usd"], budget["worker_cap_usd"], budget["since"]))
        escalate(cfg, incident_id, reason, {"budget": budget})
        raise Refused(5, reason, budget=budget)
    zone = cf.zone()
    if zone["status"] != "active":
        raise Refused(6, "Zone status is %s, not active; restoring Worker domains will not fix that." % zone["status"])
    present = {r["hostname"] for r in cf.domains()}
    missing = [h for h in cfg["expected_hostnames"] if h not in present]
    if not missing:
        return {"restored": [], "note": "All %d expected domains are already bound." % len(cfg["expected_hostnames"]), "budget": budget}
    with drcommon.state_txn() as st:  # reserve before writing so a crash still counts
        if st["incidents"][incident_id]["status"] != "open":
            raise Refused(6, "Incident %s was %s before any write" % (incident_id, st["incidents"][incident_id]["status"]))
        st["incidents"][incident_id]["restores"] = st["incidents"][incident_id].get("restores", 0) + 1
        if not dry_run:
            st["restores"] = [t for t in st["restores"] if (now - drcommon.parse_iso(t)).total_seconds() < 86400] + [drcommon.iso(now)]
    done, failed = [], []
    for hostname in missing:
        try:
            done.append(cf.put_domain(hostname, zone["id"], dry_run)["hostname"])
        except cfapi.CloudflareError as error:
            failed.append({"hostname": hostname, "error": str(error)})
    after = {r["hostname"] for r in cf.domains()}
    still_missing = [h for h in cfg["expected_hostnames"] if h not in after]
    result = {"dry_run": dry_run, "restored": done, "failed": failed, "still_missing": still_missing,
              "budget": {k: budget[k] for k in ("worker_spend_usd", "worker_cap_usd", "analytics_spend_usd", "analytics_cap_usd", "since")},
              "restores_used": incident.get("restores", 0) + 1, "restores_limit": limits["restores_per_incident"]}
    record_action(incident_id, "restore-domains", dry_run=dry_run, restored=len(done), failed=len(failed),
                  still_missing=len(still_missing), worker_spend_usd=budget["worker_spend_usd"])
    return result


def clear_pause(cfg: dict, incident_id: str, dry_run: bool) -> dict:
    with drcommon.mutation_lock():
        return _clear_pause(cfg, incident_id, dry_run)


def _clear_pause(cfg: dict, incident_id: str, dry_run: bool) -> dict:
    incident = load_incident(incident_id, for_write=True)
    dry_run = dry_run or incident.get("sim", False) or cfg.get("scenario") is not None
    if incident.get("pause_clears", 0) >= cfg["limits"]["pause_clears_per_incident"]:
        reason = "Analytics pause was already cleared once in this incident and is set again."
        escalate(cfg, incident_id, reason)
        raise Refused(3, reason)
    cf = make_cf(cfg, incident)
    bindings = cf.bindings()
    if not any(b["name"] == cfapi.PAUSE_SECRET for b in bindings):
        return {"cleared": False, "note": "POSTHOG_PAUSED_MONTH is not set."}
    try:
        budget = cf.budget(bindings)
    except cfapi.UsageUnavailable as error:
        raise Refused(4, "Not clearing: could not read usage myself (%s)." % error)
    if budget["pauseAnalytics"] or budget["stopSite"]:
        reason = ("Analytics pause is legitimate: analytics spend %.2f/%s USD, worker spend %.2f/%s USD since %s. Leaving it set."
                  % (budget["analytics_spend_usd"], budget["analytics_cap_usd"], budget["worker_spend_usd"], budget["worker_cap_usd"], budget["since"]))
        escalate(cfg, incident_id, reason, {"budget": budget})
        raise Refused(5, reason, budget=budget)
    with drcommon.state_txn() as st:
        if st["incidents"][incident_id]["status"] != "open":
            raise Refused(6, "Incident %s was %s before any write" % (incident_id, st["incidents"][incident_id]["status"]))
        st["incidents"][incident_id]["pause_clears"] = st["incidents"][incident_id].get("pause_clears", 0) + 1
    result = cf.delete_pause_secret(dry_run)
    still = any(b["name"] == cfapi.PAUSE_SECRET for b in cf.bindings())
    record_action(incident_id, "clear-pause", dry_run=dry_run, still_set=still, analytics_spend_usd=budget["analytics_spend_usd"])
    return {**result, "still_set": still, "dry_run": dry_run,
            "budget": {k: budget[k] for k in ("analytics_spend_usd", "analytics_cap_usd", "worker_spend_usd", "worker_cap_usd", "since")}}


def watch(cfg: dict, incident_id: str, seconds: int) -> dict:
    incident = load_incident(incident_id, for_write=False)
    seconds = max(0, min(seconds, cfg["limits"]["watch_max_s"]))
    cf = make_cf(cfg, incident)
    timeline = []
    deadline = time.monotonic() + seconds
    while True:
        fast = probe.fast_probe(cfg)
        entry = {"at": fast["at"], "class": fast["class"]}
        domains = safe(lambda: sorted(r["hostname"] for r in cf.domains()))
        entry["domains_present"] = len(domains) if isinstance(domains, list) else domains
        timeline.append(entry)
        if isinstance(domains, list) and len(set(domains) & set(cfg["expected_hostnames"])) < len(cfg["expected_hostnames"]) and len(timeline) > 1:
            entry["note"] = "domains disappeared again during watch"
            break
        if time.monotonic() + 30 > deadline:
            break
        time.sleep(30)
    return {"incident": incident_id, "seconds": seconds, "timeline": timeline}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe")
    for name in ("diagnose", "restore-domains", "clear-pause", "watch", "escalate"):
        p = sub.add_parser(name)
        p.add_argument("--incident", required=True)
        if name in ("restore-domains", "clear-pause"):
            p.add_argument("--dry-run", action="store_true")
        if name == "watch":
            p.add_argument("--seconds", type=int, default=150)
        if name == "escalate":
            p.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    cfg = drcommon.load_config()
    try:
        if args.command == "probe":
            return emit({"probe": probe.fast_probe(cfg), "public_dns": probe.public_view(cfg)})
        if args.command == "diagnose":
            report = diagnose(cfg, load_incident(args.incident, for_write=False))
            drcommon.log_event("diagnose", incident=args.incident, probe_class=report["probe"]["class"],
                               suggested_branch=report["suggested_branch"], domains=report.get("domains", {}).get("present"),
                               pause=report.get("pause_secret_present"), stop_site=report.get("budget", {}).get("stopSite"))
            return emit(report)
        if args.command == "restore-domains":
            return emit(restore_domains(cfg, args.incident, args.dry_run))
        if args.command == "clear-pause":
            return emit(clear_pause(cfg, args.incident, args.dry_run))
        if args.command == "watch":
            return emit(watch(cfg, args.incident, args.seconds))
        if args.command == "escalate":
            load_incident(args.incident, for_write=False)
            return emit(escalate(cfg, args.incident, args.reason))
    except Refused as refusal:
        return emit({"refused": str(refusal), "code": refusal.code, **refusal.extra}, refusal.code)
    except cfapi.CloudflareError as error:
        return emit({"error": str(error)}, 1)
    return 2


if __name__ == "__main__":
    sys.exit(main())
