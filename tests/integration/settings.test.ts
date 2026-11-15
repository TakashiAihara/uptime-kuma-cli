import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("settings (real Kuma)", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("get prints the general settings", async () => {
    const r = await cliRun(sb, ["settings", "get"]);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).not.toBeNull();
    expect(typeof j).toBe("object");
    // getSettings fills a missing serverTimezone from the server itself
    expect(typeof j.serverTimezone).toBe("string");
  }, 120_000);

  test("set keepDataPeriodDays and primaryBaseURL, read back, restore", async () => {
    const before = await cliRun(sb, ["settings", "get"]);
    expect(before.code).toBe(0);
    const originalDays = before.json().keepDataPeriodDays;
    const originalUrl = before.json().primaryBaseURL;
    // an unset value reads back as the UI default / empty
    const restoreDays = originalDays ?? 180;
    const restoreUrl = originalUrl ?? "";

    // pick values different from the originals so the read-back proves the write
    const targetDays = restoreDays === 45 ? 46 : 45;
    const targetUrl =
      restoreUrl === "https://it-settings.example.com/"
        ? "https://it-settings-2.example.com/"
        : "https://it-settings.example.com/";

    // the shared Kuma outlives this test, so the originals go back even when
    // an assertion fails
    try {
      const set = await cliRun(sb, [
        "settings",
        "set",
        "--set",
        `keepDataPeriodDays=${targetDays}`,
        "--set",
        `primaryBaseURL=${targetUrl}`,
      ]);
      expect(set.code).toBe(0);
      // the set output is already a fresh getSettings read
      expect(set.json().keepDataPeriodDays).toBe(targetDays);
      expect(set.json().primaryBaseURL).toBe(targetUrl);

      const mid = await cliRun(sb, ["settings", "get"]);
      expect(mid.code).toBe(0);
      expect(mid.json().keepDataPeriodDays).toBe(targetDays);
      expect(mid.json().primaryBaseURL).toBe(targetUrl);
    } finally {
      const restore = await cliRun(sb, [
        "settings",
        "set",
        "--set",
        `keepDataPeriodDays=${restoreDays}`,
        "--set",
        `primaryBaseURL=${restoreUrl}`,
      ]);
      expect(restore.code).toBe(0);
    }

    const after = await cliRun(sb, ["settings", "get"]);
    expect(after.code).toBe(0);
    expect(after.json().keepDataPeriodDays ?? 180).toBe(restoreDays);
    expect(after.json().primaryBaseURL ?? "").toBe(restoreUrl);
  }, 300_000);

  test("steamAPIKey prints as *** and the placeholder is refused", async () => {
    // a fixture value, not a real Steam key; it only has to be non-empty
    const key = `it-steam-${Date.now().toString(36)}`;
    const setFile = join(sb.dir, "steam.json");
    writeFileSync(setFile, JSON.stringify({ steamAPIKey: key }));
    const emptyFile = join(sb.dir, "steam-empty.json");
    writeFileSync(emptyFile, JSON.stringify({ steamAPIKey: "" }));
    try {
      const set = await cliRun(sb, ["settings", "set", "--config-file", setFile]);
      expect(set.code).toBe(0);
      expect(set.json().steamAPIKey).toBe("***");
      expect(set.stdout).not.toContain(key);

      const get = await cliRun(sb, ["settings", "get"]);
      expect(get.code).toBe(0);
      expect(get.json().steamAPIKey).toBe("***");
      expect(get.stdout).not.toContain(key);

      // feeding the redacted output back must not store "***" over the key
      const refusedFile = join(sb.dir, "steam-redacted.json");
      writeFileSync(refusedFile, JSON.stringify({ steamAPIKey: "***" }));
      const refused = await cliRun(sb, ["settings", "set", "--config-file", refusedFile]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("redacted placeholder");

      const still = await cliRun(sb, ["settings", "get"]);
      expect(still.code).toBe(0);
      expect(still.json().steamAPIKey).toBe("***");
    } finally {
      // restore: an empty key prints as empty again
      const restore = await cliRun(sb, ["settings", "set", "--config-file", emptyFile]);
      expect(restore.code).toBe(0);
      expect(restore.json().steamAPIKey).toBe("");
    }
  }, 300_000);
});
