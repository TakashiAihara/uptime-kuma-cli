import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

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

  test("delete the maintenance and the monitor", async () => {
    const m = await cliRun(sb, ["maintenance", "delete", String(maintenanceId), "--yes"]);
    expect(m.code).toBe(0);
    expect(m.json()).toEqual({ id: maintenanceId, deleted: true });
    const mon = await cliRun(sb, ["monitors", "delete", String(monitorId), "--yes"]);
    expect(mon.code).toBe(0);
    expect(mon.json()).toEqual({ id: monitorId, deleted: true });
  }, 240_000);
});
