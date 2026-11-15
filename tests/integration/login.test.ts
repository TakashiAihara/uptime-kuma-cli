import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun, on2x } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("login (real Kuma)", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  // Kuma 2.x: #44
  test.skipIf(on2x)(
    "a wrong password exits 2 with Kuma's message",
    async () => {
      const r = await cliRun(sb, ["monitors", "list"], { UPTIME_KUMA_PASSWORD: "wrong-pw-abc" });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Incorrect username or password.");
      expect(r.stderr + r.stdout).not.toContain("wrong-pw-abc");
    },
    120_000,
  );
});
