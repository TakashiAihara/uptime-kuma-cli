## Summary

<!-- What changed and why. Link the issue this closes: `Closes #N` when
it finishes the issue, `Refs #N` for partial work. -->

Closes #N

## Verification

<!-- Append the result to each item: pass/fail counts for the
integration runs, percentages for coverage. The two images are the
ones in CI's `integration` matrix — update the tags here when it
moves; both commands pin UPTIME_KUMA_IT_IMAGE so a leftover env var
cannot run one image under the other's label. If a check does not
apply to this diff, say so instead of leaving the box silently
unchecked. Commands: README "Testing" and "Integration tests". -->

- [ ] `bun run check` — typecheck, lint, format check, unit tests
- [ ] `UPTIME_KUMA_IT_IMAGE=louislam/uptime-kuma:1.23.17 bun run test:integration`
- [ ] `UPTIME_KUMA_IT_IMAGE=louislam/uptime-kuma:2.5.11 bun run test:integration`
- [ ] coverage — whole-project and diff line coverage, both >= 90%
- [ ] CI green on this PR

## Reviews

<!-- One row per review round — update the table as reviews land so it
is current at merge. opencode reviews every push; CodeRabbit reviews
every push to a non-draft PR (drafts are skipped). `coderabbit-review`
and `opencode / review` are the required checks (the mutation report
is informational only). Record the commit that was reviewed and what
was done with its findings: fixed (and where), rebutted (with the
evidence), or deferred to a follow-up issue. -->

| Reviewer | Commit | Findings | Disposition |
| --- | --- | --- | --- |
|  |  |  |  |
