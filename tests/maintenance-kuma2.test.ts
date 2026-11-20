import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma | undefined;
let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await kuma?.close();
  kuma = undefined;
  sb.cleanup();
});

// Every test here runs the 2.5.11 profile unless it overrides init.
async function useFake(init: Parameters<typeof startFakeKuma>[0] = {}): Promise<FakeKuma> {
  kuma = await startFakeKuma({ profile: "2.x", ...init });
  return kuma;
}

const callsOf = (k: FakeKuma, event: string) => k.calls.filter((c) => c.event === event);

const sentAdd = (k: FakeKuma): Record<string, unknown> =>
  callsOf(k, "addMaintenance")[0]!.args[0] as Record<string, unknown>;

const sentEdit = (k: FakeKuma): Record<string, unknown> =>
  callsOf(k, "editMaintenance")[0]!.args[0] as Record<string, unknown>;

const writeJson = (name: string, value: Record<string, unknown>) => {
  const path = join(sb.dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

describe("maintenance on Kuma 2.x", () => {
  describe("add", () => {
    test("cron accepts --start and --end", async () => {
      const k = await useFake();
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "cron",
          "--start",
          "2032-06-01T10:00:00",
          "--end",
          "2032-06-02T10:00:00",
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).dateRange).toEqual(["2032-06-01T10:00:00", "2032-06-02T10:00:00"]);
    });

    test.each([
      ["recurring-interval", { intervalDay: 2 }],
      ["recurring-weekday", { weekdays: [1, 3] }],
      ["recurring-day-of-month", { daysOfMonth: [15, "lastDay1"] }],
    ])("%s accepts --start and --end", async (strategy, fields) => {
      const k = await useFake();
      const f = writeJson("rec.json", fields);
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          strategy,
          "--start",
          "2032-06-01T10:00:00",
          "--end",
          "2032-06-02T10:00:00",
          "--config-file",
          f,
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).dateRange).toEqual(["2032-06-01T10:00:00", "2032-06-02T10:00:00"]);
    });

    test("a dateRange end via --config-file is accepted for cron", async () => {
      const k = await useFake();
      const f = writeJson("cron-end.json", {
        cron: "0 4 * * *",
        dateRange: ["2030-01-01T00:00:00", "2030-01-02T00:00:00"],
      });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).dateRange).toEqual(["2030-01-01T00:00:00", "2030-01-02T00:00:00"]);
    });

    test.each(["cron", "recurring-interval"])(
      "%s rejects a --config-file dateRange whose end precedes its start",
      async (strategy) => {
        const k = await useFake();
        const f = writeJson("inverted.json", {
          dateRange: ["2030-01-02T00:00:00", "2030-01-01T00:00:00"],
        });
        const r = await run(
          sb,
          ["maintenance", "add", "--title", "w", "--strategy", strategy, "--config-file", f],
          creds(k.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("end must be after start");
        expect(k.calls).toHaveLength(0);
      },
    );

    test("recurring-interval accepts intervalDay above 31", async () => {
      const k = await useFake();
      const f = writeJson("interval400.json", { intervalDay: 400 });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-interval",
          "--config-file",
          f,
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).intervalDay).toBe(400);
    });

    test("recurring-interval accepts intervalDay 3650", async () => {
      const k = await useFake();
      const f = writeJson("interval3650.json", { intervalDay: 3650 });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-interval",
          "--config-file",
          f,
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).intervalDay).toBe(3650);
    });

    test("recurring-interval rejects intervalDay above 3650 before connecting", async () => {
      const k = await useFake();
      const f = writeJson("interval4000.json", { intervalDay: 4000 });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-interval",
          "--config-file",
          f,
        ],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no greater than 3650 for recurring-interval");
      expect(k.calls).toHaveLength(0);
    });

    test.each([
      "0 9 * * 5#3",
      "0 9 * * 5#L",
      "0 9 * * MON#2",
      "0 9 * * 5L",
      "0 9 * * 5-7#3",
      "0 9 * * 5/2#3",
      "0 9 * * 5#",
      "0 9 * * ?#3",
      "0 9 * * ?L",
      "0 9 * * ?/5#3",
      "0 9 20-33/7 * *",
      "0 9 * * 2-8/7",
      "0 9 31/5 * *",
      "0 9 * 12/3 *",
      "0 9 L * *",
      "0 9 L, * *",
      "0 9 * * ?/5",
      "0 9 ?/5 * *",
      "0 9 * ?/5 *",
      "0 9 ?-31 * *",
      "0 9 1-? * *",
      "0 9 * * ?-7",
      "0 9 * * ?-6",
      "0 9 * * /5,6",
      "0 9 * * 60/5,6",
      "0 9 32/5,1 * *",
      "0 0 29 2 *",
      "0 0 31 2 1",
      "0 0 31 4,7 *",
      "0 0 31 * *",
      "0 0 5 * 31/6",
      "0 0 32/5 * 1",
      "0 0 28 ? *",
      "0 0 ? 1 *",
      "0 0 ? 1,4 *",
      "0 0 ? ? *",
      "0 0 ? ?,4 *",
      "0 0 ?/18 * *",
      "0 0 ?/18 * */5",
      "0 0 ?/18 * 1",
      "0 0 5,?/18 * *",
      "0 0 * ?/5 *",
      "0 0 5 ?/5 *",
      "0 0 * 1-?/2 *",
      "0 0 * ?-12/3 *",
      "0 0 ?-31/10 7,6 *",
      "0 0 *,1-?/8 * *",
      "0 0 11-23/7 12 0-?/2",
      "0 0 5 * ?-6/7,1-1",
      "0 0 1-28* 2 *",
      "0 0 29-31* 2 *",
      "0 0 28*-30 2 *",
      "0 0 5*3 2 *",
      "0 0 5/2*3 2 *",
      "0 0 */5* 2 *",
      "0 0 ?* * *",
      "0 0 * ?* *",
      "0 0 * * ?*",
      "?* 0 0 * * *",
      "0-?* 9 * * *",
      "?/5* 0 0 * * *",
      "0 0 */?* * *",
      "0 0 1-5*? * *",
      "0 0 ?*1 * *",
      "0 0 5*? 2 *",
      "0 0 ?-31* * *",
      "0 0 ?/5* * *",
      "?0/5,0 9 * * *",
      "0 0 15 * ?0/5",
      "0 0 * * ?0/5,1",
      "0 0 * * ?/7",
      "0 0 ?/5 * ?0/5",
      "0 0 ?0/5 * 1",
    ])("cron accepts %p on a 2.x server", async (cron) => {
      const k = await useFake();
      const f = writeJson("cron8.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentAdd(k).cron).toBe(cron);
    });

    test.each([
      "0 9 * * */8",
      "0 9 0/5 * *",
      "0 9 * 0/3 *",
      "0 9 * * 7/2",
      "0 9 ,5 * *",
      "0 9 0/5,1 * *",
      "0 0 1 * L",
      "0 0 31 2/12 *",
      "0 0 0/30 2 *",
      "0 9 * * ?/8",
    ])("a croner 6-only form %p exits 2 once the 2.x version is known", async (cron) => {
      const k = await useFake();
      const f = writeJson("cron6.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("in-range values and steps");
      expect(k.calls.map((c) => c.event)).toContain("login");
      expect(callsOf(k, "addMaintenance")).toHaveLength(0);
    });

    test.each([
      "0 9 * * * * *",
      "0 9 * * L",
      "0 9 * * FOO",
      "0 9 * 13 *",
      "0 9 * * /5",
      "0 9 * /5 *",
      "0 9 /5 * *",
      "0 0 * * 60/5",
      "0 0 31 2 *",
      "0 0 30 2 *",
      "0 0 31 4,6,9,11 *",
      "0 0 30-31/2 2 *",
      "0 0 31/5 4 *",
      "0 0 31 ? *",
      "0 0 ? 2 *",
      "0 0 ?,31 2 *",
      "0 0 ?-31 2 *",
      "0 0 31 ?,4 *",
      "0 0 ?/31 2 *",
      "0 0 ?/5 2 *",
      "0 0 31/? 2,? *",
      "0 0 ?-31* 2 *",
      "0 0 1-28/2*3 2 *",
      "0 0 1-2/3* 2 *",
      "0 0 *1-5 2 *",
      "0 0 30-31* 2 *",
      "0 0 31* 2 *",
      "?0/5 9 * * *",
      "?0/5 9 15 * *",
      "0 0 * * ?0/5",
      "0 0 * * ?0/5,9/2",
      "0 0 60/5 * ?0/5",
      "0 0 * ?0/5 *",
      "0 0 ?0/5 * *",
    ])("cron still rejects %p before connecting", async (cron) => {
      const k = await useFake();
      const f = writeJson("badcron.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("5 or 6 whitespace-separated cron fields");
      expect(k.calls).toHaveLength(0);
    });
  });

  describe("edit", () => {
    test("--end on a cron window is accepted", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "cron win",
            strategy: "cron",
            cron: "0 4 * * *",
            duration: 3600,
            dateRange: ["2030-01-01T02:00:00"],
          },
        ],
      });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--end", "2030-01-01T05:00:00"],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentEdit(k).dateRange).toEqual(["2030-01-01T02:00:00", "2030-01-01T05:00:00"]);
    });

    test("--end before the stored start on a cron window exits 2", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "cron win",
            strategy: "cron",
            cron: "0 4 * * *",
            duration: 3600,
            dateRange: ["2030-01-01T05:00:00"],
          },
        ],
      });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--end", "2030-01-01T02:00:00"],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("end must be after start");
      expect(callsOf(k, "editMaintenance")).toHaveLength(0);
    });

    test("--set intervalDay above 31 on recurring-interval is accepted", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "every n days",
            strategy: "recurring-interval",
            intervalDay: 2,
            timeRange: [
              { hours: 2, minutes: 0 },
              { hours: 3, minutes: 0 },
            ],
          },
        ],
      });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "intervalDay=400"],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentEdit(k).intervalDay).toBe(400);
    });

    test("--set cron with a croner 8 day-of-week form is accepted", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "cron win",
            strategy: "cron",
            cron: "0 4 * * *",
            duration: 3600,
          },
        ],
      });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "cron=0 9 * * 5#3"],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(sentEdit(k).cron).toBe("0 9 * * 5#3");
    });

    test("--set cron with an out-of-range value exits 2 without sending editMaintenance", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "cron win",
            strategy: "cron",
            cron: "0 4 * * *",
            duration: 3600,
          },
        ],
      });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "cron=0 9 * * */8"],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("in-range values and steps");
      expect(callsOf(k, "editMaintenance")).toHaveLength(0);
    });

    test("switching single to cron keeps the stored end date", async () => {
      const k = await useFake({
        maintenances: [
          {
            id: 1,
            title: "one-off",
            strategy: "single",
            dateRange: ["2030-01-01T02:00:00", "2030-01-01T04:00:00"],
          },
        ],
      });
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--set",
          "strategy=cron",
          "--set",
          "cron=0 4 * * *",
          "--set",
          "durationMinutes=60",
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      const sent = sentEdit(k);
      expect(sent.strategy).toBe("cron");
      expect(sent.dateRange).toEqual(["2030-01-01T02:00:00", "2030-01-01T04:00:00"]);
    });
  });
});
