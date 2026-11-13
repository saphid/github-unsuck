# Public-only deployment receipt — 2026-11-13

Production version `8e37a98a-2341-47cf-9c06-a6bbf1d4047b` serves 100% of dimgithub.com traffic. The live source readback matches `worker.candidate.mjs` byte for byte, SHA-256 `346b2ec2dd7b7324d0886397dd9d200e765972a2c183cc782d7cf335ab9c8906`.

Cloudflare readback: `bindings: []`, scheduled triggers `[]`, workers.dev disabled, preview URLs disabled. All 20 custom domains were restored and verified after containment; the apex and theme aliases answer health checks, and www redirects to the canonical host. Normal DNS health returns `{"ok":true}`. The lxso1 auto-responder remains disabled and inactive.

Validation: 46 focused tests pass; the no-bundle dry-run output matches the deployed source. Real workerd verification loaded public GitHub metadata and raster avatars. Live requests returned 200 for GitHub unfurls and avatar SVGs, 400 for metadata-address and GitHub-settings targets, and 404/410 for retired services. A crafted theme value cannot introduce a second script element. No production credentials were used in the app tests.

Independent reviews completed without actionable findings: GPT-6.1 Sol through Codex inspected the security boundary and deployment transport; Claude Opus 5.5 through Claude inspected the final runtime export correction and exercised exported-helper isolation in workerd. The final reviewed Worker hash is the deployed hash above. No CODING_STANDARDS.md was present in the checkout, its ancestors or the repository's primary checkout.

## Operational changes

Only public GitHub is supported. The allowlist is enforced in application code; it is not a separate platform network firewall. No Node.js compatibility, private bindings, importable environment or startup evaluation is enabled.

Third-party image conversion is disabled, so shared chat cards currently use GitHub's original light image. Analytics, the in-app budget cutoff and automatic outage recovery are disabled. The pre-restore usage read was below the existing $4 cutoff; a future automatic budget cutoff must run outside the public Worker.

The former Cloudflare budget token is absent from the Worker but remains valid outside it. The available token and OAuth grants cannot revoke it or read account audit/token-use history (HTTP 403). Revoke it with account-admin access. Existing historical bundles and versions containing the old management code are not safe rollback targets.

Private forensic evidence is retained separately. A sampled review of 2026-11-08 through containment found automated probes and no evidence of successful compromise. Sampling and unavailable account audit records prevent proving that no compromise or external token use occurred. See [the security work item](https://github.com/saphid/github-unsuck/issues/6).
