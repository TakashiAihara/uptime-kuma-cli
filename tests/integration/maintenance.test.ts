import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun, on2x } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("maintenance (real Kuma)", () => {
  let sb: Sandbox;
  let maintenanceId = 0;
  let monitorId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add a paused manual maintenance window", async () => {
    const r = await cliRun(sb, [
      "maintenance",
      "add",
      "--title",
      "it-maint-window",
      "--strategy",
      "manual",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      title: "it-maint-window",
      strategy: "manual",
      active: false,
    });
    maintenanceId = r.json().id;
    expect(maintenanceId).toBeGreaterThan(0);
  }, 120_000);

  test("add a paused push monitor to attach", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-maint-mon",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ name: "it-maint-mon", type: "push", active: false });
    monitorId = r.json().id;
    expect(monitorId).toBeGreaterThan(0);
  }, 120_000);

  test("monitors --add attaches the monitor and prints the set", async () => {
    const r = await cliRun(sb, [
      "maintenance",
      "monitors",
      String(maintenanceId),
      "--add",
      String(monitorId),
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([{ id: monitorId, name: "it-maint-mon" }]);
  }, 120_000);

  test("monitors shows the attached monitor", async () => {
    const r = await cliRun(sb, ["maintenance", "monitors", String(maintenanceId)]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([{ id: monitorId, name: "it-maint-mon" }]);
  }, 120_000);

  test("edit --title renames the maintenance", async () => {
    const r = await cliRun(sb, [
      "maintenance",
      "edit",
      String(maintenanceId),
      "--title",
      "it-maint-window-renamed",
    ]);
    expect(r.code).toBe(0);
    expect(r.json().title).toBe("it-maint-window-renamed");
    expect(r.json().strategy).toBe("manual");
  }, 120_000);

  test("pause then resume the maintenance", async () => {
    const paused = await cliRun(sb, ["maintenance", "pause", String(maintenanceId)]);
    expect(paused.code).toBe(0);
    expect(paused.json()).toEqual({ id: maintenanceId, active: false });
    const resumed = await cliRun(sb, ["maintenance", "resume", String(maintenanceId)]);
    expect(resumed.code).toBe(0);
    expect(resumed.json()).toEqual({ id: maintenanceId, active: true });
  }, 240_000);

  test("delete the maintenance", async () => {
    const m = await cliRun(sb, ["maintenance", "delete", String(maintenanceId), "--yes"]);
    expect(m.code).toBe(0);
    expect(m.json()).toEqual({ id: maintenanceId, deleted: true });
  }, 120_000);

  test("delete the attached monitor", async () => {
    const mon = await cliRun(sb, ["monitors", "delete", String(monitorId), "--yes"]);
    expect(mon.code).toBe(0);
    expect(mon.json()).toEqual({ id: monitorId, deleted: true });
  }, 120_000);

  test.skipIf(!on2x)(
    "2.x: cron window with an end date and a croner 8 cron",
    async () => {
      const f = join(sb.dir, "cron8.json");
      writeFileSync(f, JSON.stringify({ cron: "0 9 * * 5#3" }));
      const r = await cliRun(sb, [
        "maintenance",
        "add",
        "--title",
        "it-maint-cron2x",
        "--strategy",
        "cron",
        "--start",
        "2032-06-01T10:00:00",
        "--end",
        "2032-06-02T10:00:00",
        "--config-file",
        f,
      ]);
      expect(r.code).toBe(0);
      const id = r.json().id;
      const got = await cliRun(sb, ["maintenance", "get", String(id)]);
      expect(got.code).toBe(0);
      expect(got.json().cron).toBe("0 9 * * 5#3");
      expect(got.json().dateRange).toEqual(["2032-06-01T10:00:00", "2032-06-02T10:00:00"]);
      // "#L" is croner 8's last-weekday nth form; the real server must take it
      const edit = await cliRun(sb, [
        "maintenance",
        "edit",
        String(id),
        "--set",
        "cron=0 9 * * 5#L",
      ]);
      expect(edit.code).toBe(0);
      const got2 = await cliRun(sb, ["maintenance", "get", String(id)]);
      expect(got2.code).toBe(0);
      expect(got2.json().cron).toBe("0 9 * * 5#L");
      const del = await cliRun(sb, ["maintenance", "delete", String(id), "--yes"]);
      expect(del.code).toBe(0);
    },
    240_000,
  );

  test.skipIf(!on2x)(
    "2.x: recurring-interval accepts intervalDay above 31",
    async () => {
      const f = join(sb.dir, "interval400.json");
      writeFileSync(f, JSON.stringify({ intervalDay: 400 }));
      const r = await cliRun(sb, [
        "maintenance",
        "add",
        "--title",
        "it-maint-int2x",
        "--strategy",
        "recurring-interval",
        "--config-file",
        f,
      ]);
      expect(r.code).toBe(0);
      const id = r.json().id;
      const got = await cliRun(sb, ["maintenance", "get", String(id)]);
      expect(got.code).toBe(0);
      expect(got.json().intervalDay).toBe(400);
      const del = await cliRun(sb, ["maintenance", "delete", String(id), "--yes"]);
      expect(del.code).toBe(0);
    },
    240_000,
  );

  test.skipIf(!on2x)(
    "2.x: a cron value croner rejects exits 2 before connecting",
    async () => {
      const f = join(sb.dir, "badnth.json");
      writeFileSync(f, JSON.stringify({ cron: "0 9 * * 5#9" }));
      const r = await cliRun(sb, [
        "maintenance",
        "add",
        "--title",
        "it-maint-badcron",
        "--strategy",
        "cron",
        "--config-file",
        f,
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("in-range values and steps");
    },
    120_000,
  );
});
