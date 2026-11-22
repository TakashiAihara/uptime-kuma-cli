// Shared with tests/workflows.test.ts, which pins the CI job's
// timeout-minutes above the sharded bound. cliRun paces invocations
// to 15 logins/min, so the suite's floor grows with its call count;
// CI runs the suite in three shards per image and the slowest shard —
// monitors.test.ts alone — measures about 8.5 min on 2.5.11, so the
// per-shard bound sits at 12. The CI job allows 18: setup (~2 min) +
// this bound + the sweep, server log and down -v after it fit inside.
export const SHARD_TEST_LIMIT_MS = 12 * 60_000;

// An unsharded run covers the whole suite — about 16-17 min on
// 2.5.11 — so it keeps the previous 18-minute bound for the local
// timings.json refresh runs.
export const UNSHARDED_TEST_LIMIT_MS = 18 * 60_000;

// UPTIME_KUMA_IT_SHARD selects the bound: a shard covers about a
// third of the suite, an unsharded run all of it.
export const testLimitMs = (sharded: boolean) =>
  sharded ? SHARD_TEST_LIMIT_MS : UNSHARDED_TEST_LIMIT_MS;
