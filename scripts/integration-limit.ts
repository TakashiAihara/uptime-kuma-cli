// Shared with tests/workflows.test.ts, which pins the CI job's
// timeout-minutes above the bound the matrix legs actually get.
// cliRun paces invocations to 15 logins/min, so the suite's floor
// grows with its call count; CI runs the suite in three shards per
// image and the slowest shard — monitors.test.ts alone — measures
// about 8.5-10 min on 2.5.11. The worst legitimate shard is the one
// holding login.test.ts, whose two tests' budgets (120s + 780s) can
// start ~2.6 minutes into the shard and resolve by ~17.5, with the
// shard's trailing file ending near 19, so the shard bound sits at
// 20 — about a minute over that worst case.
export const SHARD_TEST_LIMIT_MS = 20 * 60_000;

// Runs that are not a fine slice — unset, a degenerate "1/1", or a
// coarse "<i>/<n>" with n <= 2, whose slices exceed what the shard
// bound was sized against — keep the whole-suite bound. An unsharded
// run places every file end to end, so its worst legitimate case is
// the measured total minus login.test.ts's share plus that file's
// whole timeout budget: ~16.5 + ~15 = ~31.5 minutes on 2.5.11, and
// the timings.json refresh run — which lives under this bound —
// needs real headroom to keep working as the suite grows. 35 sits
// above that worst case with room to spare; like every bound here
// it does not cover a run where each test spends its whole timeout
// budget at once.
export const UNSHARDED_TEST_LIMIT_MS = 35 * 60_000;

// UPTIME_KUMA_IT_SHARD's "<i>/<n>" picks the bound by n: n > 2 slices
// the suite fine enough for the per-shard bound; n <= 2 or unset
// keeps the whole-suite bound. The CI job allows 27: setup
// (~2 min) + the shard bound + the sweep, server log and down -v
// after it fit inside.
export const testLimitMs = (spec: string | undefined) =>
  spec !== undefined && Number(spec.split("/")[1]) > 2
    ? SHARD_TEST_LIMIT_MS
    : UNSHARDED_TEST_LIMIT_MS;
