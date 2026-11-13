"""Responder prompt/argv safety, result parsing, notification outbox."""
import json
import os

from helpers import FAKE_TOKEN, StateTestCase

import drcommon
import notify
import responder


class ResponderTests(StateTestCase):
    def test_agent_tools_are_restricted(self):
        argv = responder.agent_argv({"name": "x", "argv": ["claude"]})
        allowed = argv[argv.index("--allowedTools") + 1: argv.index("--disallowedTools")]
        self.assertEqual(allowed, ["Bash(python3 %s:*)" % responder.OPS, "Read(%s/**)" % drcommon.APP_DIR])
        for tool in ("Write", "Edit", "WebFetch", "Task"):
            self.assertIn(tool, argv)
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "project")
        self.assertEqual(argv[argv.index("--tools") + 1], "Bash,Read")

    def test_missing_agent_binary_is_a_failed_route_not_a_crash(self):
        result = responder.run_agent(self.cfg, {"name": "gone", "argv": ["/nonexistent/claude"]}, "x", self.tmp.name, 600)
        self.assertFalse(result["ok"])
        self.assertIn("could not start", result["error"])

    def test_no_time_left_skips_route(self):
        result = responder.run_agent(self.cfg, {"name": "late", "argv": ["/bin/true"]}, "x", self.tmp.name, 10)
        self.assertFalse(result["ok"])

    def test_prompt_contains_runbook_and_no_secrets(self):
        os.environ["CLOUDFLARE_API_TOKEN"] = FAKE_TOKEN
        self.addCleanup(os.environ.pop, "CLOUDFLARE_API_TOKEN")
        incident_id = self.open_incident(sim=True)
        incident = drcommon.read_state()["incidents"][incident_id]
        incident["trigger"]["note"] = "Bearer " + FAKE_TOKEN
        prompt = responder.build_prompt(self.cfg, incident)
        self.assertIn("A1-restore", prompt)
        self.assertIn("THIS IS A SIMULATION", prompt)
        self.assertNotIn(FAKE_TOKEN, prompt)

    def test_parse_result(self):
        text = 'Did things.\nRESULT {"branch": "A1-restore", "outcome": "restored", "summary": "ok"}'
        self.assertEqual(responder.parse_result(text)["branch"], "A1-restore")
        self.assertEqual(responder.parse_result("no result line")["branch"], "unknown")


class NotifyTests(StateTestCase):
    def test_failed_channel_goes_to_outbox_and_is_retried_with_backoff(self):
        self.cfg["notify"]["channels"] = ["file", "github_issue"]  # github_issue has no issue number: fails
        results = notify.notify(self.cfg, "hello")
        self.assertTrue(results["file"]["ok"])
        self.assertFalse(results["github_issue"]["ok"])
        self.assertEqual(len(drcommon.read_state()["outbox"]), 1)
        self.assertEqual(notify.flush_outbox(self.cfg), 1)  # backoff: not retried immediately
        self.assertEqual(drcommon.read_state()["outbox"][0]["attempts"], 1)

    def test_outbox_keeps_message_until_delivered(self):
        self.cfg["notify"]["channels"] = ["github_issue"]
        notify.notify(self.cfg, "keep me")
        os.environ["DIMGITHUB_NOW"] = "2099-01-01T00:00:00Z"
        self.addCleanup(os.environ.pop, "DIMGITHUB_NOW", None)
        with drcommon.state_txn() as st:
            st["outbox"][0]["created"] = "2098-12-31T23:00:00Z"
            st["outbox"][0]["last"] = "2098-12-31T23:00:00Z"
        self.assertEqual(notify.flush_outbox(self.cfg), 1, "failed retry keeps the item")
        self.assertEqual(drcommon.read_state()["outbox"][0]["attempts"], 2)
        with drcommon.state_txn() as st:
            st["outbox"][0]["pending"] = ["file"]
            st["outbox"][0]["last"] = "2098-12-31T22:00:00Z"
        self.assertEqual(notify.flush_outbox(self.cfg), 0)
        self.assertIn("keep me", self.notifications())

    def test_sim_prefix_and_scrub(self):
        notify.notify(self.cfg, "token Bearer " + FAKE_TOKEN, sim=True)
        text = self.notifications()
        self.assertIn(notify.SIM_PREFIX.strip(), text)
        self.assertNotIn(FAKE_TOKEN, text)

    def test_events_log_has_no_secret(self):
        notify.notify(self.cfg, "x " + FAKE_TOKEN)
        self.assertNotIn(FAKE_TOKEN, (drcommon.state_dir() / "events.jsonl").read_text())
        self.assertNotIn(FAKE_TOKEN, json.dumps(drcommon.read_state()))
