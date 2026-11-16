import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeKuma, type StatusPageRow, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma | undefined;
let sb: Sandbox;

// StatusPage.toJSON shape on 2.5.11: the six refresh/analytics columns replace
// googleAnalyticsId
const page = (over: StatusPageRow): StatusPageRow => ({
  description: null,
  icon: "/icon.svg",
  theme: "auto",
  published: true,
  showTags: false,
  domainNameList: [],
  customCSS: null,
  footerText: null,
  showPoweredBy: true,
  showCertificateExpiry: false,
  autoRefreshInterval: 300,
  rssTitle: null,
  showOnlyLastHeartbeat: false,
  analyticsId: null,
  analyticsScriptUrl: null,
  analyticsType: null,
  ...over,
});

const OPS = page({ id: 9, slug: "ops", title: "Ops page" });
const STATUS = page({ id: 7, slug: "status", title: "Status page" });

const callsOf = (k: FakeKuma, event: string) => k.calls.filter((c) => c.event === event);

const writeJson = (name: string, value: Record<string, unknown>) => {
  const path = join(sb.dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await kuma?.close();
  kuma = undefined;
  sb.cleanup();
});

// Each test picks its own fixtures; the const keeps the fake non-optional for
// the assertions below.
async function useFake(init: Parameters<typeof startFakeKuma>[0] = {}): Promise<FakeKuma> {
  kuma = await startFakeKuma({ profile: "2.x", ...init });
  return kuma;
}

describe("status-pages get on Kuma 2.x", () => {
  test("prints the incidents array and the newest pinned one as incident", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      incidents: [
        {
          id: 1,
          statusPageId: 7,
          title: "Older by date",
          content: "c1",
          style: "info",
          pin: true,
          active: true,
          createdDate: "2030-01-01 10:00:00",
          lastUpdatedDate: null,
        },
        {
          id: 2,
          statusPageId: 7,
          title: "Newer by date",
          content: "c2",
          style: "danger",
          pin: true,
          active: true,
          createdDate: "2030-01-02 10:00:00",
          lastUpdatedDate: null,
        },
      ],
    });
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    const j = r.json();
    // the array is the route's created_date DESC order, with the 2.x-only fields
    expect(j.incidents).toEqual([
      {
        id: 2,
        style: "danger",
        title: "Newer by date",
        content: "c2",
        pin: true,
        createdDate: "2030-01-02 10:00:00",
        lastUpdatedDate: null,
        active: true,
        status_page_id: 7,
      },
      {
        id: 1,
        style: "info",
        title: "Older by date",
        content: "c1",
        pin: true,
        createdDate: "2030-01-01 10:00:00",
        lastUpdatedDate: null,
        active: true,
        status_page_id: 7,
      },
    ]);
    // incident is the newest by createdDate, the array's first element
    expect(j.incident.title).toBe("Newer by date");
  });

  test("incident falls back to the last element when dates are missing", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      incidents: [
        { id: 1, statusPageId: 7, title: "First", pin: true, active: true },
        { id: 2, statusPageId: 7, title: "Last", pin: true, active: true },
      ],
    });
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.incidents).toHaveLength(2);
    expect(j.incident.title).toBe("Last");
  });

  test("an undated incident never beats a dated one for incident", async () => {
    // the route sorts NULL created_date last, so the undated entry sits at
    // the array's end — it must not win the compatibility field
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      incidents: [
        { id: 1, title: "Dated", pin: true, createdDate: "2030-01-01 10:00:00" },
        { id: 2, title: "Undated", pin: true, createdDate: null },
      ],
      publicGroupList: [],
      maintenanceList: [],
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    expect(r.json().incident.title).toBe("Dated");
  });

  test("a dated incident displaces an earlier undated one", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      incidents: [
        { id: 1, title: "Undated", pin: true, createdDate: null },
        { id: 2, title: "Dated", pin: true, createdDate: "2030-01-01 10:00:00" },
      ],
      publicGroupList: [],
      maintenanceList: [],
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    expect(r.json().incident.title).toBe("Dated");
  });

  test("tied createdDates fall back to the last element", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      incidents: [
        { id: 1, title: "First", pin: true, createdDate: "2030-01-01 10:00:00" },
        { id: 2, title: "Second", pin: true, createdDate: "2030-01-01 10:00:00" },
      ],
      publicGroupList: [],
      maintenanceList: [],
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    expect(r.json().incident.title).toBe("Second");
  });

  test("get folds a stored customUrl into the public url", async () => {
    // the public monitor JSON emits url = customUrl ?? the monitor's url;
    // a customUrl different from the monitor url must win
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      statusPageGroups: {
        7: [
          {
            id: 3,
            name: "Core",
            weight: 1,
            monitorList: [
              {
                id: 5,
                name: "web",
                sendUrl: 1,
                type: "http",
                customUrl: "https://status.example.com/health",
                url: "https://example.com",
              },
            ],
          },
        ],
      },
    });
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    const monitor = r.json().publicGroupList[0].monitorList[0];
    expect(monitor.url).toBe("https://status.example.com/health");
    expect(monitor).not.toHaveProperty("customUrl");
  });

  test("incident is null and incidents empty when nothing is pinned", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      incidents: [
        { id: 1, statusPageId: 7, title: "Unpinned", pin: false, active: true },
        { id: 2, statusPageId: 7, title: "Inactive", pin: true, active: false },
      ],
    });
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.incident).toBeNull();
    expect(j.incidents).toEqual([]);
  });

  test("a pin:false entry in the array is not picked as incident", async () => {
    // the route only returns pinned incidents, but a body that carries an
    // unpinned one must not let it win the compatibility field
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      incidents: [
        { id: 1, title: "Unpinned", pin: false, createdDate: "2030-01-03 10:00:00" },
        { id: 2, title: "Pinned", pin: true, createdDate: "2030-01-01 10:00:00" },
      ],
      publicGroupList: [],
      maintenanceList: [],
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.incidents).toHaveLength(2);
    expect(j.incident.title).toBe("Pinned");
  });

  test("a 1.x-shaped body without incidents exits 70", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      incident: null,
      publicGroupList: [],
      maintenanceList: [],
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected /api/status-page response");
  });

  test.each([
    ["a non-array incidents", { incidents: "none" }],
    ["a non-object incident entry", { incidents: [5] }],
    ["a null incident entry", { incidents: [null] }],
    ["an array incident entry", { incidents: [[]] }],
  ])("%s in the body exits 70", async (_label, extra) => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.statusPageApiBody = {
      config: {},
      publicGroupList: [],
      maintenanceList: [],
      ...extra,
    };
    const r = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected /api/status-page response");
  });
});

