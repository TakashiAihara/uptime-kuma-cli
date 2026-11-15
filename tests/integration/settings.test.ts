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

    const restore = await cliRun(sb, [
      "settings",
      "set",
      "--set",
      `keepDataPeriodDays=${restoreDays}`,
      "--set",
      `primaryBaseURL=${restoreUrl}`,
    ]);
    expect(restore.code).toBe(0);

    const after = await cliRun(sb, ["settings", "get"]);
    expect(after.code).toBe(0);
    expect(after.json().keepDataPeriodDays ?? 180).toBe(restoreDays);
    expect(after.json().primaryBaseURL ?? "").toBe(restoreUrl);
  }, 300_000);
});
