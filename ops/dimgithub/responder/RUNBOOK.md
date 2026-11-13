# dimgithub.com outage runbook

The responder agent follows this runbook, and people can use it too. The agent reaches production only through
`ops.py`. Each branch below gives the exact subcommand. People can run the same commands on lxso1 as
`python3 ~/.local/lib/dimgithub-responder/ops.py …`.

## Background: why the site disappears

The Worker has a cron job that runs every minute as a **budget watchdog**. It reads Cloudflare usage since
`max(month start, BUDGET_START_AT)`. It acts in two cases:

- **The usage read fails** (after three attempts) **or worker spend reaches $4** (requests × $0.50/M). The
  watchdog deletes every `dimgithub.com` custom-domain binding. The hostnames then stop resolving
  ("can't find server"). The authoritative nameservers return NOERROR with no address for the apex and
  NXDOMAIN for subdomains.
- **The usage read fails, or analytics spend reaches $4** (subrequests × $50/M). The watchdog sets the
  secret `POSTHOG_PAUSED_MONTH`, and analytics forwarding stops. The site itself stays up.

A usage-read failure sets both. On 2026-11-12 one transient read failure took the site down while spend was
far below the cap. The cap is a deliberate guardrail. Never raise it, remove it, or work around it. The
responder has no tool that could.

## Always first

1. `ops.py diagnose --incident ID`. Read `probe.class`, `domains.missing`, `pause_secret_present`, `budget`,
   `zone`, `recent_invocations_15m` and `suggested_branch`. The suggestion comes from a fixed rule. Check it
   against the data before you use it.
2. Choose the branch that matches what `diagnose` shows now. The trigger text may be stale.
3. If both A and B apply (a watchdog shutdown sets both), do A first, then B.

Exit codes from `ops.py`: 0 ok, 1 Cloudflare API error, 3 limit reached (already escalated),
4 usage unavailable (refused), 5 budget cap reached (already escalated), 6 precondition refused.

## A. Custom-domain bindings deleted (watchdog shutdown)

Signs: `domains.missing` is not empty. `probe.class` is usually `dns-missing`.

- **A1-restore**: `budget` read succeeded and `budget.stopSite` is false.
  1. `ops.py restore-domains --incident ID`. The tool reads usage again itself and refuses if spend is at the
     cap. It re-creates only the missing hostnames listed in `ops/dimgithub/wrangler.jsonc`, then reads the list
     back.
  2. `ops.py watch --incident ID --seconds 180`. The watchdog runs every minute. If its usage reads are still
     failing, it deletes the bindings again within a minute or two.
  3. If the bindings disappeared again, run `restore-domains` **one** more time, then watch again.
     The tool allows 2 restores per incident and 3 per 24 h. At the limit it refuses with exit 3 and escalates.
     Stop there and do not loop.
  4. Then check branch B. The pause secret is usually set as well.
- **A2-cap-reached**: `budget.stopSite` is true. This is real spend at the cap and the guardrail working.
  Do not restore. `restore-domains` would refuse with exit 5 and escalate. If you have not called it, run
  `ops.py escalate --incident ID --reason "Worker spend has reached the $4 cap; site is down by design until
  the next month or until Alex changes the cap."` Then stop.
- **A3-usage-unknown**: `budget.error` is set, so spend below the cap cannot be confirmed. Wait and re-check
  once with `ops.py watch --incident ID --seconds 60`, then `diagnose`. If usage is still unreadable, escalate:
  "Cannot read Cloudflare usage; the watchdog is probably failing the same way. Not restoring blind." Then stop.

## B. Pause secret set (`POSTHOG_PAUSED_MONTH`)

Signs: `pause_secret_present` is true. The site can be up.

- **B1-clear-pause**: usage was read and both `pauseAnalytics` and `stopSite` are false. Run
  `ops.py clear-pause --incident ID`. The tool re-reads usage and refuses at either cap. Allowed once per
  incident. Confirm with `diagnose`.
- **B2-pause-legitimate**: `pauseAnalytics` or `stopSite` is true. The pause is correct. Leave it. Escalate
  with a report only: "Analytics paused at cap; no action taken."
- **B3-usage-unknown**: usage is unreadable. Escalate. Do not clear the pause blind.

## C. Worker erroring or returning non-200

Signs: bindings complete, authoritative DNS answers, `probe.class` is `http-failing`, and the control URL
works.

Look at `recent_invocations_15m` (`scriptThrewException`, `exceededCpu`, `exceededResources`, error counts)
and `deployments` (a recent deploy?). The responder cannot deploy or roll back, by design. Escalate with
the evidence: HTTP status, error statuses, newest deployment time and version id, and the previous version
id. Suggest the fix for Alex to run himself, for example
`wrangler rollback <previous-version-id> --config ops/dimgithub/wrangler.jsonc`. If the failure is a 1xxx
edge error with no Worker errors, say so: it may be a Cloudflare incident.

## D. DNS or zone problem

Signs: `zone.status` is not `active`, `zone.ns_match_probe_config` is false, the zone lookup errors, or the
authoritative servers return no address while all 20 bindings are present.

Escalate with the evidence and change nothing. `restore-domains` refuses when the zone is not active.
Registrar, nameserver and DNSSEC changes are for Alex.

## E. The site is actually fine (false alarm or broken vantage)

- **E-false-alarm**: `probe.class` is `healthy`, 20/20 bindings, no pause secret, zone active. The blip
  has passed. Make no writes and do not escalate. Outcome `false-alarm`.
- **E-vantage**: `probe.class` is `vantage-broken`, so lxso1 cannot reach the nameservers or the control URL.
  The Cloudflare API still answers, bindings are complete, and `recent_invocations_15m` shows successful
  requests. Make no writes. Outcome `false-alarm`, with a summary that names the vantage problem.
- Expected and harmless: right after a restore, public resolvers (`public_dns`), this Mac, or the home
  resolver can keep a negative answer for up to 30 minutes (SOA minimum TTL 1800). If the authoritative
  path is healthy, the site is up. This needs no action.

## Anything else

If nothing above fits, escalate with what `diagnose` shows. Do not improvise production changes.

## Finish

End with the `RESULT {...}` line that the prompt asks for. The launcher verifies the site itself and
reports to Alex. Your summary goes in that report.

## Never

Deploy the worker. Change `BUDGET_START_AT`, the caps, `CLOUDFLARE_BUDGET_TOKEN`, the cron or the rate
limiter. Delete bindings. Touch other zones or Workers. Message anyone. `ops.py` offers none of these.
