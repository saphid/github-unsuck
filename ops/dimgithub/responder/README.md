# dimgithub.com outage monitor and responder

This system watches dimgithub.com from lxso1. When the site goes down, it starts one headless Claude Opus 5.5
agent that diagnoses the outage and fixes it under guardrails enforced in code. Alex hears about every incident and
its outcome. The incident log is [#3](https://github.com/saphid/github-unsuck/issues/3).

```
lxso1 (always on, linger)                                 Cloudflare
┌──────────────────────────────────────────────┐
│ dimgithub-monitor.service  (monitor.py run)  │  dig @ben/mary.ns.cloudflare.com ──► authoritative answer
│   every 30 s: authoritative DNS + curl       │  curl --resolve host:443:<auth IP> /api/health
│   --resolve /api/health (2 hosts)            │
│   2 consecutive failures + re-probe          │  every 10 min (read-only API, token from 1Password):
│   ──► incident, lock, systemd-run ───────┐   │  bindings 20/20, POSTHOG_PAUSED_MONTH, zone, usage
│                                          ▼   │
│ dimgithub-responder-<id>-r<n> (responder.py) │
│   claude-proxy claude-opus-5-5 -p            │
│   allowed tools: python3 ops.py …, Read      │──► ops.py restore-domains / clear-pause (guarded)
│   then verify + report                       │
└──────────────────────────────────────────────┘
        │ hermes-notify.py ──► private Discord channel
        └ gh issue comment ──► saphid/github-unsuck#3
```

## Detection that does not trust any recursive resolver

This Mac and the home resolver held a stale negative answer for dimgithub.com, and lxso1's resolver goes through the
same home resolver. So the probe asks Cloudflare's authoritative nameservers directly, by their fixed IP
addresses, so no recursive resolver is needed even to find them. It then fetches `/api/health` from the
address they return (`curl --resolve`), for `dimgithub.com` and `t3-code-dark.dimgithub.com`. If the first
edge address fails, it tries a second one. Local and public (DoH) resolvers are recorded as evidence only.
A "no address" verdict needs negative answers from both nameservers. A single negative answer is treated as
inconclusive. A health body that is not `{"ok": true}` counts as unhealthy.

| Class | Meaning | Incident? |
|---|---|---|
| `healthy` | authoritative answer and `{"ok":true}` on every probe host | no |
| healthy + `local-dns-only` note | site fine, this vantage's resolver is stale | no |
| `dns-missing` | an authoritative server says a host has no address (bindings deleted) | yes, after confirmation |
| `http-failing` | addresses exist and the health check fails: an HTTP error status was received, another probe host works, or the control URL works | yes, after confirmation |
| `vantage-broken` | lxso1 cannot reach the nameservers, or gets no HTTP response from any host and the control URL also fails | no (alert after 30 min) |

An incident opens on the second consecutive failing probe. The first failure triggers a fast retry after 10 s,
then the monitor runs one more re-probe. A deep check every 10 minutes catches problems the probe cannot see:
a partly deleted set of bindings, the analytics pause secret, an inactive zone, and spend at 75% of either
cap (a warning sent once a month).

## One responder per incident

- `state.json` permits one open incident at a time, and the monitor holds `monitor.lock`.
- The responder holds `responder.lock` for its whole life. A second launch exits immediately. The monitor
  never relaunches while the lock is held or within 120 s of a launch.
- An incident gets exactly one responder run. A launch is reserved atomically in `state.json` and refused
  while a run is pending. A launch that fails does not use up the run. Three failed launches escalate.
  If the site is still down after the run, the monitor escalates. The responder's own restore limit (two)
  covers the case where the watchdog deletes the bindings again.
- An escalated incident gets no further automatic writes, only a reminder every 12 h. It closes when the
  site has been healthy for 10 minutes, or by hand with `ack`.

## Guardrails (enforced in `ops.py`, not left to the prompt)

- `restore-domains`, `clear-pause` and `escalate` serialise on a shared lock. Incident status and limits are
  re-checked under that lock immediately before any write, so concurrent commands cannot exceed a limit or
  write after an escalation.
- `restore-domains` reads usage itself, with three attempts. If usage is unreadable or malformed (a missing
  field fails closed, as in the worker), it refuses.
  If worker spend is at or above $4, it refuses and escalates. It does nothing if the zone is not active.
  It re-creates only hostnames listed in `../wrangler.jsonc`. It is limited to 2 restores per incident and
  3 per rolling 24 h. At the limit it escalates instead of looping against a watchdog that keeps failing.
- `clear-pause` follows the same pattern. Both spends must be below cap. It runs once per incident.
- No command exists to deploy, change the caps or `BUDGET_START_AT`, touch the watchdog token or cron, or delete
  bindings. The agent runs with `--tools Bash,Read`, `--setting-sources project` (so lxso1's user-level
  grants, such as `Bash(claude-proxy:*)`, do not apply), `--strict-mcp-config` (no MCP servers), and
  permission only for `python3 ops.py …` and reading this directory. A live test on lxso1 confirmed that
  `claude-proxy --help` and `cat /etc/hostname` are refused while `ops.py` runs.
- Remaining limit: the agent runs as the same Unix user as everything else on lxso1. Its isolation is
  Claude Code's permission layer, not a separate account or credential broker. A broker (a separate user
  holding the token and exposing only the `ops.py` operations) would be the stronger design.
