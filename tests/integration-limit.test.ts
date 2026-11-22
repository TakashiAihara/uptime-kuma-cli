import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SHARD_TEST_LIMIT_MS,
  testLimitMs,
  UNSHARDED_TEST_LIMIT_MS,
} from "../scripts/integration-limit.ts";

const IT_DIR = join(import.meta.dir, "integration");

// The largest per-test timeout any integration file declares, e.g. the
// `}, 780_000);` third argument on login.test.ts's 2FA test — the
// runner's own bound must stay above it or it kills a slow-but-
// legitimate shard before that test's timeout and its finally cleanup
const maxTestTimeout = () =>
  Math.max(
    ...readdirSync(IT_DIR)
      .filter((f) => f.endsWith(".test.ts"))
      .flatMap((f) =>
        [...readFileSync(join(IT_DIR, f), "utf8").matchAll(/\},\s*([\d_]+)\);/g)].map((m) =>
          Number(m[1]!.replaceAll("_", "")),
        ),
      ),
  );

describe("testLimitMs", () => {
  test("a sharded run gets the per-shard bound", () => {
    expect(testLimitMs(true)).toBe(900_000);
    expect(SHARD_TEST_LIMIT_MS).toBe(900_000);
  });

  test("an unsharded run keeps the whole-suite bound", () => {
    expect(testLimitMs(false)).toBe(1_080_000);
    expect(UNSHARDED_TEST_LIMIT_MS).toBe(1_080_000);
  });

  // login.test.ts's 2FA test declares the suite's largest budget; a
  // bound below it would kill the shard before the test's own timeout
  // fires and its finally cleanup runs
  test("both bounds outlast the largest per-test timeout in the suite", () => {
    expect(maxTestTimeout()).toBe(780_000);
    expect(SHARD_TEST_LIMIT_MS).toBeGreaterThan(maxTestTimeout());
    expect(UNSHARDED_TEST_LIMIT_MS).toBeGreaterThan(maxTestTimeout());
  });
});
