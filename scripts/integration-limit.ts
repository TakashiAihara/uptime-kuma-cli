// Backstop for a hung `bun test` in scripts/integration.ts, shared with
// tests/workflows.test.ts which pins the CI job's timeout-minutes above
// it. One bound covers every run mode: the slowest measured shard —
// monitors.test.ts alone — runs about 8.5-10 min, and the worst
// legitimate shard is the one holding login.test.ts's 2FA test, whose
// 13-minute budget can start ~3 minutes into the shard and resolve near
// 17 minutes; a per-shard bound below that could kill the test before
// its own timeout and finally cleanup. An unsharded local run measures
// ~17.5 min on 2.5.11 against the same bound. The CI job allows 24:
// setup (~2 min) + this bound + the sweep, server log and down -v
// after it fit inside.
export const TEST_LIMIT_MS = 18 * 60_000;
