"""Monitor: confirmation, debounce, one responder per incident, relaunch cap, close, vantage handling."""
import datetime as dt
import os

from helpers import StateTestCase, host_result

import drcommon
import monitor
import probe


class FakePopen:
    launches = []

    def __init__(self, cmd, **kwargs):
        FakePopen.launches.append(cmd)


class MonitorTests(StateTestCase):
    def setUp(self):
        super().setUp()
        FakePopen.launches = []
        self.addCleanup(setattr, monitor.subprocess, "Popen", monitor.subprocess.Popen)
        monitor.subprocess.Popen = FakePopen
        self.addCleanup(setattr, probe, "fast_probe", probe.fast_probe)
        self.addCleanup(setattr, probe, "public_view", probe.public_view)
        probe.public_view = lambda cfg: []
        self.sequence = []
        probe.fast_probe = self.next_probe
        self.cfg["monitor"]["deep_check_interval_s"] = 10**9  # deep checks tested separately

    def next_probe(self, cfg):
        cls = self.sequence.pop(0) if self.sequence else "healthy"
        hosts = {"healthy": [host_result("dimgithub.com")],
                 "local-dns-only": [host_result("dimgithub.com", local_ok=False)],
                 "dns-missing": [host_result("dimgithub.com", auth="empty")],
                 "http-failing": [host_result("dimgithub.com", http_ok=False, status=500)],
                 "vantage-broken": [host_result("dimgithub.com", auth="unreachable")]}[cls]
        actual = "healthy" if cls == "local-dns-only" else cls
        return {"at": drcommon.iso(), "class": actual, "hosts": hosts, "summary": cls, "local_dns_ok": cls != "local-dns-only"}

    def ticks(self, *classes, confirm=None):
        for cls in classes:
            # each tick consumes one probe, plus one more when it confirms
            self.sequence.append(cls)
            if confirm is not None:
                self.sequence.append(confirm)
            monitor.tick(self.cfg)

    def state(self):
        return drcommon.read_state()

    def test_green_and_local_dns_only_never_open_incidents(self):
        self.ticks("healthy", "local-dns-only", "local-dns-only", "local-dns-only", "healthy")
        self.assertIsNone(self.state()["open_incident"])
        self.assertEqual(FakePopen.launches, [])
        self.assertEqual(self.notifications(), "")

    def test_vantage_broken_never_opens_incident(self):
        self.ticks(*["vantage-broken"] * 5)
        self.assertIsNone(self.state()["open_incident"])
        self.assertEqual(FakePopen.launches, [])

    def test_single_failure_is_debounced(self):
        self.ticks("dns-missing", "healthy", "dns-missing", "healthy")
        self.assertIsNone(self.state()["open_incident"])

    def test_confirm_failure_on_reprobe_does_not_open(self):
        self.sequence = ["dns-missing"]
        monitor.tick(self.cfg)
        self.sequence = ["dns-missing", "healthy"]  # second failing tick, then the confirmation re-probe is healthy
        monitor.tick(self.cfg)
        self.assertIsNone(self.state()["open_incident"])

    def test_two_failures_open_one_incident_and_launch_once(self):
        self.sequence = ["dns-missing", "dns-missing", "dns-missing"]
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        st = self.state()
        incident_id = st["open_incident"]
        self.assertTrue(incident_id and incident_id.startswith("INC-"))
        self.assertEqual(len(FakePopen.launches), 1)
        self.assertIn("responder.py", " ".join(FakePopen.launches[0]))
        self.assertIn("incident %s" % incident_id, self.notifications())
        # flapping / continued failure while the responder is starting or running: no second launch
        self.ticks("dns-missing", "healthy", "dns-missing", "dns-missing")
        self.assertEqual(len(FakePopen.launches), 1)
        self.assertEqual(self.state()["open_incident"], incident_id)

    def test_responder_lock_blocks_second_launch(self):
        lock = drcommon.HeldLock("responder.lock")
        self.addCleanup(lock.release)
        self.sequence = ["dns-missing"] * 3
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        self.assertEqual(FakePopen.launches, [])
        self.assertIn("NOT launched", self.notifications())

    def finish_last_run(self):
        with drcommon.state_txn() as st:
            st["incidents"][st["open_incident"]]["runs"][-1]["finished_at"] = drcommon.iso()

    def test_one_responder_per_incident_then_escalate(self):
        self.sequence = ["dns-missing"] * 3
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        self.finish_last_run()
        self.ticks("dns-missing")
        self.assertEqual(len(FakePopen.launches), 1)
        st = self.state()
        self.assertEqual(st["incidents"][st["open_incident"]]["status"], "escalated")
        self.assertIn("ESCALATED", self.notifications())

    def test_launch_reservation_refuses_while_a_run_is_pending(self):
        self.sequence = ["dns-missing"] * 3
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        incident_id = self.state()["open_incident"]
        self.assertFalse(monitor.launch_responder(self.cfg, incident_id, "manual")["launched"])
        self.assertEqual(len(FakePopen.launches), 1)

    def test_anomaly_does_not_close_on_unreadable_evidence(self):
        self.cfg["monitor"]["deep_check_interval_s"] = 0
        self.fake.pause = True
        self.ticks("healthy")
        incident_id = self.state()["open_incident"]
        self.finish_last_run()
        self.fake.pause = False
        self.fake.usage_fails = 10**6
        self.fake.zone_status = None
        self.fake.domains = None  # makes the domain list unreadable
        self.ticks("healthy")
        self.assertEqual(self.state()["open_incident"], incident_id)

    def test_close_after_stable_health(self):
        self.sequence = ["dns-missing"] * 3
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        incident_id = self.state()["open_incident"]
        self.finish_last_run()
        self.ticks("healthy")
        self.assertEqual(self.state()["open_incident"], incident_id, "must stay open until stable")
        later = drcommon.utcnow() + dt.timedelta(seconds=self.cfg["monitor"]["close_after_healthy_s"] + 5)
        os.environ["DIMGITHUB_NOW"] = drcommon.iso(later)
        self.ticks("healthy")
        st = self.state()
        self.assertIsNone(st["open_incident"])
        self.assertEqual(st["incidents"][incident_id]["status"], "resolved")
        self.assertIn("closed (resolved)", self.notifications())

    def test_pause_suppresses_incidents(self):
        monitor.main(["pause", "--minutes", "30"])
        self.ticks(*["dns-missing"] * 4)
        self.assertIsNone(self.state()["open_incident"])

    def test_deep_check_opens_anomaly_for_pause_secret(self):
        self.cfg["monitor"]["deep_check_interval_s"] = 0
        self.fake.pause = True
        self.ticks("healthy")
        st = self.state()
        incident = st["incidents"][st["open_incident"]]
        self.assertEqual(incident["kind"], "anomaly")
        self.assertIn("analytics-paused", incident["class"])
        self.assertEqual(len(FakePopen.launches), 1)

    def test_incident_ids_are_unique_within_a_second(self):
        os.environ["DIMGITHUB_NOW"] = "2026-11-13T00:56:53Z"
        ids = {drcommon.new_incident_id(sim=True) for _ in range(50)}
        self.assertGreater(len(ids), 45)

    def test_failed_launches_do_not_use_runs_and_escalate_after_three(self):
        class Failed:
            returncode, stdout, stderr = 1, "", "Unit already loaded"
        self.cfg["agent"]["launcher"] = "systemd"
        self.addCleanup(setattr, monitor.shutil, "which", monitor.shutil.which)
        self.addCleanup(setattr, monitor.subprocess, "run", monitor.subprocess.run)
        monitor.shutil.which = lambda name: "/usr/bin/" + name
        monitor.subprocess.run = lambda *a, **k: Failed()
        self.sequence = ["dns-missing"] * 3
        monitor.tick(self.cfg)
        monitor.tick(self.cfg)
        incident_id = self.state()["open_incident"]
        self.ticks("dns-missing", "dns-missing")
        st = self.state()
        self.assertEqual(st["incidents"][incident_id]["status"], "open", "failed launches must not exhaust the run budget")
        self.ticks("dns-missing")
        st = self.state()
        self.assertEqual(st["incidents"][incident_id]["status"], "escalated")
        self.assertIn("could not be launched 3 times", self.notifications())

    def test_budget_warning_once_per_month(self):
        self.cfg["monitor"]["deep_check_interval_s"] = 0
        self.fake.requests = 6_400_000  # 80 % of the worker cap
        self.ticks("healthy", "healthy")
        self.assertEqual(self.notifications().count("worker spend is at 80%"), 1)
