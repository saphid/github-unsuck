"""ops.py guardrails: the budget cap, per-incident/24 h restore caps, simulation read-only, escalation."""
import contextlib
import io
import json

from helpers import FAKE_TOKEN, StateTestCase

import drcommon
import ops


def run_ops(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = ops.main(list(argv))
    return code, json.loads(out.getvalue())


class RestoreGuardrails(StateTestCase):
    def remove_all_domains(self):
        self.fake.domains = []

    def test_restores_missing_domains_when_usage_read_and_below_cap(self):
        self.remove_all_domains()
        incident = self.open_incident()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(out["restored"]), self.cfg["expected_hostnames"])
        self.assertEqual(out["still_missing"], [])
        puts = [c for c in self.fake.calls if c[0] == "PUT"]
        self.assertEqual(len(puts), 20)
        graphql_before_put = self.fake.calls.index(("POST", "graphql")) < self.fake.calls.index(puts[0])
        self.assertTrue(graphql_before_put, "usage must be read before any write")
        st = drcommon.read_state()
        self.assertEqual(st["incidents"][incident]["restores"], 1)
        self.assertEqual(len(st["restores"]), 1)

    def test_refuses_and_escalates_when_worker_spend_at_cap(self):
        self.remove_all_domains()
        self.fake.requests = 8_000_000  # exactly $4.00
        incident = self.open_incident()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 5)
        self.assertEqual(self.fake.writes(), [])
        self.assertEqual(drcommon.read_state()["incidents"][incident]["status"], "escalated")
        self.assertIn("ESCALATED", self.notifications())

    def test_refuses_when_usage_cannot_be_read(self):
        self.remove_all_domains()
        self.fake.usage_fails = 99
        incident = self.open_incident()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 4)
        self.assertEqual(self.fake.writes(), [])
        self.assertEqual(len([c for c in self.fake.calls if c[1] == "graphql"]), 3, "three usage attempts")

    def test_transient_usage_failure_is_retried(self):
        self.remove_all_domains()
        self.fake.usage_fails = 2
        incident = self.open_incident()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 0, out)

    def test_restore_cap_per_incident_then_escalates(self):
        incident = self.open_incident()
        for _ in range(2):
            self.remove_all_domains()
            code, _ = run_ops("restore-domains", "--incident", incident)
            self.assertEqual(code, 0)
        self.remove_all_domains()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 3)
        self.assertEqual(len([c for c in self.fake.calls if c[0] == "PUT"]), 40)
        self.assertEqual(drcommon.read_state()["incidents"][incident]["status"], "escalated")

    def test_rolling_24h_cap_across_incidents(self):
        with drcommon.state_txn() as st:
            st["restores"] = [drcommon.iso()] * 3
        self.remove_all_domains()
        incident = self.open_incident()
        code, _ = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 3)
        self.assertEqual(self.fake.writes(), [])

    def test_simulated_incident_never_writes(self):
        self.remove_all_domains()
        incident = self.open_incident(sim=True)
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 0, out)
        self.assertTrue(out["dry_run"])
        self.assertEqual(self.fake.writes(), [])

    def test_escalated_incident_refuses_writes(self):
        self.remove_all_domains()
        incident = self.open_incident(status="escalated")
        code, _ = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 6)
        self.assertEqual(self.fake.writes(), [])

    def test_inactive_zone_refuses(self):
        self.remove_all_domains()
        self.fake.zone_status = "pending"
        incident = self.open_incident()
        code, _ = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 6)
        self.assertEqual(self.fake.writes(), [])

    def test_unknown_incident_refused(self):
        code, _ = run_ops("restore-domains", "--incident", "INC-NOPE")
        self.assertEqual(code, 2)


