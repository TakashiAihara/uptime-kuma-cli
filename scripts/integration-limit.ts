// Shared with tests/workflows.test.ts, which pins the CI job's
// timeout-minutes above the bound the matrix legs actually get.
// cliRun paces invocations to 15 logins/min, so the suite's floor
// grows with its call count; CI runs the suite in three shards per
// image and the slowest shard — monitors.test.ts alone — measures
// about 8.5-10 min on 2.5.11. The worst legitimate shard is the one
// holding login.test.ts's 2FA test, whose 13-minute budget can start
// ~3 minutes into the shard and resolve by ~16, with the shard's
// trailing files ending near 17-18, so the shard bound sits at 20.
export const SHARD_TEST_LIMIT_MS = 20 * 60_000;

// Runs that are not a fine slice — unset, a degenerate "1/1", or a
// coarse "<i>/<n>" with n <= 2, whose slices exceed what the shard
// bound was sized against — keep the whole-suite bound: the
// unsharded timings.json refresh run measures ~17.5 min on 2.5.11
// and needs real headroom to keep working as the suite grows. Like
// every bound here it sits above measured reality rather than
// covering a run where each test spends its whole timeout budget.
export const UNSHARDED_TEST_LIMIT_MS = 25 * 60_000;

// UPTIME_KUMA_IT_SHARD's "<i>/<n>" picks the bound by n: n > 2 slices
// the suite fine enough for the per-shard bound; n <= 2 or unset
// keeps the whole-suite bound. The CI job allows 27: setup
// (~2 min) + the shard bound + the sweep, server log and down -v
// after it fit inside.
export const testLimitMs = (spec: string | undefined) =>
  spec !== undefined && Number(spec.split("/")[1]) > 2
    ? SHARD_TEST_LIMIT_MS
    : UNSHARDED_TEST_LIMIT_MS;
