"""Probe classification, simulation overrides, and parity with the worker's budget guard."""
import datetime as dt
import json
import pathlib
import re
import unittest

from helpers import APP, StateTestCase, host_result

import cfapi
import drcommon
import probe

REPO_DIMGITHUB = APP.parent


class Classify(unittest.TestCase):
    def test_healthy(self):
        self.assertEqual(probe.classify([host_result("a"), host_result("b")], None), "healthy")

    def test_local_dns_failure_alone_is_healthy(self):
        hosts = [host_result("a", local_ok=False), host_result("b", local_ok=False)]
        self.assertEqual(probe.classify(hosts, None), "healthy")

    def test_authoritative_empty_is_dns_missing(self):
        self.assertEqual(probe.classify([host_result("a", auth="empty"), host_result("b")], {"ok": True}), "dns-missing")

    def test_http_failure_with_working_control(self):
        self.assertEqual(probe.classify([host_result("a", http_ok=False, status=500), host_result("b")], {"ok": True}), "http-failing")

    def test_http_failure_with_broken_control_is_vantage(self):
        self.assertEqual(probe.classify([host_result("a", http_ok=False, status=0)], {"ok": False}), "vantage-broken")

    def test_unreachable_nameservers_is_vantage(self):
        self.assertEqual(probe.classify([host_result("a", auth="unreachable")], {"ok": True}), "vantage-broken")

    def test_partial_outage_is_not_masked_by_broken_control(self):
        hosts = [host_result("a"), host_result("b", http_ok=False, status=500)]
        self.assertEqual(probe.classify(hosts, {"ok": False}), "http-failing")

    def test_received_http_error_is_not_vantage(self):
        self.assertEqual(probe.classify([host_result("a", http_ok=False, status=522)], {"ok": False}), "http-failing")

    def test_dig_parsing(self):
        sample = (";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n"
                  "dimgithub.com.\t\t300\tIN\tA\t104.21.70.36\ndimgithub.com.\t\t300\tIN\tA\t172.67.219.31\n")
        self.assertEqual(probe.A_RECORD.findall(sample), ["104.21.70.36", "172.67.219.31"])
        self.assertEqual(probe.STATUS.search(sample).group(1), "NOERROR")


class Overrides(StateTestCase):
    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, probe, "authoritative", probe.authoritative)
        self.addCleanup(setattr, probe, "http_health", probe.http_health)
        self.addCleanup(setattr, probe, "local_resolve", probe.local_resolve)
        self.addCleanup(setattr, probe, "control", probe.control)
        probe.authoritative = lambda host, cfg: {"state": "answer", "ips": ["104.21.70.36"], "per_ns": []}
        probe.http_health = lambda host, ip, cfg: {"via": ip, "status": 200, "ok": True, "ms": 1}
        probe.local_resolve = lambda host: {"ok": True, "ips": ["1.1.1.1"]}
        probe.control = lambda cfg: {"ok": True}

    def scenario(self, name):
        self.cfg["scenario"] = json.loads((APP / "scenarios" / (name + ".json")).read_text())

    def test_real_path_is_healthy(self):
        self.assertEqual(probe.fast_probe(self.cfg)["class"], "healthy")

    def test_bindings_deleted_scenario_heals_after_dry_run_write(self):
        self.scenario("bindings-deleted")
        self.assertEqual(probe.fast_probe(self.cfg)["class"], "dns-missing")
        (drcommon.state_dir() / "sim.json").write_text(json.dumps({"healed_domains": True}))
        self.assertEqual(probe.fast_probe(self.cfg)["class"], "healthy")

    def test_local_dns_only_scenario_stays_healthy_with_note(self):
        self.scenario("local-dns-only")
        result = probe.fast_probe(self.cfg)
        self.assertEqual(result["class"], "healthy")
        self.assertIn("local-dns-only", result["note"])

    def test_worker_error_scenario(self):
        self.scenario("worker-error")
        self.assertEqual(probe.fast_probe(self.cfg)["class"], "http-failing")


