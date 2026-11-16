import { describe, expect, test } from "bun:test";
import { startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, sandbox } from "./helpers/run";

describe("run()", () => {
  test("rejects a concurrent invocation instead of corrupting shared state", async () => {
    const sb = sandbox();
    const kuma = await startFakeKuma();
    try {
      const first = run(sb, ["tags", "list"], creds(kuma.url));
      await expect(run(sb, ["tags", "list"], creds(kuma.url))).rejects.toThrow(
        "cannot run concurrently",
      );
      expect((await first).code).toBe(0);
    } finally {
      await kuma.close();
      sb.cleanup();
    }
  });
});