describe("status-pages incident on Kuma 2.x", () => {
  test("unpins the page's incidents before posting the new one", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS), structuredClone(OPS)],
      incidents: [
        { id: 1, statusPageId: 7, title: "Old", pin: true, active: true },
        { id: 2, statusPageId: 9, title: "Other page", pin: true, active: true },
      ],
    });
    const r = await run(
      sb,
      ["status-pages", "incident", "status", "--title", "New", "--content", "c"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    // 2.x's postIncident does not unpin, so the CLI sends unpinIncident first
    const unpin = callsOf(k, "unpinIncident");
    const post = callsOf(k, "postIncident");
    expect(unpin).toHaveLength(1);
    expect(unpin[0]!.args).toEqual(["status"]);
    expect(post).toHaveLength(1);
    expect(k.calls.indexOf(unpin[0]!)).toBeLessThan(k.calls.indexOf(post[0]!));
    expect(k.state.incidents.find((i) => i.id === 1)!.pin).toBe(false);
    expect(k.state.incidents.find((i) => i.id === 2)!.pin).toBe(true);
    expect(k.state.incidents.find((i) => i.id === 3)!.pin).toBe(true);
  });
});

describe("status-pages save on Kuma 2.x", () => {
  const MONITORS = [
    { id: 5, name: "web", type: "http", url: "https://example.com" },
    { id: 6, name: "api", type: "http", url: "https://api.example.com" },
  ];

  test("googleAnalyticsId exits 2 pointing at the 2.x analytics keys", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.monitors = structuredClone(MONITORS);
    const f = writeJson("page.json", { googleAnalyticsId: "UA-1" });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("googleAnalyticsId");
    expect(r.stderr).toContain("analyticsId");
    expect(r.stderr).toContain("analyticsType");
    expect(r.stderr).toContain("2.5.11");
    expect(callsOf(k, "getStatusPage")).toHaveLength(0);
    expect(callsOf(k, "saveStatusPage")).toHaveLength(0);
  });

  test("the six 2.x keys are accepted, sent and stored", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    k.state.monitors = structuredClone(MONITORS);
    const f = writeJson("page.json", {
      autoRefreshInterval: 600,
      rssTitle: "Ops feed",
      showOnlyLastHeartbeat: true,
      analyticsId: "UA-123",
      analyticsScriptUrl: "https://a.example.com/x.js",
      analyticsType: "umami",
    });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    const config = callsOf(k, "saveStatusPage")[0]!.args[1] as Record<string, unknown>;
    expect(config).toMatchObject({
      autoRefreshInterval: 600,
      rssTitle: "Ops feed",
      showOnlyLastHeartbeat: true,
      analyticsId: "UA-123",
      analyticsScriptUrl: "https://a.example.com/x.js",
      analyticsType: "umami",
    });
    const stored = k.state.statusPages.find((p) => p.id === 7)!;
    expect(stored).toMatchObject({
      autoRefreshInterval: 600,
      rssTitle: "Ops feed",
      showOnlyLastHeartbeat: true,
      analyticsId: "UA-123",
      analyticsScriptUrl: "https://a.example.com/x.js",
      analyticsType: "umami",
    });
    // the read-back prints the stored values like `get` does
    expect(r.json()).toMatchObject({
      autoRefreshInterval: 600,
      rssTitle: "Ops feed",
      showOnlyLastHeartbeat: true,
      analyticsId: "UA-123",
      analyticsScriptUrl: "https://a.example.com/x.js",
      analyticsType: "umami",
    });
  });

  test("a null analyticsType in the file is sent as null", async () => {
    const k = await useFake({
      statusPages: [page({ id: 7, slug: "status", title: "Status page", analyticsType: "google" })],
    });
    k.state.monitors = structuredClone(MONITORS);
    const f = writeJson("page.json", { analyticsType: null });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    const config = callsOf(k, "saveStatusPage")[0]!.args[1] as Record<string, unknown>;
    expect(config.analyticsType).toBeNull();
    expect(k.state.statusPages.find((p) => p.id === 7)!.analyticsType).toBeNull();
  });

  test("an invalid analyticsType exits 2 before connecting", async () => {
    const k = await useFake({ statusPages: [structuredClone(STATUS)] });
    const f = writeJson("page.json", { analyticsType: "bogus" });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("analyticsType");
    expect(k.calls).toHaveLength(0);
  });

  test("a stored analyticsType outside the enum fails the save", async () => {
    // the CLI merges the fetched config, so a corrupt stored value reaches
    // saveStatusPage and 2.x's own check rejects it
    const k = await useFake({
      statusPages: [page({ id: 7, slug: "status", title: "Status page", analyticsType: "bogus" })],
    });
    k.state.monitors = structuredClone(MONITORS);
    const f = writeJson("page.json", { title: "x" });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid analytics type");
  });

  test("a get output's publicGroupList fed back stores no monitor url", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      monitors: structuredClone(MONITORS),
      statusPageGroups: {
        7: [
          {
            id: 3,
            name: "Core",
            weight: 1,
            monitorList: [
              {
                id: 5,
                name: "web",
                sendUrl: 1,
                type: "http",
                url: "https://example.com",
                tags: [{ name: "prod" }],
              },
            ],
          },
        ],
      },
    });
    const got = await run(sb, ["status-pages", "get", "status"], creds(k.url));
    expect(got.code).toBe(0);
    // the public monitor url the get output carries is dropped on save: only
    // id and sendUrl reach saveStatusPage, so no custom_url is stored
    const f = writeJson("page.json", {
      title: "Round trip",
      publicGroupList: got.json().publicGroupList,
    });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    expect(callsOf(k, "saveStatusPage")[0]!.args[3]).toEqual([
      { id: 3, name: "Core", monitorList: [{ id: 5, sendUrl: 1 }] },
    ]);
    const group = k.state.statusPageGroups[7]![0]!;
    const monitor = (group.monitorList as Record<string, unknown>[])[0]!;
    expect(monitor).not.toHaveProperty("customUrl");
    expect(monitor.url).toBe("https://example.com");
  });

  test("groups fetched for the save send no monitor url either", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      monitors: structuredClone(MONITORS),
      statusPageGroups: {
        7: [
          {
            id: 3,
            name: "Core",
            weight: 1,
            monitorList: [
              {
                id: 5,
                name: "web",
                sendUrl: 1,
                type: "http",
                // a custom_url stored earlier shows up as the public url
                customUrl: "https://status.example.com/health",
                url: "https://status.example.com/health",
              },
            ],
          },
        ],
      },
    });
    const f = writeJson("page.json", { title: "x" });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    expect(callsOf(k, "saveStatusPage")[0]!.args[3]).toEqual([
      { id: 3, name: "Core", monitorList: [{ id: 5, sendUrl: 1 }] },
    ]);
    const group = k.state.statusPageGroups[7]![0]!;
    const monitor = (group.monitorList as Record<string, unknown>[])[0]!;
    expect(monitor).not.toHaveProperty("customUrl");
    // without a sent url the public url falls back to the monitor's own
    expect(monitor.url).toBe("https://example.com");
  });

  test("the save output carries incidents like get", async () => {
    const k = await useFake({
      statusPages: [structuredClone(STATUS)],
      monitors: structuredClone(MONITORS),
      incidents: [
        {
          id: 1,
          statusPageId: 7,
          title: "Ongoing",
          content: "c",
          style: "warning",
          pin: true,
          active: true,
          createdDate: "2030-01-01 10:00:00",
          lastUpdatedDate: null,
        },
      ],
    });
    const f = writeJson("page.json", { title: "x" });
    const r = await run(sb, ["status-pages", "save", "status", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.incidents).toHaveLength(1);
    expect(j.incidents[0].title).toBe("Ongoing");
    expect(j.incident.title).toBe("Ongoing");
  });
});
