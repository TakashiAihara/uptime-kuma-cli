// Shared with tests/workflows.test.ts, which pins the CI job's
// timeout-minutes above this bound. cliRun paces invocations to 15
// logins/min, so the suite's floor grows with its call count; the 2.5.11
// leg already measures about 15 min, so the bound sits at 18. The CI job
// allows 25: setup (~2 min) + this bound + the sweep, server log and
// down -v after it fit inside.
export const TEST_LIMIT_MS = 18 * 60_000;
