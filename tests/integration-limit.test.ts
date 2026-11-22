import { describe, expect, test } from "bun:test";

import {
  SHARD_TEST_LIMIT_MS,
  testLimitMs,
  UNSHARDED_TEST_LIMIT_MS,
} from "../scripts/integration-limit.ts";

describe("testLimitMs", () => {
  test("a sharded run gets the per-shard bound", () => {
    expect(testLimitMs(true)).toBe(720_000);
    expect(SHARD_TEST_LIMIT_MS).toBe(720_000);
  });

  test("an unsharded run keeps the whole-suite bound", () => {
    expect(testLimitMs(false)).toBe(1_080_000);
    expect(UNSHARDED_TEST_LIMIT_MS).toBe(1_080_000);
  });
});
