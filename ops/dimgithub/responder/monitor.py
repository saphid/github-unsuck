#!/usr/bin/env python3
"""dimgithub.com outage monitor: detect, confirm, lock, launch one responder, report.

  monitor.py run              long-running loop (systemd user service on lxso1)
  monitor.py tick             one iteration (tests, manual)
  monitor.py status           heartbeat, last probe, open incident, responder state, recent events
  monitor.py pause --minutes N   keep probing but open no incidents (planned work)
  monitor.py resume
  monitor.py ack --incident ID   close an escalated incident by hand

The monitor itself never writes to Cloudflare; only the responder's ops.py can,
under its guardrails.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time

import cfapi
import drcommon
import notify
import probe

STARTUP_GRACE_S = 120


def _since(value) -> float | None:
    moment = drcommon.parse_iso(value)
    return None if moment is None else (drcommon.utcnow() - moment).total_seconds()


def responder_running(incident: dict) -> bool:
    if drcommon.lock_is_held("responder.lock"):
        return True
    runs = incident.get("runs") or []
    if runs and not runs[-1].get("finished_at"):
        age = _since(runs[-1].get("launched_at"))
        if age is not None and age < STARTUP_GRACE_S:
            return True  # launched, has not taken its lock yet
        with drcommon.state_txn() as st:
            last = st["incidents"][incident["id"]]["runs"][-1]
            if not last.get("finished_at"):
                last["finished_at"] = drcommon.iso()
                last["outcome"] = "lost: responder exited without finishing"
        drcommon.log_event("responder-lost", incident=incident["id"])
    return False


def launch_responder(cfg: dict, incident_id: str, reason: str) -> dict:
    if drcommon.lock_is_held("responder.lock"):
        drcommon.log_event("launch-skipped", incident=incident_id, reason="responder lock held")
        return {"launched": False, "reason": "responder lock held"}
    with drcommon.state_txn() as st:
        incident = st["incidents"][incident_id]
        runs = incident.setdefault("runs", [])
        if runs and not runs[-1].get("finished_at"):
            return {"launched": False, "reason": "a responder run is already reserved for this incident"}
        real = [r for r in runs if not str(r.get("outcome", "")).startswith("launch failed")]
        if incident["status"] != "open" or len(real) >= cfg["limits"]["responder_runs_per_incident"]:
            return {"launched": False, "reason": "incident not open or responder run limit reached"}
        run_no = len(runs) + 1
        unit = "dimgithub-responder-%s-r%d-%s" % (incident_id.lower(), run_no, secrets.token_hex(2))
        incident["runs"].append({"run": run_no, "launched_at": drcommon.iso(), "unit": unit, "reason": reason})
    env = {k: os.environ[k] for k in ("DIMGITHUB_STATE_DIR", "DIMGITHUB_SCENARIO", "DIMGITHUB_CONFIG") if os.environ.get(k)}
    cmd = [sys.executable, str(drcommon.APP_DIR / "responder.py"), "--incident", incident_id]
    if cfg["agent"]["launcher"] == "systemd" and shutil.which("systemd-run"):
        argv = ["systemd-run", "--user", "--quiet", "--collect", "--unit", unit,
                "-p", "RuntimeMaxSec=%d" % (cfg["agent"]["timeout_s"] + 300), "-p", "KillMode=control-group"]
        argv += ["--setenv=%s=%s" % item for item in env.items()] + cmd
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        ok, info = result.returncode == 0, (result.stderr or result.stdout).strip()[:300]
    else:
        with open(drcommon.state_dir() / ("%s.log" % unit), "a") as log:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                             env={**os.environ, **env})
        ok, info = True, "detached process"
    drcommon.log_event("responder-launched" if ok else "responder-launch-failed", incident=incident_id, unit=unit, run=run_no, info=info)
    if not ok:
        with drcommon.state_txn() as st:
            st["incidents"][incident_id]["runs"][-1].update(finished_at=drcommon.iso(), outcome="launch failed: " + info)
    return {"launched": ok, "unit": unit, "run": run_no, "info": info}


def cloudflare_evidence(cfg: dict) -> dict:
    cf = cfapi.Cloudflare(cfg, read_only=True)
    out = {}
    try:
        present = {r["hostname"] for r in cf.domains()}
        out["domains_present"] = len(present & set(cfg["expected_hostnames"]))
        out["domains_expected"] = len(cfg["expected_hostnames"])
        out["domains_missing"] = sorted(set(cfg["expected_hostnames"]) - present)
    except cfapi.CloudflareError as error:
        out["domains_error"] = str(error)
    try:
        bindings = cf.bindings()
        out["pause_secret_present"] = any(b["name"] == cfapi.PAUSE_SECRET for b in bindings)
        budget = cf.budget(bindings)
        out["budget"] = {k: budget[k] for k in ("worker_spend_usd", "worker_cap_usd", "worker_fraction", "analytics_spend_usd",
                                                "analytics_cap_usd", "analytics_fraction", "stopSite", "pauseAnalytics", "since")}
    except cfapi.CloudflareError as error:
        out["budget_error"] = str(error)
    try:
        zone = cf.zone()
        out["zone_status"] = zone["status"]
    except cfapi.CloudflareError as error:
        out["zone_error"] = str(error)
    return out


def open_incident(cfg: dict, kind: str, trigger_class: str, fast: dict, first_failure_at: str | None) -> str:
    sim = cfg.get("scenario") is not None
    incident_id = drcommon.new_incident_id(sim)
    confirmed_at = drcommon.iso()
    with drcommon.state_txn() as st:
        if st["open_incident"]:
            return st["open_incident"]
        st["incidents"][incident_id] = {
            "id": incident_id, "kind": kind, "class": trigger_class, "sim": sim, "status": "open",
            "first_failure_at": first_failure_at, "confirmed_at": confirmed_at, "opened_at": confirmed_at,
            "trigger": {"summary": fast["summary"], "probe": fast}, "runs": [], "actions": [],
            "restores": 0, "pause_clears": 0, "scenario": (cfg.get("scenario") or {}).get("name"),
        }
        st["open_incident"] = incident_id
    drcommon.log_event("incident-opened", incident=incident_id, kind=kind, cls=trigger_class, sim=sim,
                       first_failure_at=first_failure_at)
    launch = launch_responder(cfg, incident_id, "initial")
    evidence = cloudflare_evidence(cfg)
    public = probe.public_view(cfg)
    with drcommon.state_txn() as st:
        st["incidents"][incident_id]["trigger"].update(cloudflare=evidence, public_dns=public)
    bindings = ("%s/%s" % (evidence.get("domains_present"), evidence.get("domains_expected"))) if "domains_present" in evidence else "unreadable"
    short = ("🚨 dimgithub.com incident %s: %s, confirmed from lxso1 by authoritative DNS (not a local resolver). "
             "Worker domain bindings %s; pause secret %s. Responder agent %s."
             % (incident_id, trigger_class, bindings,
                "SET" if evidence.get("pause_secret_present") else ("not set" if "pause_secret_present" in evidence else "unknown"),
                "launched (%s)" % launch.get("unit") if launch["launched"] else "NOT launched: " + launch.get("reason", launch.get("info", ""))))
    detail = ("### dimgithub incident `%s` opened\n\n- class: `%s` (%s)\n- first failing probe: %s\n- confirmed: %s\n- responder: %s\n\n"
              "<details><summary>probe and Cloudflare evidence</summary>\n\n```json\n%s\n```\n</details>\n"
              % (incident_id, trigger_class, kind, first_failure_at, confirmed_at, json.dumps(launch),
                 json.dumps({"probe": fast["summary"], "cloudflare": evidence, "public_dns": public}, indent=1)))
    notify.notify(cfg, short, detail, sim=sim)
    return incident_id


def close_incident(cfg: dict, incident: dict, why: str) -> None:
    with drcommon.state_txn() as st:
        inc = st["incidents"][incident["id"]]
        inc["status"] = "resolved" if inc["status"] == "open" else "resolved-after-escalation"
        inc["closed_at"] = drcommon.iso()
        st["open_incident"] = None
        final = dict(inc)
    drcommon.log_event("incident-closed", incident=incident["id"], status=final["status"], why=why)
    actions = ", ".join("%s%s" % (a["kind"], " (dry-run)" if a.get("dry_run") else "") for a in final.get("actions", [])) or "none"
    duration = _since(final.get("first_failure_at") or final["opened_at"])
    short = ("✅ dimgithub.com incident %s closed (%s): %s. Duration about %d min. Production actions: %s."
             % (incident["id"], final["status"], why, int((duration or 0) // 60), actions))
    notify.notify(cfg, short, "### dimgithub incident `%s` closed\n\n%s\n" % (incident["id"], short), sim=final.get("sim", False))


def handle_open(cfg: dict, incident: dict, fast: dict) -> None:
    running = responder_running(incident)
    healthy_now = fast["class"] == "healthy"
    if incident["kind"] == "anomaly" and healthy_now and not running:
        anomalies, evidence = deep_anomalies(cfg, fast)
        # Recovery needs successful reads; unreadable evidence is not a clean bill of health.
        healthy_now = not anomalies and not any(k.endswith("_error") for k in evidence)
    with drcommon.state_txn() as st:
        inc = st["incidents"][incident["id"]]
        if healthy_now:
            inc.setdefault("healthy_since", drcommon.iso())
        else:
            inc.pop("healthy_since", None)
        incident = dict(inc)
    if healthy_now:
        stable = _since(incident.get("healthy_since")) or 0
        needed = 0 if incident["kind"] == "anomaly" else cfg["monitor"]["close_after_healthy_s"]
        if not running and stable >= needed:
            close_incident(cfg, incident, "healthy through the authoritative path for %d s" % stable
                           if incident["kind"] == "outage" else "Cloudflare deep check clean")
        return
    if running:
        return
    if incident["status"] == "open":
        import ops  # local import: ops pulls in the same modules
        real_runs = [r for r in incident.get("runs", []) if not str(r.get("outcome", "")).startswith("launch failed")]
        failed_launches = len(incident.get("runs", [])) - len(real_runs)
        if failed_launches >= 3:
            ops.escalate(cfg, incident["id"], "The responder could not be launched %d times (systemd-run). Site is %s; nothing was changed."
                         % (failed_launches, fast["class"]), {"probe": fast["summary"]})
        elif len(real_runs) < cfg["limits"]["responder_runs_per_incident"]:
            launch_responder(cfg, incident["id"], "still %s after previous responder run" % fast["class"])
        else:
            ops.escalate(cfg, incident["id"], "Still %s after %d responder runs; automatic response exhausted."
                         % (fast["class"], len(real_runs)), {"probe": fast["summary"]})
    elif incident["status"] == "escalated":
        if (_since(incident.get("last_reminder")) or 0) >= cfg["monitor"]["escalated_reminder_s"]:
            with drcommon.state_txn() as st:
                st["incidents"][incident["id"]]["last_reminder"] = drcommon.iso()
            notify.notify(cfg, "⏰ dimgithub.com incident %s is still escalated and %s." % (incident["id"], fast["class"]),
                          sim=incident.get("sim", False))


def deep_anomalies(cfg: dict, fast: dict) -> tuple[list, dict]:
    evidence = cloudflare_evidence(cfg)
    anomalies = []
    if evidence.get("domains_missing"):
        anomalies.append("bindings-partial")
    if evidence.get("pause_secret_present"):
        anomalies.append("analytics-paused")
    if evidence.get("zone_status") and evidence["zone_status"] != "active":
        anomalies.append("zone-" + evidence["zone_status"])
    return anomalies, evidence


def deep_check(cfg: dict, fast: dict) -> None:
    anomalies, evidence = deep_anomalies(cfg, fast)
    errors = [k for k in evidence if k.endswith("_error")]
    with drcommon.state_txn() as st:
        m = st["monitor"]
        m["last_deep"] = {"at": drcommon.iso(), "anomalies": anomalies, "evidence": evidence}
        if errors:
            m.setdefault("deep_error_since", drcommon.iso())
        else:
            m.pop("deep_error_since", None)
            m.pop("deep_error_notified", None)
        deep_error_since = m.get("deep_error_since")
        deep_error_notified = m.get("deep_error_notified")
        notes = st["notes"]
    if errors and not deep_error_notified and (_since(deep_error_since) or 0) >= 3600:
        notify.notify(cfg, "⚠️ dimgithub monitor on lxso1 has been unable to read the Cloudflare API for over an hour (%s). "
                      "Outage detection still works; automatic diagnosis and restore do not." % ", ".join(errors), sim=cfg.get("scenario") is not None)
        with drcommon.state_txn() as st:
            st["monitor"]["deep_error_notified"] = drcommon.iso()
    budget = evidence.get("budget") or {}
    month = drcommon.utcnow().strftime("%Y-%m")
    for which in ("worker", "analytics"):
        fraction = budget.get(which + "_fraction")
        key = "budget-warning-%s-%s" % (which, month)
        if fraction is not None and fraction >= cfg["monitor"]["budget_warning_fraction"] and key not in notes:
            with drcommon.state_txn() as st:
                st["notes"][key] = drcommon.iso()
            notify.notify(cfg, "⚠️ dimgithub %s spend is at %d%% of its $%s cap this month. At 100%% the watchdog takes the site down by design."
                          % (which, int(fraction * 100), budget.get(which + "_cap_usd")), sim=cfg.get("scenario") is not None)
    if anomalies and fast["class"] == "healthy":
        st = drcommon.read_state()
        if not st["open_incident"] and not st["monitor"].get("paused_until_active"):
            open_incident(cfg, "anomaly", "+".join(anomalies), fast, drcommon.iso())


def paused(st: dict) -> bool:
    until = drcommon.parse_iso(st["monitor"].get("paused_until"))
    return bool(until and until > drcommon.utcnow())


def tick(cfg: dict) -> dict:
    fast = probe.fast_probe(cfg)
    down = fast["class"] in probe.DOWN_CLASSES
    with drcommon.state_txn() as st:
        m = st["monitor"]
        previous = m.get("last_class")
        m.update(heartbeat=drcommon.iso(), last_class=fast["class"], last_summary=fast["summary"], local_dns_ok=fast["local_dns_ok"])
        if down:
            m["consecutive_failures"] = m.get("consecutive_failures", 0) + 1
            m.setdefault("first_failure_at", fast["at"])
        else:
            m["consecutive_failures"] = 0
            m.pop("first_failure_at", None)
        if fast["class"] == "vantage-broken":
            m.setdefault("vantage_broken_since", fast["at"])
        else:
            m.pop("vantage_broken_since", None)
            m.pop("vantage_notified", None)
        failures = m["consecutive_failures"]
        first_failure_at = m.get("first_failure_at")
        open_id = st["open_incident"]
        is_paused = paused(st)
        m["paused_until_active"] = is_paused
        due_deep = (_since((m.get("last_deep") or {}).get("at")) or 1e9) >= cfg["monitor"]["deep_check_interval_s"]
        vantage_since, vantage_notified = m.get("vantage_broken_since"), m.get("vantage_notified")
        incident = st["incidents"].get(open_id) if open_id else None
    if previous != fast["class"] or (fast.get("note") and previous != fast["class"]):
        drcommon.log_event("class-change", previous=previous, current=fast["class"], summary=fast["summary"])
    print(json.dumps({"at": fast["at"], "class": fast["class"], "failures": failures, "open": open_id, "summary": fast["summary"]}), flush=True)
    if incident:
        handle_open(cfg, incident, fast)
    elif down and failures >= cfg["monitor"]["confirm_failures"] and not is_paused:
        confirm = probe.fast_probe(cfg)
        if confirm["class"] in probe.DOWN_CLASSES:
            open_incident(cfg, "outage", confirm["class"], confirm, first_failure_at)
        else:
            drcommon.log_event("confirm-failed", first=fast["summary"], confirm=confirm["summary"])
    elif down and is_paused:
        drcommon.log_event("paused-skip", summary=fast["summary"])
    if not incident and due_deep and fast["class"] == "healthy":
        deep_check(cfg, fast)
    if vantage_since and not vantage_notified and (_since(vantage_since) or 0) >= cfg["monitor"]["vantage_alert_after_s"]:
        notify.notify(cfg, "⚠️ dimgithub monitor on lxso1 cannot reach Cloudflare's nameservers or the control URL (since %s). "
                      "This is the monitor's vantage, not necessarily the site." % vantage_since, sim=cfg.get("scenario") is not None)
        with drcommon.state_txn() as st:
            st["monitor"]["vantage_notified"] = drcommon.iso()
    if not down and not incident:
        notify.flush_outbox(cfg, max_items=1)  # bounded, and never while an outage is being confirmed
    return {"fast": fast, "failures": failures}


def run(cfg: dict) -> None:
    try:
        lock = drcommon.HeldLock("monitor.lock")  # one monitor per state dir
    except BlockingIOError:
        print("another monitor already holds monitor.lock", file=sys.stderr)
        sys.exit(1)
    drcommon.log_event("monitor-start", pid=os.getpid(), scenario=(cfg.get("scenario") or {}).get("name"))
    while True:
        started = time.monotonic()
        try:
            result = tick(cfg)
            failures = result["failures"]
        except Exception as error:  # keep the loop alive; systemd restarts on crash anyway
            drcommon.log_event("tick-error", error=drcommon.scrub(repr(error), 500))
            print("tick error: %r" % error, file=sys.stderr, flush=True)
            failures = 0
        st = drcommon.read_state()
        interval = cfg["monitor"]["fast_retry_s"] if failures and not st["open_incident"] else cfg["monitor"]["interval_s"]
        time.sleep(max(1.0, interval - (time.monotonic() - started)))
    lock.release()


def status() -> dict:
    st = drcommon.read_state()
    m = st["monitor"]
    out = {
        "heartbeat": m.get("heartbeat"), "heartbeat_age_s": _since(m.get("heartbeat")),
        "last_class": m.get("last_class"), "last_summary": m.get("last_summary"),
        "consecutive_failures": m.get("consecutive_failures"), "paused_until": m.get("paused_until"),
        "last_deep": (m.get("last_deep") or {}).get("at"), "last_deep_anomalies": (m.get("last_deep") or {}).get("anomalies"),
        "monitor_running": drcommon.lock_is_held("monitor.lock"), "responder_running": drcommon.lock_is_held("responder.lock"),
        "open_incident": st["incidents"].get(st["open_incident"]) if st["open_incident"] else None,
        "outbox": len(st["outbox"]),
        "recent_incidents": [{k: i.get(k) for k in ("id", "status", "class", "opened_at", "closed_at")}
                             for i in sorted(st["incidents"].values(), key=lambda i: i["opened_at"])[-5:]],
    }
    if out["open_incident"]:
        out["open_incident"] = {k: v for k, v in out["open_incident"].items() if k != "trigger"}
    events = drcommon.state_dir() / "events.jsonl"
    if events.exists():
        out["recent_events"] = [json.loads(line) for line in events.read_text().splitlines()[-8:]]
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    sub.add_parser("tick")
    sub.add_parser("status")
    p = sub.add_parser("pause")
    p.add_argument("--minutes", type=int, required=True)
    sub.add_parser("resume")
    a = sub.add_parser("ack")
    a.add_argument("--incident", required=True)
    args = parser.parse_args(argv)
    cfg = drcommon.load_config()
    if args.command == "run":
        run(cfg)
    elif args.command == "tick":
        try:
            lock = drcommon.HeldLock("monitor.lock")
        except BlockingIOError:
            print("the monitor service is running; use status instead", file=sys.stderr)
            return 1
        try:
            print(json.dumps(tick(cfg)["fast"]["summary"]))
        finally:
            lock.release()
    elif args.command == "status":
        print(json.dumps(status(), indent=1, default=str))
    elif args.command == "pause":
        import datetime as dt
        with drcommon.state_txn() as st:
            st["monitor"]["paused_until"] = drcommon.iso(drcommon.utcnow() + dt.timedelta(minutes=args.minutes))
        drcommon.log_event("paused", minutes=args.minutes)
    elif args.command == "resume":
        with drcommon.state_txn() as st:
            st["monitor"].pop("paused_until", None)
        drcommon.log_event("resumed")
    elif args.command == "ack":
        st = drcommon.read_state()
        incident = st["incidents"].get(args.incident)
        if not incident or st["open_incident"] != args.incident:
            print("not the open incident", file=sys.stderr)
            return 2
        close_incident(cfg, incident, "acknowledged and closed by hand")
    return 0


if __name__ == "__main__":
    sys.exit(main())