- The monitor itself never writes to Cloudflare.
- In simulation (`DIMGITHUB_SCENARIO` set, or the incident's `sim` flag), the Cloudflare transport refuses every
  non-GET request except the read-only GraphQL query.

## Credentials

The responder uses the Cloudflare API token from the 1Password item `dimgithub responder - Cloudflare API token`
(vault Agents). This is the same token as the worker's own `CLOUDFLARE_BUDGET_TOKEN`. It can read usage and
bindings, create custom domains and write script secrets. It is read through `/usr/local/bin/op-agent read`
when needed and kept in process memory only (the monitor caches it for 6 h). It is never written to disk,
logs, prompts or notifications, and every stored or sent text passes through `drcommon.scrub`.

## Where things live (lxso1)

| What | Where |
|---|---|
| code (copied from this directory by `install-lxso1.sh`) | `~/.local/lib/dimgithub-responder/` |
| service | `~/.config/systemd/user/dimgithub-monitor.service` (enabled; linger is on) |
| responder runs | transient units `dimgithub-responder-<incident>-r<n>` |
| state, events, agent transcripts | `~/.local/state/dimgithub-responder/` (`state.json`, `events.jsonl`, `runs/<incident>/`) |
| config override | `~/.config/dimgithub-responder/config.json` (sets the incident-log issue number) |
| wrapper | `~/.local/bin/dimgithub-responder` |

## Operate

```sh
ssh lxso1 dimgithub-responder status                   # heartbeat, last probe, open incident, recent events
ssh lxso1 systemctl --user status dimgithub-monitor     # service
ssh lxso1 journalctl --user -u dimgithub-monitor -f     # one line per probe
ssh lxso1 "systemctl --user list-units 'dimgithub-responder-*'"   # running responder, if any
ssh lxso1 dimgithub-responder pause --minutes 60       # planned work: keep probing, open no incidents
ssh lxso1 dimgithub-responder resume
ssh lxso1 dimgithub-responder ack --incident INC-…     # close an escalated incident by hand
ssh lxso1 systemctl --user disable --now dimgithub-monitor   # stop entirely
ssh lxso1 "systemctl --user stop 'dimgithub-responder-*'"   # kill a running responder
```

Install or update from the Mac: `ops/dimgithub/responder/install-lxso1.sh --issue 3`. It runs the tests
locally, stages the code to `~/.local/lib/dimgithub-responder.new` on lxso1 and runs the tests there. Only if
they pass does it activate the code and restart the service. Re-run it after
changing `ops/dimgithub/wrangler.jsonc`, because the responder restores exactly the hostnames listed there.

## Tests

```sh
python3 -m unittest discover -s ops/dimgithub/responder/tests -t ops/dimgithub/responder/tests
```

The tests use only the standard library, with no network or credentials (a fake Cloudflare transport and
scripted probes). They cover the classification, the guardrails (cap, usage unavailable, restore limits, sim
read-only, escalated incidents refuse writes), debounce and one launch per incident, the relaunch limit and
escalation, closing, pause, deep-check anomalies, budget warnings, the notification outbox, prompt and tool
restriction, and parity of the $4 caps and accounting start with `budget.current.mjs` and the production
`worker.candidate.mjs`.

## Simulations (end-to-end, production untouched)

```sh
ssh lxso1 'APP=~/.local/lib/dimgithub-responder; S=~/.local/state/dimgithub-responder-sim/bindings-deleted; mkdir -p $S
  systemd-run --user --unit dimgithub-sim --collect --setenv=DIMGITHUB_STATE_DIR=$S \
    --setenv=DIMGITHUB_SCENARIO=$APP/scenarios/bindings-deleted.json /usr/bin/python3 $APP/monitor.py run'
```

The scenarios are `bindings-deleted`, `cap-reached`, `rebinding-loop`, `worker-error` and `local-dns-only`.
A simulation reads real usage and replaces only the fields named in its scenario file. All writes are dry-run.
Notifications go out with a `[TEST: simulated incident, production untouched]` prefix. Its state and locks
are separate, so it can never block the live monitor. Stop it with
`systemctl --user stop dimgithub-sim`.

## Notification route, and why

Incidents reach Alex through lxso1's existing Hermes notification hook, which posts to a private Discord channel. Every message is also recorded on issue #3. Failed sends are retried with
backoff for 24 h.