class PauseGuardrails(StateTestCase):
    def test_clears_pause_below_cap_once(self):
        self.fake.pause = True
        incident = self.open_incident()
        code, out = run_ops("clear-pause", "--incident", incident)
        self.assertEqual(code, 0, out)
        self.assertFalse(out["still_set"])
        self.fake.pause = True
        code, _ = run_ops("clear-pause", "--incident", incident)
        self.assertEqual(code, 3)

    def test_legitimate_pause_is_left_and_escalated(self):
        self.fake.pause = True
        self.fake.subrequests = 80_000  # $4.00 analytics
        incident = self.open_incident()
        code, _ = run_ops("clear-pause", "--incident", incident)
        self.assertEqual(code, 5)
        self.assertEqual(self.fake.writes(), [])
        self.assertTrue(self.fake.pause)


class Diagnose(StateTestCase):
    def setUp(self):
        super().setUp()
        import probe
        self.addCleanup(setattr, probe, "fast_probe", probe.fast_probe)
        self.addCleanup(setattr, probe, "public_view", probe.public_view)
        probe.public_view = lambda cfg: []
        self.probe_class = "dns-missing"
        probe.fast_probe = lambda cfg: {"at": drcommon.iso(), "class": self.probe_class, "hosts": [], "summary": self.probe_class, "local_dns_ok": True}

    def branch(self):
        incident = self.open_incident()
        code, out = run_ops("diagnose", "--incident", incident)
        self.assertEqual(code, 0)
        self.assertNotIn(FAKE_TOKEN, json.dumps(out))
        return out["suggested_branch"]

    def test_branches(self):
        self.fake.domains = []
        self.assertEqual(self.branch(), "A1-restore")
        self.fake.requests = 9_000_000
        self.assertEqual(self.branch(), "A2-cap-reached")
        self.fake.requests, self.fake.usage_fails = 1, 99
        self.assertEqual(self.branch(), "A3-usage-unknown")

    def test_pause_and_worker_and_false_alarm(self):
        self.fake.pause = True
        self.probe_class = "healthy"
        self.assertEqual(self.branch(), "B1-clear-pause")
        self.fake.pause = False
        self.probe_class = "http-failing"
        self.assertEqual(self.branch(), "C-worker-error")
        self.probe_class = "healthy"
        self.assertEqual(self.branch(), "E-false-alarm")
        self.probe_class = "vantage-broken"
        self.assertEqual(self.branch(), "E-vantage")
        self.fake.zone_status = "moved"
        self.assertEqual(self.branch(), "D-dns-zone")


class ReviewRegressions(StateTestCase):
    def test_malformed_usage_row_is_unavailable_not_zero(self):
        self.fake.domains = []
        fake = self.fake

        def transport(method, url, headers, body, timeout):
            if url.endswith("/graphql") and "dimensions" not in body.decode():
                fake.calls.append((method, "graphql"))
                return 200, {"data": {"viewer": {"accounts": [{"workersInvocationsAdaptive": [{"sum": {}}]}]}}}
            return fake(method, url, headers, body, timeout)
        import cfapi
        orig_init = cfapi.Cloudflare.__init__

        def patched(obj, cfg, token_provider=None, transport_=None, read_only=False, sleep=None, **kw):
            orig_init(obj, cfg, read_only=read_only)
            obj.transport = transport
        cfapi.Cloudflare.__init__ = patched
        self.addCleanup(setattr, cfapi.Cloudflare, "__init__", orig_init)
        incident = self.open_incident()
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 4, out)
        self.assertEqual(self.fake.writes(), [])

    def test_escalation_during_restore_stops_writes(self):
        """A restore that finds the incident escalated at reservation time writes nothing."""
        self.fake.domains = []
        incident = self.open_incident()
        import cfapi
        orig_zone = cfapi.Cloudflare.zone

        def zone_then_escalated(obj):
            with drcommon.state_txn() as st:
                st["incidents"][incident]["status"] = "escalated"
            return orig_zone(obj)
        cfapi.Cloudflare.zone = zone_then_escalated
        self.addCleanup(setattr, cfapi.Cloudflare, "zone", orig_zone)
        code, out = run_ops("restore-domains", "--incident", incident)
        self.assertEqual(code, 6, out)
        self.assertEqual([c for c in self.fake.calls if c[0] == "PUT"], [])

    def test_mutation_lock_is_reentrant(self):
        with drcommon.mutation_lock():
            with drcommon.mutation_lock():
                pass
