// Shared with tests/workflows.test.ts, which pins the CI job's
// timeout-minutes above this bound. cliRun paces invocations to 15
// logins/min, so the suite's floor grows with its call count; CI runs
// the suite in three shards per image and the slowest shard —
// monitors.test.ts alone — measures about 8.5 min on 2.5.11, so the
// per-shard bound sits at 12. The CI job allows 18: setup (~2 min) +
// this bound + the sweep, server log and down -v after it fit inside.
export const TEST_LIMIT_MS = 12 * 60_000;