class BudgetParity(unittest.TestCase):
    """The responder's cap arithmetic must equal the deployed guard's."""

    PATTERN = re.compile(r"pauseAnalytics:\w+\.subrequests\*([0-9.e-]+)>=([0-9.]+),stopSite:\w+\.requests\*([0-9.e-]+)>=([0-9.]+)")

    def setUp(self):
        if not (REPO_DIMGITHUB / "budget.current.mjs").exists():
            self.skipTest("worker sources not present (installed copy); parity runs in the repository")

    def constants(self, name):
        text = (REPO_DIMGITHUB / name).read_text()
        match = self.PATTERN.search(text)
        self.assertIsNotNone(match, "budget decision not found in " + name)
        return [float(x) for x in match.groups()]

    def test_matches_snapshot_and_production_bundle(self):
        cfg = json.loads((APP / "config.default.json").read_text())["budget"]
        mine = [cfg["posthog_dollars_per_subrequest"], cfg["analytics_cutoff_dollars"],
                cfg["worker_dollars_per_request"], cfg["worker_cutoff_dollars"]]
        for name in ("budget.current.mjs", "worker.candidate.mjs"):
            self.assertEqual(self.constants(name), mine, name)

    def test_accounting_start_is_max_of_month_and_deployed_start(self):
        for name in ("budget.current.mjs", "worker.candidate.mjs"):
            self.assertRegex((REPO_DIMGITHUB / name).read_text(), r"Math\.max\(Date\.parse\(")
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        self.assertEqual(drcommon.iso(cfapi.budget_start(now, "2026-11-10T23:39:20.437756Z")), "2026-11-10T23:39:20Z")
        self.assertEqual(cfapi.js_iso(cfapi.budget_start(now, "2026-11-10T23:39:20.437756Z")), "2026-11-10T23:39:20.437Z")
        self.assertEqual(drcommon.iso(cfapi.budget_start(dt.datetime(2026, 12, 2, tzinfo=dt.timezone.utc), "2026-11-10T23:39:20Z")),
                         "2026-12-01T00:00:00Z")

    def test_cap_boundaries(self):
        cfg = json.loads((APP / "config.default.json").read_text())
        self.assertFalse(cfapi.budget_decision(cfg, {"requests": 7_999_999, "subrequests": 79_999})["stopSite"])
        decision = cfapi.budget_decision(cfg, {"requests": 8_000_000, "subrequests": 80_000})
        self.assertTrue(decision["stopSite"] and decision["pauseAnalytics"])

    def test_expected_hostnames_come_from_wrangler(self):
        cfg = drcommon.load_config()
        self.assertEqual(len(cfg["expected_hostnames"]), 20)
        self.assertIn("dimgithub.com", cfg["expected_hostnames"])
        self.assertIn("t3-code-dark.dimgithub.com", cfg["expected_hostnames"])


class AuthoritativeCorroboration(StateTestCase):
    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, probe, "dig", probe.dig)
        self.answers = {}
        probe.dig = lambda host, ns, timeout: dict(self.answers.get(ns, {"status": "UNREACHABLE"}), ns=ns)

    def test_single_negative_answer_is_not_an_outage(self):
        self.answers = {"172.64.33.103": {"status": "NXDOMAIN", "ips": []}}
        self.assertEqual(probe.authoritative("dimgithub.com", self.cfg)["state"], "unreachable")

    def test_two_negative_answers_are(self):
        self.answers = {"172.64.33.103": {"status": "NXDOMAIN", "ips": []}, "173.245.58.134": {"status": "NOERROR", "ips": []}}
        self.assertEqual(probe.authoritative("dimgithub.com", self.cfg)["state"], "empty")

    def test_queries_nameservers_by_ip_without_recursive_dns(self):
        self.answers = {"172.64.33.103": {"status": "NOERROR", "ips": ["104.21.70.36"]}}
        result = probe.authoritative("dimgithub.com", self.cfg)
        self.assertEqual(result["state"], "answer")
        self.assertEqual(result["per_ns"][0]["via"], "172.64.33.103")


class HealthBody(StateTestCase):
    def test_non_object_json_is_unhealthy_not_a_crash(self):
        self.addCleanup(setattr, probe, "run", probe.run)
        for body in ("[]", "null", "\"ok\"", "{\"ok\": false}"):
            probe.run = lambda argv, timeout, body=body: (0, body + "\n200")
            self.assertFalse(probe.http_health("dimgithub.com", "1.2.3.4", self.cfg)["ok"], body)
        probe.run = lambda argv, timeout: (0, '{"ok":true}\n200')
        self.assertTrue(probe.http_health("dimgithub.com", "1.2.3.4", self.cfg)["ok"])
