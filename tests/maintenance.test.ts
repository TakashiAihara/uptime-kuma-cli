import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [
      { id: 5, name: "web", type: "http", active: true },
      { id: 3, name: "db", type: "http", active: true },
    ],
    statusPages: [
      { id: 7, title: "Status page", slug: "status" },
      { id: 4, title: "Ops page", slug: "ops" },
    ],
    maintenances: [
      {
        id: 2,
        title: "Nightly window",
        description: "db maintenance",
        strategy: "single",
        intervalDay: 1,
        active: true,
        dateRange: ["2030-01-01T02:00:00", "2030-01-01T04:00:00"],
        timezoneOption: "SAME_AS_SERVER",
      },
      {
        id: 1,
        title: "Manual freeze",
        strategy: "manual",
        intervalDay: 1,
        active: false,
        description: "quarterly",
        timezoneOption: null,
      },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

const callsOf = (event: string) => kuma.calls.filter((c) => c.event === event);

describe("maintenance", () => {
  describe("list", () => {
    test("prints { id, title, strategy, active, status } sorted by id", async () => {
      const r = await run(sb, ["maintenance", "list"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([
        {
          id: 1,
          title: "Manual freeze",
          strategy: "manual",
          active: false,
          status: "inactive",
        },
        {
          id: 2,
          title: "Nightly window",
          strategy: "single",
          active: true,
          status: "scheduled",
        },
      ]);
    });

    test("prints an empty array when Kuma has no maintenances", async () => {
      kuma.state.maintenances = [];
      const r = await run(sb, ["maintenance", "list"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([]);
    });

    test("waits for the maintenanceList push", async () => {
      kuma.state.skipLists = ["maintenanceList"];
      const r = await run(sb, ["maintenance", "list"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("maintenanceList");
    });
  });

  describe("get", () => {
    test("prints the getMaintenance object", async () => {
      const r = await run(sb, ["maintenance", "get", "1"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({
        id: 1,
        title: "Manual freeze",
        description: "quarterly",
        strategy: "manual",
        intervalDay: 1,
        active: false,
        dateRange: [null],
        timeRange: [
          { hours: 0, minutes: 0 },
          { hours: 0, minutes: 0 },
        ],
        weekdays: [],
        daysOfMonth: [],
        timeslotList: [],
        cron: null,
        duration: null,
        durationMinutes: null,
        timezone: "UTC",
        timezoneOption: null,
        timezoneOffset: "+00:00",
        status: "inactive",
      });
      expect(callsOf("getMaintenance")[0]!.args).toEqual([1]);
    });

    test("a single window in progress reports under-maintenance", async () => {
      kuma.state.maintenances[0]!.dateRange = [
        new Date(Date.now() - 3_600_000).toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(),
      ];
      const r = await run(sb, ["maintenance", "get", "2"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json().status).toBe("under-maintenance");
      expect(r.json().timeslotList).toEqual([
        {
          startDate: kuma.state.maintenances[0]!.dateRange![0],
          endDate: kuma.state.maintenances[0]!.dateRange![1],
        },
      ]);
    });

    test("an unknown id exits 1 without sending getMaintenance", async () => {
      const r = await run(sb, ["maintenance", "get", "9"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("getMaintenance")).toHaveLength(0);
    });

    test("an invalid id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "get", "abc"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("positive integer");
      expect(kuma.calls).toHaveLength(0);
    });

    test("getMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.getMaintenance = "db is gone";
      const r = await run(sb, ["maintenance", "get", "1"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("db is gone");
    });
  });

  describe("add", () => {
    test("manual sends the UI defaults and prints { id, title, strategy, active }", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "Deploy freeze", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({
        id: 3,
        title: "Deploy freeze",
        strategy: "manual",
        active: true,
      });
      expect(callsOf("addMaintenance")[0]!.args).toEqual([
        {
          title: "Deploy freeze",
          description: "",
          strategy: "manual",
          active: true,
          cron: "30 3 * * *",
          durationMinutes: 60,
          intervalDay: 1,
          dateRange: [],
          timeRange: [
            { hours: 2, minutes: 0 },
            { hours: 3, minutes: 0 },
          ],
          weekdays: [],
          daysOfMonth: [],
          timezoneOption: "SAME_AS_SERVER",
        },
      ]);
      const stored = kuma.state.maintenances.find((m) => m.id === 3)!;
      expect(stored.dateRange).toEqual([null]);
      expect(stored.timezoneOption).toBe("SAME_AS_SERVER");
    });

    test("single sends dateRange, description, timezone and --paused", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "Window",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00:00",
          "--end",
          "2031-05-05T12:30:00",
          "--timezone",
          "Asia/Tokyo",
          "--description",
          "desc",
          "--paused",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: 3, title: "Window", strategy: "single", active: false });
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2031-05-05T10:00:00", "2031-05-05T12:30:00"]);
      expect(sent.timezoneOption).toBe("Asia/Tokyo");
      expect(sent.description).toBe("desc");
      expect(sent.active).toBe(false);
      const stored = kuma.state.maintenances.find((m) => m.id === 3)!;
      expect(stored.timezone).toBe("Asia/Tokyo");
      expect(stored.active).toBe(false);
    });

    test("an explicit SAME_AS_SERVER timezone is sent", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "manual",
          "--timezone",
          "SAME_AS_SERVER",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect((callsOf("addMaintenance")[0]!.args[0] as any).timezoneOption).toBe("SAME_AS_SERVER");
    });

    test("single without --end exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--start and --end");
      expect(kuma.calls).toHaveLength(0);
    });

    test("single without --start and --end exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "single"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--strategy single requires --start and --end");
      expect(kuma.calls).toHaveLength(0);
    });

    test("single with --end before --start exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T12:00:00",
          "--end",
          "2031-05-05T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--end must be after --start");
      expect(kuma.calls).toHaveLength(0);
    });

    test.each([
      "tomorrow",
      "2031-05-05",
      "2031-05-05 10:00",
      "2031-13-05T10:00:00",
      "2031-02-31T10:00:00",
      "2031-02-29T10:00:00",
      "2031-04-31T10:00:00",
      "2031-05-05T24:00:00",
      "2031-05-05T10:60:00",
      "2031-05-05T10:00:60",
    ])("single rejects --start %p with exit 2 before connecting", async (start) => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          start,
          "--end",
          "2031-05-06T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("Feb 29 is accepted in a leap year", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2032-02-29T10:00:00",
          "--end",
          "2032-03-01T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2032-02-29T10:00:00", "2032-03-01T10:00:00"]);
    });

    test("manual with --start exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "manual",
          "--start",
          "2031-05-05T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("do not apply to --strategy manual");
      expect(kuma.calls).toHaveLength(0);
    });

    test.each(["2031-05-05T10:00:00Z", "2031-05-05T10:00:00+09:00", "2031-05-05T10:00:00-0500"])(
      "--start %p with an offset exits 2 before connecting",
      async (start) => {
        const r = await run(
          sb,
          [
            "maintenance",
            "add",
            "--title",
            "w",
            "--strategy",
            "single",
            "--start",
            start,
            "--end",
            "2031-05-06T10:00:00",
          ],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("local time in the maintenance timezone");
        expect(r.stderr).toContain(start);
        expect(kuma.calls).toHaveLength(0);
      },
    );

    test("--end with an offset exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00:00",
          "--end",
          "2031-05-06T10:00:00Z",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("local time in the maintenance timezone");
      expect(r.stderr).toContain("2031-05-06T10:00:00Z");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an impossible --start date exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2026-13-40T10:00",
          "--end",
          "2030-01-01T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("ISO 8601 local datetime");
      expect(kuma.calls).toHaveLength(0);
    });

    test("--start alone is accepted for a non-manual strategy", async () => {
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
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2032-06-01T10:00:00"]);
    });

    test("--end alone exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "cron",
          "--end",
          "2032-06-01T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--end requires --start");
      expect(kuma.calls).toHaveLength(0);
    });

    test("--start and --end on a cron window exits 2 before connecting", async () => {
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("end date");
      expect(r.stderr).toContain("give only a start");
      expect(kuma.calls).toHaveLength(0);
    });

    test("equal start and end in different formats exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00",
          "--end",
          "2031-05-05T10:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--end must be after --start");
      expect(kuma.calls).toHaveLength(0);
    });

    test("fractional seconds decide start/end ordering", async () => {
      const reversed = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00:00.500",
          "--end",
          "2031-05-05T10:00:00.200",
        ],
        creds(kuma.url),
      );
      expect(reversed.code).toBe(2);
      expect(reversed.stderr).toContain("--end must be after --start");

      const ordered = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w2",
          "--strategy",
          "single",
          "--start",
          "2031-05-05T10:00:00.2",
          "--end",
          "2031-05-05T10:00:00.25",
        ],
        creds(kuma.url),
      );
      expect(ordered.code).toBe(0);
    });

    test("start/end ordering does not depend on the host timezone", async () => {
      // 2026-03-08T02:30 does not exist in America/New_York (spring forward);
      // resolving it through Date.parse can reorder it against 03:15
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "single",
          "--start",
          "2026-03-08T02:30",
          "--end",
          "2026-03-08T03:15",
        ],
        { ...creds(kuma.url), TZ: "America/New_York" },
      );
      expect(r.code).toBe(0);
    });

    test("an invalid --timezone exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "manual",
          "--timezone",
          "Mars/Olympus",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--timezone");
      expect(kuma.calls).toHaveLength(0);
    });

    test("the same title already present exits 3 without sending addMaintenance", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "Manual freeze", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(3);
      expect(r.json()).toEqual({ id: 1, title: "Manual freeze", skipped: true });
      expect(callsOf("addMaintenance")).toHaveLength(0);
      expect(kuma.state.maintenances).toHaveLength(2);
    });

    test("the title match is exact, not case-insensitive", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "manual freeze", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("addMaintenance")).toHaveLength(1);
    });

    test("addMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.addMaintenance = "cannot add";
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot add");
    });

    test("an addMaintenance answer without maintenanceID exits 70", async () => {
      kuma.state.addMaintenanceResult = { ok: true, msg: "Added Successfully." };
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(70);
      expect(r.stderr).toContain("unexpected addMaintenance response");
    });

    test("without --strategy exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "add", "--title", "w"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("without --title exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "add", "--strategy", "manual"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("an empty --title exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "", "--strategy", "manual"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--title");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a strategy outside the six names exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "bogus"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });
  });

  describe("edit", () => {
    test("--title merges into the fetched object and prints the saved maintenance", async () => {
      const r = await run(sb, ["maintenance", "edit", "1", "--title", "New name"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json().title).toBe("New name");
      expect(r.json().status).toBe("inactive");
      expect(callsOf("editMaintenance")[0]!.args).toEqual([
        {
          id: 1,
          title: "New name",
          description: "quarterly",
          strategy: "manual",
          intervalDay: 1,
          active: false,
          dateRange: [null],
          timeRange: [
            { hours: 0, minutes: 0 },
            { hours: 0, minutes: 0 },
          ],
          weekdays: [],
          daysOfMonth: [],
          timeslotList: [],
          cron: null,
          duration: null,
          durationMinutes: null,
          timezone: "UTC",
          timezoneOption: null,
          timezoneOffset: "+00:00",
          status: "inactive",
        },
      ]);
      expect(callsOf("getMaintenance")).toHaveLength(2);
      expect(kuma.state.maintenances.find((m) => m.id === 1)!.title).toBe("New name");
    });

    test("--start/--end replace dateRange", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "2",
          "--start",
          "2032-01-01T00:00:00",
          "--end",
          "2032-01-01T01:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2032-01-01T00:00:00", "2032-01-01T01:00:00"]);
      const stored = kuma.state.maintenances.find((m) => m.id === 2)!;
      expect(stored.dateRange).toEqual(["2032-01-01T00:00:00", "2032-01-01T01:00:00"]);
      expect(r.json().status).toBe("scheduled");
    });

    test("--timezone replaces timezoneOption and resolves timezone", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--timezone", "Asia/Tokyo"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.timezoneOption).toBe("Asia/Tokyo");
      expect(kuma.state.maintenances.find((m) => m.id === 1)!.timezone).toBe("Asia/Tokyo");
      expect(r.json().timezoneOption).toBe("Asia/Tokyo");
      expect(r.json().timezone).toBe("Asia/Tokyo");
    });

    test("--set merges arbitrary fields", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "intervalDay=7", "--set", 'description="new desc"'],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.intervalDay).toBe(7);
      expect(sent.description).toBe("new desc");
      expect(kuma.state.maintenances.find((m) => m.id === 1)!.intervalDay).toBe(7);
    });

    test("--set dateRange as a JSON array is accepted", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--set",
          'dateRange=["2033-01-01T00:00:00","2033-01-01T01:00:00"]',
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2033-01-01T00:00:00", "2033-01-01T01:00:00"]);
      expect(kuma.state.maintenances.find((m) => m.id === 1)!.dateRange).toEqual([
        "2033-01-01T00:00:00",
        "2033-01-01T01:00:00",
      ]);
    });

    test("--set dateRange with an offset exits 2 without sending editMaintenance", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--set",
          'dateRange=["2033-01-01T00:00:00Z","2033-01-02T00:00:00"]',
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("local time in the maintenance timezone");
      expect(r.stderr).toContain("2033-01-01T00:00:00Z");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("a flag wins over a --set of the same field", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "title=A", "--title", "B"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect((callsOf("editMaintenance")[0]!.args[0] as any).title).toBe("B");
    });

    test("without any change exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "edit", "1"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("at least one");
      expect(kuma.calls).toHaveLength(0);
    });

    test("--start alone on a manual window exits 2 without sending editMaintenance", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--start", "2032-01-01T00:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("do not apply to --strategy manual");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("--start alone keeps the stored end", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--start", "2029-12-31T10:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2029-12-31T10:00:00", "2030-01-01T04:00:00"]);
    });

    test("--end alone is accepted on a single window with a stored start", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--end", "2030-01-01T05:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2030-01-01T02:00:00", "2030-01-01T05:00:00"]);
    });

    test("--end on a cron window exits 2 without sending editMaintenance", async () => {
      kuma.state.maintenances[0] = {
        ...kuma.state.maintenances[0]!,
        strategy: "cron",
        cron: "0 4 * * *",
        duration: 3600,
        dateRange: ["2030-01-01T02:00:00"],
      };
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--end", "2030-01-01T05:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("end date");
      expect(r.stderr).toContain(`--set 'dateRange=["<start>"]'`);
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("--end alone without a stored start exits 2 without sending editMaintenance", async () => {
      kuma.state.maintenances[0] = { ...kuma.state.maintenances[0]!, dateRange: [null] };
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--end", "2030-01-01T05:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--end requires --start or a stored window start");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("--start alone on a single window exits 2 when the merged pair is reversed", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--start", "2032-01-01T00:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('strategy "single" requires "dateRange"');
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("--start alone is accepted on a non-manual non-single window", async () => {
      kuma.state.maintenances[0] = {
        ...kuma.state.maintenances[0]!,
        strategy: "cron",
        cron: "0 4 * * *",
        duration: 3600,
        dateRange: [null],
      };
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--start", "2032-06-01T10:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2032-06-01T10:00:00"]);
    });

    test("--set id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "edit", "1", "--set", "id=9"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"id"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("--set dateRange to a non-array exits 2 without sending editMaintenance", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "dateRange=5"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("dateRange");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("an unknown id exits 1 without sending getMaintenance or editMaintenance", async () => {
      const r = await run(sb, ["maintenance", "edit", "9", "--title", "x"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("getMaintenance")).toHaveLength(0);
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("an invalid id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "edit", "abc", "--title", "x"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("a bad --start exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--start", "nope", "--end", "2032-01-01T00:00:00"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("--end before --start exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--start",
          "2032-01-02T00:00:00",
          "--end",
          "2032-01-01T00:00:00",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--end must be after --start");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an invalid --timezone exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--timezone", "Mars/Olympus"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("an untouched invalid stored dateRange does not block an unrelated edit", async () => {
      kuma.state.maintenances.find((m) => m.id === 1)!.dateRange = ["not-a-date"];
      const r = await run(sb, ["maintenance", "edit", "1", "--title", "renamed"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(callsOf("editMaintenance")).toHaveLength(1);
    });

    test("an untouched stored end on a cron window does not block an unrelated edit", async () => {
      kuma.state.maintenances[0] = {
        ...kuma.state.maintenances[0]!,
        strategy: "cron",
        cron: "0 4 * * *",
        duration: 3600,
      };
      const r = await run(sb, ["maintenance", "edit", "2", "--title", "renamed"], creds(kuma.url));
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2030-01-01T02:00:00", "2030-01-01T04:00:00"]);
    });

    test("editMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.editMaintenance = "cannot save";
      const r = await run(sb, ["maintenance", "edit", "1", "--title", "x"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot save");
    });
  });

  describe("pause and resume", () => {
    test("pause sends pauseMaintenance and prints { id, active: false }", async () => {
      const r = await run(sb, ["maintenance", "pause", "2"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: 2, active: false });
      expect(callsOf("pauseMaintenance")[0]!.args).toEqual([2]);
      const stored = kuma.state.maintenances.find((m) => m.id === 2)!;
      expect(stored.active).toBe(false);
    });

    test("resume sends resumeMaintenance and prints { id, active: true }", async () => {
      const r = await run(sb, ["maintenance", "resume", "1"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: 1, active: true });
      expect(callsOf("resumeMaintenance")[0]!.args).toEqual([1]);
      expect(kuma.state.maintenances.find((m) => m.id === 1)!.active).toBe(true);
    });

    test("pause of an unknown id exits 1 without sending pauseMaintenance", async () => {
      const r = await run(sb, ["maintenance", "pause", "9"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("pauseMaintenance")).toHaveLength(0);
    });

    test("resume with an invalid id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "resume", "abc"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("pauseMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.pauseMaintenance = "cannot pause";
      const r = await run(sb, ["maintenance", "pause", "1"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot pause");
    });
  });

  describe("delete", () => {
    test("--yes deletes and prints { id, deleted: true }", async () => {
      const r = await run(sb, ["maintenance", "delete", "1", "--yes"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: 1, deleted: true });
      expect(callsOf("deleteMaintenance")[0]!.args).toEqual([1]);
      expect(kuma.state.maintenances.map((m) => m.id)).toEqual([2]);
    });

    test("without --yes exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "delete", "1"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("would delete maintenance 1");
      expect(r.stderr).toContain("--yes");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an invalid id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "delete", "abc", "--yes"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("positive integer");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an unknown id exits 1 without sending deleteMaintenance", async () => {
      const r = await run(sb, ["maintenance", "delete", "9", "--yes"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("deleteMaintenance")).toHaveLength(0);
      expect(kuma.state.maintenances).toHaveLength(2);
    });

    test("deleteMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.deleteMaintenance = "cannot delete";
      const r = await run(sb, ["maintenance", "delete", "1", "--yes"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot delete");
      expect(kuma.state.maintenances).toHaveLength(2);
    });
  });

  describe("strategies and --config-file", () => {
    const writeJson = (name: string, value: Record<string, unknown>) => {
      const path = join(sb.dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };

    test("cron sends the UI defaults without a config-file", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.strategy).toBe("cron");
      expect(sent.cron).toBe("30 3 * * *");
      expect(sent.durationMinutes).toBe(60);
    });

    test("recurring-interval sends the UI defaults", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "recurring-interval"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.intervalDay).toBe(1);
      expect(sent.timeRange).toEqual([
        { hours: 2, minutes: 0 },
        { hours: 3, minutes: 0 },
      ]);
    });

    test("recurring-weekday without weekdays exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "recurring-weekday"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("weekdays");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-day-of-month without daysOfMonth exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "recurring-day-of-month"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("daysOfMonth");
      expect(kuma.calls).toHaveLength(0);
    });

    test("--config-file supplies the cron fields", async () => {
      const f = writeJson("cron.json", { cron: "*/10 * * * *", durationMinutes: 15 });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.cron).toBe("*/10 * * * *");
      expect(sent.durationMinutes).toBe(15);
    });

    test("--config-file supplies the recurring fields", async () => {
      const f = writeJson("rec.json", {
        weekdays: [1, 3, 5],
        timeRange: [
          { hours: 1, minutes: 30 },
          { hours: 2, minutes: 0 },
        ],
        intervalDay: 2,
      });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-weekday",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.weekdays).toEqual([1, 3, 5]);
      expect(sent.timeRange).toEqual([
        { hours: 1, minutes: 30 },
        { hours: 2, minutes: 0 },
      ]);
      expect(sent.intervalDay).toBe(2);
    });

    test("--config-file overrides the typed flags", async () => {
      const f = writeJson("tz.json", { timezoneOption: "America/New_York" });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "manual",
          "--timezone",
          "Asia/Tokyo",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.timezoneOption).toBe("America/New_York");
    });

    test("--config-file cannot set id", async () => {
      const f = writeJson("id.json", { id: 9 });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"id"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("a malformed strategy field exits 2 before connecting", async () => {
      const f = writeJson("bad.json", { durationMinutes: "x" });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("durationMinutes");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a malformed timeRange exits 2 before connecting", async () => {
      const f = writeJson("badtr.json", { timeRange: "9-5" });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timeRange");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a strategy set through --config-file is validated", async () => {
      const f = writeJson("strat.json", { strategy: "bogus" });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown maintenance strategy");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a non-array dateRange in --config-file exits 2 before connecting", async () => {
      const f = writeJson("dr.json", { dateRange: 5 });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("dateRange");
      expect(kuma.calls).toHaveLength(0);
    });

    test("edit --config-file counts as a change and merges", async () => {
      const f = writeJson("edit.json", { description: "from file" });
      const r = await run(sb, ["maintenance", "edit", "1", "--config-file", f], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json().description).toBe("from file");
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.description).toBe("from file");
      expect(sent.title).toBe("Manual freeze");
    });

    test("edit precedence: --config-file < --set < typed flags", async () => {
      const f = writeJson("prec.json", { title: "cfg", description: "cfg" });
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--config-file",
          f,
          "--set",
          "description=set",
          "--title",
          "flag",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.title).toBe("flag");
      expect(sent.description).toBe("set");
    });

    test("an empty --config-file does not count as a change", async () => {
      const f = writeJson("empty.json", {});
      const r = await run(sb, ["maintenance", "edit", "1", "--config-file", f], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("at least one");
      expect(kuma.calls).toHaveLength(0);
    });

    test("edit --config-file cannot set id", async () => {
      const f = writeJson("eid.json", { id: 9 });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--config-file", f, "--title", "x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"id"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("edit --config-file dateRange must be an array", async () => {
      const f = writeJson("edr.json", { dateRange: 5 });
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--config-file", f, "--title", "x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("dateRange");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("--set dateRange repairs a bad --config-file dateRange", async () => {
      const f = writeJson("badrange.json", { dateRange: ["soon", "2030-01-01T00:00:00"] });
      const r = await run(
        sb,
        [
          "maintenance",
          "edit",
          "1",
          "--config-file",
          f,
          "--set",
          'dateRange=["2033-01-01T00:00:00","2033-01-02T00:00:00"]',
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.dateRange).toEqual(["2033-01-01T00:00:00", "2033-01-02T00:00:00"]);
    });

    test("changing the strategy validates the new strategy's fields", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "strategy=cron"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cron");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("an unknown strategy via --set exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "strategy=bogus"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('unknown maintenance strategy "bogus"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("a strategy change with its fields via --config-file succeeds", async () => {
      const f = writeJson("to-cron.json", {
        strategy: "cron",
        cron: "0 4 * * *",
        durationMinutes: 45,
      });
      const r = await run(sb, ["maintenance", "edit", "1", "--config-file", f], creds(kuma.url));
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.strategy).toBe("cron");
      expect(sent.cron).toBe("0 4 * * *");
      expect(sent.durationMinutes).toBe(45);
    });

    test("an unknown strategy via --config-file exits 2 before connecting", async () => {
      const f = writeJson("badstrategy.json", { strategy: "bogus" });
      const r = await run(sb, ["maintenance", "edit", "1", "--config-file", f], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('unknown maintenance strategy "bogus"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("a touched strategy field is validated", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "2", "--set", "intervalDay=0"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("intervalDay");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("a touched timezoneOption is validated", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "timezoneOption=Mars/Olympus"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timezoneOption");
      expect(callsOf("editMaintenance")).toHaveLength(0);
    });

    test("an empty timezoneOption is accepted", async () => {
      const r = await run(
        sb,
        ["maintenance", "edit", "1", "--set", "timezoneOption="],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("editMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.timezoneOption).toBe("");
    });

    test("an empty cron expression exits 2 before connecting", async () => {
      const f = writeJson("empty-cron.json", { cron: "", durationMinutes: 30 });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('non-empty "cron"');
      expect(kuma.calls).toHaveLength(0);
    });

    test.each(["* * * *", "* * * * * * *", "0 4 * * *!"])(
      "a malformed cron %p exits 2 before connecting",
      async (cron) => {
        const f = writeJson("badshape.json", { cron, durationMinutes: 30 });
        const r = await run(
          sb,
          ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("5 or 6 whitespace-separated cron fields");
        expect(kuma.calls).toHaveLength(0);
      },
    );

    test.each([
      "@yearly",
      "@annually",
      "@monthly",
      "@weekly",
      "@daily",
      "@hourly",
      "@Daily",
      " @daily ",
    ])("a cron nickname %p is accepted", async (cron) => {
      const f = writeJson("nickname.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.cron).toBe(cron);
    });

    test.each([
      "0 9 L * *",
      "0 9 * * 5L",
      "0 9 * * * ?",
      "0 9 * jan mon",
      "0 9 * JAN-DEC MON-SAT",
      "0 9 * feb,mar,apr,may,jun,jul,aug,sep,oct,nov tue,wed,thu,fri,sun",
      "0\t9 * * *",
      "0  0 9 * * *",
    ])("a cron expression %p is accepted", async (cron) => {
      const f = writeJson("goodshape.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
    });

    test.each([
      "0 9 FOO * *",
      "X * * * *",
      "0 9 1W * *",
      "0 9 LW * *",
      "@midnight",
      "0 9 * * * ??",
      " 0 9 * * *",
      "0 9 * * * ",
      "0 9 * * L",
    ])("illegal cron content %p exits 2 before connecting", async (cron) => {
      const f = writeJson("badletters.json", { cron });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("5 or 6 whitespace-separated cron fields");
      expect(kuma.calls).toHaveLength(0);
    });

    test("lastDay1 is accepted in daysOfMonth", async () => {
      const f = writeJson("lastday.json", { daysOfMonth: ["lastDay1"] });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-day-of-month",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.daysOfMonth).toEqual(["lastDay1"]);
    });

    test.each([[60], [-1]])("a timeRange seconds of %p exits 2 before connecting", async (s) => {
      const f = writeJson("badsec.json", {
        timeRange: [
          { hours: 2, minutes: 0, seconds: s },
          { hours: 3, minutes: 0 },
        ],
      });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timeRange");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-interval requires intervalDay", async () => {
      const f = writeJson("nointerval.json", { intervalDay: null });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("intervalDay");
      expect(kuma.calls).toHaveLength(0);
    });

    test("intervalDay above the UI cap of 3650 exits 2 before connecting", async () => {
      const f = writeJson("biginterval.json", { intervalDay: 4000 });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("intervalDay");
      expect(kuma.calls).toHaveLength(0);
    });

    test("the intervalDay cap applies to strategies other than recurring-interval", async () => {
      const f = writeJson("biginterval-manual.json", { intervalDay: 4000 });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("intervalDay");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-interval rejects intervalDay above 31", async () => {
      const f = writeJson("interval32.json", { intervalDay: 32 });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no greater than 31 for recurring-interval");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-interval accepts intervalDay 31", async () => {
      const f = writeJson("interval31.json", { intervalDay: 31 });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.intervalDay).toBe(31);
    });

    test("intervalDay 32 stays valid for strategies other than recurring-interval", async () => {
      const f = writeJson("weekday-interval32.json", { intervalDay: 32, weekdays: [1] });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-weekday",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.intervalDay).toBe(32);
    });

    test("a --config-file strategy of manual overrides --strategy and rejects --start", async () => {
      const f = writeJson("manual-override.json", { strategy: "manual" });
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
          "2032-01-01T00:00:00",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("do not apply to --strategy manual");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a --config-file strategy of cron overrides --strategy manual and accepts --start", async () => {
      const f = writeJson("cron-override.json", { strategy: "cron" });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "manual",
          "--start",
          "2032-01-01T00:00:00",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.strategy).toBe("cron");
      expect(sent.dateRange).toEqual(["2032-01-01T00:00:00"]);
    });

    test("a dateRange end on a recurring strategy exits 2 before connecting", async () => {
      const f = writeJson("rec-end.json", {
        dateRange: ["2030-01-01T00:00:00", "2030-01-02T00:00:00"],
      });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("end date");
      expect(kuma.calls).toHaveLength(0);
    });

    test("a dateRange with an offset in --config-file exits 2 before connecting", async () => {
      const f = writeJson("offrange.json", {
        strategy: "single",
        dateRange: ["2030-01-01T10:00:00Z", "2030-01-02T10:00:00"],
      });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("local time in the maintenance timezone");
      expect(r.stderr).toContain("2030-01-01T10:00:00Z");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-weekday rejects an out-of-range weekday", async () => {
      const f = writeJson("rwd-bad.json", { weekdays: [7] });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-weekday",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("weekdays");
      expect(kuma.calls).toHaveLength(0);
    });

    test.each([[7], [-1]])("recurring-interval rejects weekday %p", async (weekdays) => {
      const f = writeJson("ri-wd.json", { weekdays: [weekdays] });
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
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("integers 0-6");
      expect(kuma.calls).toHaveLength(0);
    });

    test("recurring-day-of-month rejects an out-of-range day", async () => {
      const f = writeJson("rdom-bad.json", { daysOfMonth: [0] });
      const r = await run(
        sb,
        [
          "maintenance",
          "add",
          "--title",
          "w",
          "--strategy",
          "recurring-day-of-month",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("daysOfMonth");
      expect(kuma.calls).toHaveLength(0);
    });

    test.each([[0], [32], ["lastDay2"]])(
      "recurring-interval rejects daysOfMonth %p",
      async (daysOfMonth) => {
        const f = writeJson("ri-dom.json", { daysOfMonth: [daysOfMonth] });
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
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("1-31");
        expect(kuma.calls).toHaveLength(0);
      },
    );

    test("strategy single via --config-file rejects a reversed dateRange", async () => {
      const f = writeJson("sdr-rev.json", {
        strategy: "single",
        dateRange: ["2030-01-02T00:00:00", "2030-01-01T00:00:00"],
      });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('strategy "single" requires "dateRange"');
      expect(kuma.calls).toHaveLength(0);
    });

    test("strategy single via --config-file rejects a non-ISO dateRange", async () => {
      const f = writeJson("sdr-bad.json", {
        strategy: "single",
        dateRange: ["soon", "2030-01-01T00:00:00"],
      });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"dateRange" entries must be ISO 8601 local datetimes');
      expect(kuma.calls).toHaveLength(0);
    });

    test.each(["2031-02-31T10:00:00", "2031-05-05T24:00:00"])(
      "a dateRange entry %p that is not a real local datetime exits 2",
      async (bad) => {
        const f = writeJson("baddate.json", {
          strategy: "single",
          dateRange: [bad, "2030-01-01T00:00:00"],
        });
        const r = await run(
          sb,
          ["maintenance", "add", "--title", "w", "--strategy", "manual", "--config-file", f],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain('"dateRange" entries must be ISO 8601 local datetimes');
        expect(kuma.calls).toHaveLength(0);
      },
    );

    test("a --config-file strategy of cron overrides --strategy single without --start/--end", async () => {
      const f = writeJson("cron-override.json", { strategy: "cron" });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "single", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("addMaintenance")[0]!.args[0] as Record<string, unknown>;
      expect(sent.strategy).toBe("cron");
    });

    test("a --config-file strategy of single without a range exits 2", async () => {
      const f = writeJson("single-override.json", { strategy: "single" });
      const r = await run(
        sb,
        ["maintenance", "add", "--title", "w", "--strategy", "cron", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--strategy single requires --start and --end");
      expect(kuma.calls).toHaveLength(0);
    });
  });

  describe("monitors", () => {
    test("prints the attached monitors sorted by id", async () => {
      kuma.state.maintenanceMonitors[1] = [5, 3];
      const r = await run(sb, ["maintenance", "monitors", "1"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([
        { id: 3, name: "db" },
        { id: 5, name: "web" },
      ]);
      expect(callsOf("getMonitorMaintenance")[0]!.args).toEqual([1]);
      expect(callsOf("addMonitorMaintenance")).toHaveLength(0);
    });

    test("prints an empty array when nothing is attached", async () => {
      const r = await run(sb, ["maintenance", "monitors", "2"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([]);
    });

    test("--add merges into the current set and prints the result", async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      const r = await run(sb, ["maintenance", "monitors", "1", "--add", "5"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([
        { id: 3, name: "db" },
        { id: 5, name: "web" },
      ]);
      // Kuma replaces the whole set: the send carries every attached id
      expect(callsOf("addMonitorMaintenance")[0]!.args).toEqual([1, [{ id: 3 }, { id: 5 }]]);
      expect(kuma.state.maintenanceMonitors[1]).toEqual([3, 5]);
    });

    test("--remove drops the id from the set", async () => {
      kuma.state.maintenanceMonitors[1] = [3, 5];
      const r = await run(sb, ["maintenance", "monitors", "1", "--remove", "3"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([{ id: 5, name: "web" }]);
      expect(callsOf("addMonitorMaintenance")[0]!.args).toEqual([1, [{ id: 5 }]]);
      expect(kuma.state.maintenanceMonitors[1]).toEqual([5]);
    });

    test("--add of an already attached id does not duplicate it", async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      const r = await run(sb, ["maintenance", "monitors", "1", "--add", "3"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(callsOf("addMonitorMaintenance")[0]!.args).toEqual([1, [{ id: 3 }]]);
      expect(r.json()).toEqual([{ id: 3, name: "db" }]);
    });

    test("--set-ids replaces the set without reading it first", async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      const r = await run(
        sb,
        ["maintenance", "monitors", "1", "--set-ids", "5,3"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("getMonitorMaintenance")).toHaveLength(0);
      expect(callsOf("addMonitorMaintenance")[0]!.args).toEqual([1, [{ id: 3 }, { id: 5 }]]);
      expect(r.json()).toEqual([
        { id: 3, name: "db" },
        { id: 5, name: "web" },
      ]);
    });

    test('--set-ids "" clears the set', async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      const r = await run(sb, ["maintenance", "monitors", "1", "--set-ids", ""], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(callsOf("addMonitorMaintenance")[0]!.args).toEqual([1, []]);
      expect(r.json()).toEqual([]);
      expect(kuma.state.maintenanceMonitors[1]).toEqual([]);
    });

    test("--set-ids cannot be combined with --add", async () => {
      const r = await run(
        sb,
        ["maintenance", "monitors", "1", "--set-ids", "3", "--add", "5"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--set-ids cannot be combined");
      expect(kuma.calls).toHaveLength(0);
    });

    test("--set-ids cannot be combined with --remove", async () => {
      const r = await run(
        sb,
        ["maintenance", "monitors", "1", "--set-ids", "3", "--remove", "5"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--set-ids cannot be combined");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an unknown monitor id exits 1 without touching the set", async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      const r = await run(sb, ["maintenance", "monitors", "1", "--add", "99"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("monitor 99 not found");
      expect(callsOf("getMonitorMaintenance")).toHaveLength(0);
      expect(callsOf("addMonitorMaintenance")).toHaveLength(0);
      expect(kuma.state.maintenanceMonitors[1]).toEqual([3]);
    });

    test("an unknown monitor id in --set-ids exits 1", async () => {
      const r = await run(
        sb,
        ["maintenance", "monitors", "1", "--set-ids", "3,99"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("monitor 99 not found");
      expect(callsOf("addMonitorMaintenance")).toHaveLength(0);
    });

    test("an unknown maintenance id exits 1 without requesting the set", async () => {
      const r = await run(sb, ["maintenance", "monitors", "9"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("getMonitorMaintenance")).toHaveLength(0);
    });

    test("an invalid maintenance id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "monitors", "abc"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("an invalid --set-ids entry exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["maintenance", "monitors", "1", "--set-ids", "3,x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("positive integer");
      expect(kuma.calls).toHaveLength(0);
    });

    test("addMonitorMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.maintenanceMonitors[1] = [3];
      kuma.state.fail.addMonitorMaintenance = "attach failed";
      const r = await run(sb, ["maintenance", "monitors", "1", "--add", "5"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("attach failed");
    });

    test("getMonitorMaintenance ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.getMonitorMaintenance = "read failed";
      const r = await run(sb, ["maintenance", "monitors", "1"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("read failed");
    });

    test("--remove of an unknown monitor id exits 1", async () => {
      const r = await run(sb, ["maintenance", "monitors", "1", "--remove", "99"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("monitor 99 not found");
      expect(callsOf("getMonitorMaintenance")).toHaveLength(0);
      expect(callsOf("addMonitorMaintenance")).toHaveLength(0);
    });

    test("an attached id missing from monitorList exits 1", async () => {
      kuma.state.maintenanceMonitors[1] = [99];
      const r = await run(sb, ["maintenance", "monitors", "1"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("monitor 99 not found");
    });

    test("an id missing from the pushed list prints a null name after a write", async () => {
      kuma.state.monitors.push({ id: 99, name: "late", type: "http", active: true });
      kuma.state.unlistedMonitors = [99];
      kuma.state.maintenanceMonitors[1] = [99];
      const r = await run(sb, ["maintenance", "monitors", "1", "--add", "5"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([
        { id: 5, name: "web" },
        { id: 99, name: null },
      ]);
    });

    test("does not wait for the statusPageList push", async () => {
      kuma.state.skipLists = ["statusPageList"];
      const r = await run(sb, ["maintenance", "monitors", "1"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([]);
    });
  });

  describe("status-pages", () => {
    test("prints the attached status pages sorted by id", async () => {
      kuma.state.maintenanceStatusPages[1] = [7, 4];
      const r = await run(sb, ["maintenance", "status-pages", "1"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([
        { id: 4, title: "Ops page" },
        { id: 7, title: "Status page" },
      ]);
      expect(callsOf("getMaintenanceStatusPage")[0]!.args).toEqual([1]);
      expect(callsOf("addMaintenanceStatusPage")).toHaveLength(0);
    });

    test("prints an empty array when nothing is attached", async () => {
      const r = await run(sb, ["maintenance", "status-pages", "2"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([]);
    });

    test("--add merges into the current set and prints the result", async () => {
      kuma.state.maintenanceStatusPages[1] = [4];
      const r = await run(sb, ["maintenance", "status-pages", "1", "--add", "7"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(callsOf("addMaintenanceStatusPage")[0]!.args).toEqual([1, [{ id: 4 }, { id: 7 }]]);
      expect(r.json()).toEqual([
        { id: 4, title: "Ops page" },
        { id: 7, title: "Status page" },
      ]);
      expect(kuma.state.maintenanceStatusPages[1]).toEqual([4, 7]);
    });

    test("--remove drops the id from the set", async () => {
      kuma.state.maintenanceStatusPages[1] = [4, 7];
      const r = await run(
        sb,
        ["maintenance", "status-pages", "1", "--remove", "4"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([{ id: 7, title: "Status page" }]);
      expect(callsOf("addMaintenanceStatusPage")[0]!.args).toEqual([1, [{ id: 7 }]]);
      expect(kuma.state.maintenanceStatusPages[1]).toEqual([7]);
    });

    test("--set-ids replaces the set without reading it first", async () => {
      kuma.state.maintenanceStatusPages[1] = [4];
      const r = await run(
        sb,
        ["maintenance", "status-pages", "1", "--set-ids", "7"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("getMaintenanceStatusPage")).toHaveLength(0);
      expect(callsOf("addMaintenanceStatusPage")[0]!.args).toEqual([1, [{ id: 7 }]]);
      expect(r.json()).toEqual([{ id: 7, title: "Status page" }]);
    });

    test('--set-ids "" clears the set', async () => {
      kuma.state.maintenanceStatusPages[1] = [4];
      const r = await run(
        sb,
        ["maintenance", "status-pages", "1", "--set-ids", ""],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("addMaintenanceStatusPage")[0]!.args).toEqual([1, []]);
      expect(r.json()).toEqual([]);
      expect(kuma.state.maintenanceStatusPages[1]).toEqual([]);
    });

    test("--set-ids cannot be combined with --add or --remove", async () => {
      const r = await run(
        sb,
        ["maintenance", "status-pages", "1", "--set-ids", "4", "--remove", "7"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--set-ids cannot be combined");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an unknown status page id exits 1", async () => {
      const r = await run(sb, ["maintenance", "status-pages", "1", "--add", "99"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page 99 not found");
      expect(callsOf("getMaintenanceStatusPage")).toHaveLength(0);
      expect(callsOf("addMaintenanceStatusPage")).toHaveLength(0);
    });

    test("an unknown maintenance id exits 1", async () => {
      const r = await run(sb, ["maintenance", "status-pages", "9"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("maintenance 9 not found");
      expect(callsOf("getMaintenanceStatusPage")).toHaveLength(0);
    });

    test("an invalid maintenance id exits 2 before connecting", async () => {
      const r = await run(sb, ["maintenance", "status-pages", "abc"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("addMaintenanceStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.addMaintenanceStatusPage = "attach failed";
      const r = await run(
        sb,
        ["maintenance", "status-pages", "1", "--set-ids", "4"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("attach failed");
    });

    test("getMaintenanceStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.getMaintenanceStatusPage = "read failed";
      const r = await run(sb, ["maintenance", "status-pages", "1"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("read failed");
    });

    test("waits for the statusPageList push", async () => {
      kuma.state.skipLists = ["statusPageList"];
      const r = await run(sb, ["maintenance", "status-pages", "1"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("statusPageList");
    });
  });
});
