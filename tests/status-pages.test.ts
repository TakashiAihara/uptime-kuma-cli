import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeKuma, type StatusPageRow, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

// StatusPage.toJSON shape; the pushed statusPageList and getStatusPage carry it
const page = (over: { id: number; slug: string; title: string }): StatusPageRow => ({
  description: null,
  icon: "/icon.svg",
  theme: "auto",
  published: true,
  showTags: false,
  domainNameList: [],
  customCSS: null,
  footerText: null,
  showPoweredBy: true,
  googleAnalyticsId: null,
  showCertificateExpiry: false,
  ...over,
});

const OPS = page({ id: 9, slug: "ops", title: "Ops page" });
const STATUS = page({ id: 7, slug: "status", title: "Status page" });

const callsOf = (event: string) => kuma.calls.filter((c) => c.event === event);

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    statusPages: [structuredClone(STATUS), structuredClone(OPS)],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("status-pages", () => {
  describe("list", () => {
    test("prints the pushed pages sorted by title", async () => {
      const r = await run(sb, ["status-pages", "list"], creds(kuma.url));
      expect(r.code).toBe(0);
      // "Ops page" sorts before "Status page"; id order would be the reverse
      expect(r.json()).toEqual([OPS, STATUS]);
    });

    test("prints an empty array when Kuma has no status pages", async () => {
      kuma.state.statusPages = [];
      const r = await run(sb, ["status-pages", "list"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([]);
    });

    test("waits for the statusPageList push", async () => {
      kuma.state.skipLists = ["statusPageList"];
      const r = await run(sb, ["status-pages", "list"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("statusPageList");
    });
  });

  describe("get", () => {
    test("prints the config merged with publicGroupList and the pinned incident", async () => {
      kuma.state.incidents = [
        {
          id: 1,
          statusPageId: 7,
          title: "Outage",
          content: "db is down",
          style: "danger",
          pin: true,
          active: true,
          createdDate: "2030-01-01 10:00:00",
          lastUpdatedDate: "2030-01-01 11:00:00",
        },
      ];
      kuma.state.statusPageGroups[7] = [
        { id: 3, name: "Core", weight: 1, monitorList: [{ id: 5, name: "web" }] },
      ];
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(callsOf("getStatusPage")[0]!.args).toEqual(["status"]);
      const incident = {
        id: 1,
        style: "danger",
        title: "Outage",
        content: "db is down",
        pin: true,
        createdDate: "2030-01-01 10:00:00",
        lastUpdatedDate: "2030-01-01 11:00:00",
      };
      expect(r.json()).toEqual({
        ...STATUS,
        publicGroupList: [
          { id: 3, name: "Core", weight: 1, monitorList: [{ id: 5, name: "web" }] },
        ],
        incident,
        // 1.x's single incident is wrapped for output written against 2.x
        incidents: [incident],
      });
    });

    test("prints incident null and an empty publicGroupList when there are none", async () => {
      const r = await run(sb, ["status-pages", "get", "ops"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({
        ...OPS,
        publicGroupList: [],
        incident: null,
        incidents: [],
      });
    });

    test("an unpinned or inactive incident is not shown", async () => {
      kuma.state.incidents = [
        { id: 1, statusPageId: 7, title: "Old", pin: false, active: true },
        { id: 2, statusPageId: 7, title: "Inactive", pin: true, active: false },
      ];
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json().incident).toBeNull();
      expect(r.json().incidents).toEqual([]);
    });

    test("an unknown slug exits 1 without calling getStatusPage", async () => {
      const r = await run(sb, ["status-pages", "get", "ghost"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page ghost not found");
      expect(callsOf("getStatusPage")).toHaveLength(0);
    });

    test("getStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.getStatusPage = "No slug?";
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("No slug?");
    });

    test("a network failure on the public route exits 2 naming the URL", async () => {
      kuma.state.statusPageApiDrop = true;
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("/api/status-page/status");
    });

    test("a password in a public monitor url prints as ***", async () => {
      const userinfo = ["probe", "urlpw-in-fixture"].join(":");
      kuma.state.statusPageGroups[7] = [
        {
          id: 3,
          name: "Core",
          weight: 1,
          monitorList: [
            { id: 5, name: "web", sendUrl: 1, url: `https://${userinfo}@example.com/health` },
          ],
        },
      ];
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("urlpw-in-fixture");
      expect(r.json().publicGroupList[0].monitorList[0].url).toBe("https://***@example.com/health");
    });

    test("a failed HTTP fetch exits 1 naming the URL", async () => {
      kuma.state.statusPageApiStatus = 500;
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("/api/status-page/status");
      expect(r.stderr).toContain("500");
      expect(callsOf("getStatusPage")).toHaveLength(1);
    });

    test("the error body's msg appears in the HTTP failure", async () => {
      kuma.state.statusPageApiStatus = 500;
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Not Found");
    });

    test("the URL in the error carries no userinfo", async () => {
      kuma.state.statusPageApiStatus = 500;
      const withUser = kuma.url.replace("://", "://proxyuser:proxy-secret@");
      const r = await run(sb, ["status-pages", "get", "status"], creds(withUser));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("/api/status-page/status");
      expect(r.stderr).not.toContain("proxy-secret");
    });

    test("a non-object incident in the /api/status-page body exits 70", async () => {
      kuma.state.statusPageApiBody = { config: {}, incident: "pinned", publicGroupList: [] };
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(70);
    });

    test("a /api/status-page body without the incident key exits 70", async () => {
      kuma.state.statusPageApiBody = { config: {}, publicGroupList: [] };
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(70);
      expect(r.stderr).toContain("unexpected /api/status-page response");
    });

    test("a malformed /api/status-page body exits 70", async () => {
      kuma.state.statusPageApiBody = { config: {}, incident: null };
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(70);
      expect(r.stderr).toContain("unexpected /api/status-page response");
    });
  });

  describe("add", () => {
    test("sends the trimmed title and lower-cased slug, then prints the new page", async () => {
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", " New-Status ", "--title", "  Fresh Page  "],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("addStatusPage")[0]!.args).toEqual(["Fresh Page", "new-status"]);
      // addStatusPage does not re-push statusPageList, so the printed toJSON
      // comes from the follow-up getStatusPage
      expect(callsOf("getStatusPage")[0]!.args).toEqual(["new-status"]);
      expect(r.json()).toEqual(page({ id: 10, slug: "new-status", title: "Fresh Page" }));
      expect(kuma.state.statusPages).toHaveLength(3);
    });

    test("an existing slug exits 3 without sending addStatusPage", async () => {
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", "ops", "--title", "Another"],
        creds(kuma.url),
      );
      expect(r.code).toBe(3);
      expect(r.json()).toEqual({ id: 9, slug: "ops", title: "Ops page", skipped: true });
      expect(callsOf("addStatusPage")).toHaveLength(0);
      expect(kuma.state.statusPages).toHaveLength(2);
    });

    test("the slug match is case-insensitive like Kuma's lower-casing", async () => {
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", "OPS", "--title", "Another"],
        creds(kuma.url),
      );
      expect(r.code).toBe(3);
      expect(callsOf("addStatusPage")).toHaveLength(0);
    });

    test.each(["a_b", "-abc", "abc-", "a--b", "a b", "a.b", ""])(
      "an invalid --slug %p exits 2 before connecting",
      async (slug) => {
        const r = await run(
          sb,
          ["status-pages", "add", "--slug", slug, "--title", "x"],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(kuma.calls).toHaveLength(0);
      },
    );

    test.each(["", "   "])("an empty --title %p exits 2 before connecting", async (title) => {
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", "new", "--title", title],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--title");
      expect(kuma.calls).toHaveLength(0);
    });

    test("without --slug exits 2 before connecting", async () => {
      const r = await run(sb, ["status-pages", "add", "--title", "x"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("without --title exits 2 before connecting", async () => {
      const r = await run(sb, ["status-pages", "add", "--slug", "new"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("addStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.addStatusPage = "Invalid Slug";
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", "new", "--title", "x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Invalid Slug");
    });

    test("a getStatusPage failure after add exits 1 with Kuma's message", async () => {
      kuma.state.fail.getStatusPage = "No slug?";
      const r = await run(
        sb,
        ["status-pages", "add", "--slug", "new", "--title", "x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("No slug?");
      expect(kuma.state.statusPages).toHaveLength(3);
    });
  });

  describe("delete", () => {
    test("sends deleteStatusPage and prints { slug, deleted: true }", async () => {
      kuma.state.incidents = [{ id: 1, statusPageId: 9, title: "Old", pin: true }];
      const r = await run(sb, ["status-pages", "delete", "ops", "--yes"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ slug: "ops", deleted: true });
      expect(callsOf("deleteStatusPage")[0]!.args).toEqual(["ops"]);
      expect(kuma.state.statusPages.map((p) => p.slug)).toEqual(["status"]);
      // the page's incidents are deleted with it
      expect(kuma.state.incidents).toHaveLength(0);
    });

    test("without --yes exits 2 before connecting", async () => {
      const r = await run(sb, ["status-pages", "delete", "ops"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("would delete status page ops");
      expect(r.stderr).toContain("--yes");
      expect(kuma.calls).toHaveLength(0);
    });

    test("an unknown slug exits 1 without calling deleteStatusPage", async () => {
      const r = await run(sb, ["status-pages", "delete", "ghost", "--yes"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page ghost not found");
      expect(callsOf("deleteStatusPage")).toHaveLength(0);
    });

    test("deleteStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.deleteStatusPage = "Status Page is not found";
      const r = await run(sb, ["status-pages", "delete", "ops", "--yes"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Status Page is not found");
    });
  });

  describe("incident", () => {
    test("posts the incident with the UI default style and prints it", async () => {
      const r = await run(
        sb,
        ["status-pages", "incident", "status", "--title", "Degraded", "--content", "Investigating"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("postIncident")[0]!.args).toEqual([
        "status",
        { title: "Degraded", content: "Investigating", style: "primary" },
      ]);
      // 1.x's postIncident unpins by itself; the explicit unpinIncident is 2.x-only
      expect(callsOf("unpinIncident")).toHaveLength(0);
      expect(r.json()).toMatchObject({
        id: 1,
        style: "primary",
        title: "Degraded",
        content: "Investigating",
        pin: true,
      });
      expect(kuma.state.incidents[0]!.pin).toBe(true);
    });

    test("--style is sent through", async () => {
      const r = await run(
        sb,
        [
          "status-pages",
          "incident",
          "status",
          "--title",
          "t",
          "--content",
          "c",
          "--style",
          "danger",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect((callsOf("postIncident")[0]!.args[1] as any).style).toBe("danger");
      expect(r.json().style).toBe("danger");
    });

    test("an invalid --style exits 2 before connecting", async () => {
      const r = await run(
        sb,
        [
          "status-pages",
          "incident",
          "status",
          "--title",
          "t",
          "--content",
          "c",
          "--style",
          "bogus",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test.each([
      ["--title", ""],
      ["--content", ""],
    ])("an empty %s exits 2 before connecting", async (flag, value) => {
      const args = ["status-pages", "incident", "status", "--title", "t", "--content", "c"];
      const i = args.indexOf(flag);
      args[i + 1] = value;
      const r = await run(sb, args, creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("an unknown slug exits 1 without calling postIncident", async () => {
      const r = await run(
        sb,
        ["status-pages", "incident", "ghost", "--title", "t", "--content", "c"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page ghost not found");
      expect(callsOf("postIncident")).toHaveLength(0);
    });

    test("postIncident ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.postIncident = "slug is not found";
      const r = await run(
        sb,
        ["status-pages", "incident", "status", "--title", "t", "--content", "c"],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("slug is not found");
      // 1.x's postIncident unpins inside the same call, so there is no
      // unpinned-first window to warn about
      expect(r.stderr).not.toContain("unpinned");
    });

    test("postIncident ok:true without an incident exits 70", async () => {
      kuma.state.postIncidentResult = { ok: true };
      const r = await run(
        sb,
        ["status-pages", "incident", "status", "--title", "t", "--content", "c"],
        creds(kuma.url),
      );
      expect(r.code).toBe(70);
      expect(r.stderr).toContain("unexpected postIncident response");
    });

    test("posting unpins the page's previous incidents only", async () => {
      kuma.state.incidents = [
        { id: 1, statusPageId: 7, title: "Old", pin: true, active: true },
        { id: 2, statusPageId: 9, title: "Other page", pin: true, active: true },
      ];
      const r = await run(
        sb,
        ["status-pages", "incident", "status", "--title", "New", "--content", "c"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json().id).toBe(3);
      expect(kuma.state.incidents.find((i) => i.id === 1)!.pin).toBe(false);
      expect(kuma.state.incidents.find((i) => i.id === 2)!.pin).toBe(true);
      expect(kuma.state.incidents.find((i) => i.id === 3)!.pin).toBe(true);
    });

    test("without --content exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["status-pages", "incident", "status", "--title", "t"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });
  });

  describe("incident-history", () => {
    test("exits 2 on Kuma 1.23, where the event does not exist", async () => {
      const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("incident-history needs Uptime Kuma >= 2.1.0");
      expect(callsOf("getIncidentHistory")).toHaveLength(0);
    });

    describe("on Kuma 2.x", () => {
      beforeEach(async () => {
        await kuma.close();
        kuma = await startFakeKuma({
          profile: "2.x",
          statusPages: [structuredClone(STATUS), structuredClone(OPS)],
        });
      });

      test("prints the page's incidents newest first with the total", async () => {
        kuma.state.incidents = [
          { id: 1, statusPageId: 7, title: "Old", createdDate: "2024-01-01T00:00:00.000Z" },
          { id: 2, statusPageId: 7, title: "New", createdDate: "2024-01-02T00:00:00.000Z" },
          { id: 3, statusPageId: 9, title: "Other page", createdDate: "2024-01-03T00:00:00.000Z" },
        ];
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(0);
        const out = r.json();
        expect(out.slug).toBe("status");
        expect(out.total).toBe(2);
        expect((out.incidents as { id: number }[]).map((i) => i.id)).toEqual([2, 1]);
        expect(callsOf("getIncidentHistory")[0]!.args).toEqual(["status", null]);
      });

      test("follows nextCursor until hasMore is false", async () => {
        kuma.state.incidents = Array.from({ length: 12 }, (_, i) => ({
          id: i + 1,
          statusPageId: 7,
          title: `i${i + 1}`,
          createdDate: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        }));
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(0);
        const out = r.json();
        expect(out.total).toBe(12);
        expect((out.incidents as { id: number }[]).map((i) => i.id)).toEqual([
          12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        ]);
        const calls = callsOf("getIncidentHistory");
        expect(calls).toHaveLength(2);
        // the second call's cursor is the first page's last created_date
        expect(calls[1]!.args[1]).toBe("2024-01-03T00:00:00.000Z");
      });

      test("warns when rows sharing the boundary created_date stay unfetched", async () => {
        // the server pages on created_date < cursor, so a row timestamped
        // equal to the last row of a page can never be returned; the CLI
        // reports the shortfall instead of printing a quietly cut history
        kuma.state.incidents = Array.from({ length: 11 }, (_, i) => ({
          id: i + 1,
          statusPageId: 7,
          title: `i${i + 1}`,
          createdDate: "2024-01-01T00:00:00.000Z",
        }));
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(0);
        const out = r.json();
        expect(out.total).toBe(11);
        expect(out.incidents).toHaveLength(10);
        expect(r.stderr).toContain(
          "warning: incident history may be incomplete: got 10 of 11 incidents",
        );
      });

      test("an unknown slug exits 1 without calling getIncidentHistory", async () => {
        const r = await run(sb, ["status-pages", "incident-history", "ghost"], creds(kuma.url));
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("status page ghost not found");
        expect(callsOf("getIncidentHistory")).toHaveLength(0);
      });

      test("a non-array incidents page exits 70", async () => {
        kuma.state.incidentHistoryResult = { ok: true, incidents: "oops" };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a hasMore page without a usable cursor exits 70", async () => {
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [],
          total: 30,
          hasMore: true,
          nextCursor: null,
        };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a repeated nextCursor stops the walk instead of looping", async () => {
        // a server answering the same page forever would otherwise be
        // re-requested without end — the equal cursor ends the walk and the
        // count check reports the shortfall
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [{ id: 1, title: "i1" }],
          total: 5,
          hasMore: true,
          nextCursor: "2024-01-01T00:00:00.000Z",
        };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(0);
        expect(callsOf("getIncidentHistory")).toHaveLength(2);
        // the replayed page's rows are not collected again, so the count
        // honestly reports the shortfall
        expect(r.stderr).toContain(
          "warning: incident history may be incomplete: got 1 of 5 incidents",
        );
        expect(r.json().incidents).toHaveLength(1);
      });

      test("a cursor cycle stops the walk instead of looping", async () => {
        // A -> B -> A: only the immediate-repeat check would not catch this,
        // so the visited set bounds the walk. The third page's rows are new
        // ids though — only the repeated cursor ends the walk, they are
        // still collected
        kuma.state.incidentHistoryResults = [
          {
            ok: true,
            incidents: [{ id: 1, title: "i1" }],
            total: 3,
            hasMore: true,
            nextCursor: "A",
          },
          {
            ok: true,
            incidents: [{ id: 2, title: "i2" }],
            total: 3,
            hasMore: true,
            nextCursor: "B",
          },
          {
            ok: true,
            incidents: [{ id: 3, title: "i3" }],
            total: 3,
            hasMore: true,
            nextCursor: "A",
          },
        ];
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(0);
        expect(callsOf("getIncidentHistory")).toHaveLength(3);
        expect(r.stderr).not.toContain("may be incomplete");
        expect(r.json().incidents).toHaveLength(3);
      });

      test("a history row with a non-numeric id exits 70", async () => {
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [{ id: "5", title: "x" }],
          total: 1,
        };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a negative total exits 70", async () => {
        kuma.state.incidentHistoryResult = { ok: true, incidents: [], total: -1 };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a fractional total exits 70", async () => {
        kuma.state.incidentHistoryResult = { ok: true, incidents: [], total: 1.5 };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a non-number total exits 70", async () => {
        kuma.state.incidentHistoryResult = { ok: true, incidents: [], total: "many" };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("a non-object incident row exits 70", async () => {
        kuma.state.incidentHistoryResult = { ok: true, incidents: [7], total: 1 };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
      });

      test("exits 2 on a 2.0.x server, where the event does not exist yet", async () => {
        kuma.state.info = { ...kuma.state.info, version: "2.0.2" };
        const r = await run(sb, ["status-pages", "incident-history", "status"], creds(kuma.url));
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("incident-history needs Uptime Kuma >= 2.1.0");
        expect(r.stderr).toContain("2.0.2");
        expect(callsOf("getIncidentHistory")).toHaveLength(0);
      });
    });
  });

  describe("incident-edit", () => {
    test("exits 2 on Kuma 1.23, where the event does not exist", async () => {
      const r = await run(
        sb,
        ["status-pages", "incident-edit", "status", "1", "--title", "x"],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("incident-edit needs Uptime Kuma >= 2.1.0");
      expect(callsOf("editIncident")).toHaveLength(0);
    });

    test("with no change flag exits 2 before connecting", async () => {
      const r = await run(sb, ["status-pages", "incident-edit", "status", "1"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "incident-edit requires at least one of --title, --content, --style, --pin or --unpin",
      );
      expect(callsOf("editIncident")).toHaveLength(0);
      expect(callsOf("getIncidentHistory")).toHaveLength(0);
    });

    describe("on Kuma 2.x", () => {
      beforeEach(async () => {
        await kuma.close();
        kuma = await startFakeKuma({
          profile: "2.x",
          statusPages: [structuredClone(STATUS), structuredClone(OPS)],
          incidents: [
            {
              id: 5,
              statusPageId: 7,
              title: "Old title",
              content: "Old body",
              style: "info",
              pin: false,
            },
          ],
        });
      });

      test("merges the flags over the stored incident and prints the saved one", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--title", "New title"],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        // editIncident overwrites every field, so omitted flags keep the
        // stored values, stored pin=false included
        expect(callsOf("editIncident")[0]!.args).toEqual([
          "status",
          5,
          { title: "New title", content: "Old body", style: "info", pin: false },
        ]);
        expect(r.json()).toMatchObject({
          id: 5,
          title: "New title",
          content: "Old body",
          style: "info",
          pin: false,
        });
      });

      test("a stored row without pin sends pin true like the UI default", async () => {
        // the wire can omit pin (absent column); editIncident's overwrite
        // would then send nothing, so the merge supplies the UI's default
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [{ id: 5, title: "t", content: "c", style: "info" }],
          total: 1,
          hasMore: false,
        };
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--title", "t2"],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        expect(callsOf("editIncident")[0]!.args).toEqual([
          "status",
          5,
          { title: "t2", content: "c", style: "info", pin: true },
        ]);
      });

      test("a non-string stored style falls back to warning", async () => {
        // validateIncident substitutes warning for an unknown style, so the
        // merge does the same rather than round-tripping a non-string
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [{ id: 5, title: "t", content: "c", style: 42, pin: false }],
          total: 1,
          hasMore: false,
        };
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--title", "t2"],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        expect(callsOf("editIncident")[0]!.args).toEqual([
          "status",
          5,
          { title: "t2", content: "c", style: "warning", pin: false },
        ]);
      });

      test("--pin and --unpin set the stored pin explicitly", async () => {
        const pin = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--pin"],
          creds(kuma.url),
        );
        expect(pin.code).toBe(0);
        expect((callsOf("editIncident")[0]!.args[2] as { pin: boolean }).pin).toBe(true);

        const unpin = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--unpin"],
          creds(kuma.url),
        );
        expect(unpin.code).toBe(0);
        expect((callsOf("editIncident")[1]!.args[2] as { pin: boolean }).pin).toBe(false);
      });

      test("--pin and --unpin together exit 2", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--pin", "--unpin"],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("--pin and --unpin cannot be combined");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("an unknown incident id exits 1 without calling editIncident", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "99", "--title", "x"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("incident 99 not found");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("an id lost to the created_date boundary reports an incomplete fetch", async () => {
        // eleven rows sharing one created_date: the eleventh sorts past the
        // first page's cursor (created_date < last) and can never be
        // returned, so "not found" would be a lie — the edit reports the
        // shortfall instead
        kuma.state.incidents = Array.from({ length: 11 }, (_, i) => ({
          id: i + 1,
          statusPageId: 7,
          title: `i${i + 1}`,
          createdDate: "2024-01-01T00:00:00.000Z",
        }));
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "11", "--title", "x"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          "incident 11 may exist: the fetched history is incomplete (10 of 11 fetched)",
        );
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("an id unfound on a repeated-cursor walk is reported maybe-existing", async () => {
        // a repeated cursor ends the walk before the replayed rows are
        // collected, so a total that still matches the gathered count leaves
        // only the truncated flag to mark the walk incomplete
        kuma.state.incidentHistoryResult = {
          ok: true,
          incidents: [
            { id: 1, title: "i1" },
            { id: 2, title: "i2" },
          ],
          total: 2,
          hasMore: true,
          nextCursor: "2024-01-01T00:00:00.000Z",
        };
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "9", "--title", "t"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("incident 9 may exist");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("a stored incident missing its title exits 70, not a usage error", async () => {
        kuma.state.incidents = [
          { id: 5, statusPageId: 7, content: "x", style: "info", pin: false },
        ];
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--pin"],
          creds(kuma.url),
        );
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected getIncidentHistory response");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("an edit keeps a resolved incident inactive", async () => {
        // upstream editIncident writes only title/content/style/pin and
        // lastUpdatedDate — active is untouched, so a resolved incident
        // stays resolved after a title change
        kuma.state.incidents = [
          {
            id: 6,
            statusPageId: 7,
            title: "Done",
            content: "x",
            style: "info",
            pin: false,
            active: false,
          },
        ];
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "6", "--title", "Done again"],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        expect(kuma.state.incidents[0]!.active).toBe(false);
        expect(r.json().active).toBe(false);
      });

      test("an empty --title exits 2 without calling editIncident", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--title", ""],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("incident title must not be empty");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("an invalid incident id exits 2", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "abc"],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("incident id must be a positive integer id");
      });

      test("an unknown slug exits 1 without calling getIncidentHistory", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "ghost", "5", "--title", "t"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("status page ghost not found");
        expect(callsOf("editIncident")).toHaveLength(0);
      });

      test("editIncident ok:true without an incident exits 70", async () => {
        kuma.state.editIncidentResult = { ok: true };
        const r = await run(
          sb,
          ["status-pages", "incident-edit", "status", "5", "--title", "x"],
          creds(kuma.url),
        );
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected editIncident response");
      });
    });
  });

  describe("incident-resolve", () => {
    test("exits 2 on Kuma 1.23, where the event does not exist", async () => {
      const r = await run(sb, ["status-pages", "incident-resolve", "status", "1"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("incident-resolve needs Uptime Kuma >= 2.1.0");
      expect(callsOf("resolveIncident")).toHaveLength(0);
    });

    describe("on Kuma 2.x", () => {
      beforeEach(async () => {
        await kuma.close();
        kuma = await startFakeKuma({
          profile: "2.x",
          statusPages: [structuredClone(STATUS), structuredClone(OPS)],
          incidents: [{ id: 5, statusPageId: 7, title: "Open", pin: true, active: true }],
        });
      });

      test("resolves the incident and prints it inactive and unpinned", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-resolve", "status", "5"],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        expect(callsOf("resolveIncident")[0]!.args).toEqual(["status", 5]);
        expect(r.json()).toMatchObject({ id: 5, active: false, pin: false });
        expect(kuma.state.incidents[0]).toMatchObject({ active: false, pin: false });
      });

      test("an invalid incident id exits 2 before connecting", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-resolve", "status", "abc"],
          creds(kuma.url),
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("incident id must be a positive integer id");
        expect(callsOf("resolveIncident")).toHaveLength(0);
        expect(callsOf("login")).toHaveLength(0);
      });

      test("an unknown incident id exits 1 with Kuma's message", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-resolve", "status", "99"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("Incident not found or access denied");
      });

      test("an unknown slug exits 1 without calling resolveIncident", async () => {
        const r = await run(
          sb,
          ["status-pages", "incident-resolve", "ghost", "5"],
          creds(kuma.url),
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("status page ghost not found");
        expect(callsOf("resolveIncident")).toHaveLength(0);
      });

      test("resolveIncident ok:true without an incident exits 70", async () => {
        kuma.state.resolveIncidentResult = { ok: true };
        const r = await run(
          sb,
          ["status-pages", "incident-resolve", "status", "5"],
          creds(kuma.url),
        );
        expect(r.code).toBe(70);
        expect(r.stderr).toContain("unexpected resolveIncident response");
      });
    });
  });

  describe("save", () => {
    const MONITORS = [
      { id: 5, name: "web", type: "http", url: "https://example.com" },
      { id: 6, name: "api", type: "http", url: "https://api.example.com" },
    ];

    const writeJson = (name: string, value: Record<string, unknown>) => {
      const path = join(sb.dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };

    beforeEach(() => {
      kuma.state.monitors = structuredClone(MONITORS);
    });

    test("merges the file over the fetched config and saves", async () => {
      const f = writeJson("page.json", {
        title: "Renamed page",
        description: "new desc",
        theme: "dark",
        showTags: true,
        domainNameList: ["status.example.com"],
        publicGroupList: [
          {
            name: "Core",
            monitorList: [
              { id: 5, sendUrl: true },
              { id: 6, type: "http" },
            ],
          },
          { name: "Edge", weight: 9, monitorList: [] },
        ],
      });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const sent = callsOf("saveStatusPage")[0]!.args;
      expect(sent[0]).toBe("status");
      const config = sent[1] as Record<string, unknown>;
      expect(config).toMatchObject({
        slug: "status",
        title: "Renamed page",
        description: "new desc",
        theme: "dark",
        showTags: true,
        domainNameList: ["status.example.com"],
      });
      // untouched fields keep the fetched values
      expect(config.footerText).toBe(STATUS.footerText);
      expect(config.published).toBe(true);
      // no logo in the file: the fetched icon goes as imgDataUrl
      expect(sent[2]).toBe("/icon.svg");
      // groups and monitors are reduced to what the handler reads
      expect(sent[3]).toEqual([
        { name: "Core", monitorList: [{ id: 5, sendUrl: true }, { id: 6 }] },
        { name: "Edge", monitorList: [] },
      ]);
      const j = r.json();
      expect(j.title).toBe("Renamed page");
      expect(j.slug).toBe("status");
      expect(j.incident).toBeNull();
      expect(j.incidents).toEqual([]);
      // printed like `get`: the fresh public route's groups carry the new ids
      expect(j.publicGroupList).toEqual([
        {
          id: 1,
          name: "Core",
          weight: 1,
          monitorList: [
            { id: 5, name: "web", sendUrl: true, type: "http", url: "https://example.com" },
            { id: 6, name: "api", sendUrl: 0, type: "http" },
          ],
        },
        { id: 2, name: "Edge", weight: 2, monitorList: [] },
      ]);
      expect(kuma.state.statusPages.find((p) => p.id === 7)!.title).toBe("Renamed page");
    });

    test("a slug in the file renames the page", async () => {
      const f = writeJson("page.json", { slug: " New-Status ", title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json().slug).toBe("new-status");
      expect(r.json().title).toBe("x");
      const sent = callsOf("saveStatusPage")[0]!.args;
      // the page is found by the old slug and stored under the new one
      expect(sent[0]).toBe("status");
      expect((sent[1] as Record<string, unknown>).slug).toBe("new-status");
      expect(kuma.state.statusPages.find((p) => p.id === 7)!.slug).toBe("new-status");
      // the printed config is read back under the new slug
      expect(callsOf("getStatusPage").at(-1)!.args).toEqual(["new-status"]);
    });

    test("a slug rename onto another page exits 3", async () => {
      const f = writeJson("page.json", { slug: "ops" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(3);
      expect(r.json()).toEqual({ id: 9, slug: "ops", title: "Ops page", skipped: true });
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test("an unknown slug exits 1 without calling saveStatusPage", async () => {
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "ghost", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page ghost not found");
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test("a group id that is not a fetched group exits 1", async () => {
      kuma.state.statusPageGroups[7] = [{ id: 3, name: "Core", weight: 1, monitorList: [] }];
      const f = writeJson("page.json", {
        publicGroupList: [{ id: 99, name: "G", monitorList: [] }],
      });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page group 99 not found");
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test("an existing group id is kept and unlisted groups are deleted", async () => {
      kuma.state.statusPageGroups[7] = [
        {
          id: 3,
          name: "Old",
          weight: 1,
          monitorList: [{ id: 5, name: "web", sendUrl: 0, type: "http" }],
        },
        { id: 4, name: "Dropped", weight: 2, monitorList: [] },
      ];
      const f = writeJson("page.json", {
        publicGroupList: [{ id: 3, name: "Core", monitorList: [{ id: 6, sendUrl: true }] }],
      });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      // the wire carries only what saveStatusPage reads
      const sent = callsOf("saveStatusPage")[0]!.args;
      expect(sent[0]).toBe("status");
      expect(sent[2]).toBe("/icon.svg");
      expect(sent[3]).toEqual([{ id: 3, name: "Core", monitorList: [{ id: 6, sendUrl: true }] }]);
      expect(kuma.state.statusPageGroups[7]).toEqual([
        {
          id: 3,
          name: "Core",
          weight: 1,
          monitorList: [
            {
              id: 6,
              name: "api",
              sendUrl: true,
              type: "http",
              url: "https://api.example.com",
            },
          ],
        },
      ]);
      expect(r.json().publicGroupList).toEqual(kuma.state.statusPageGroups[7]);
    });

    test("a monitor id that does not exist exits 1", async () => {
      const f = writeJson("page.json", {
        publicGroupList: [{ name: "G", monitorList: [{ id: 42 }] }],
      });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("monitor 42 not found");
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test("without publicGroupList the fetched groups are sent back reduced", async () => {
      kuma.state.statusPageGroups[7] = [
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
      ];
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      // the 0/1 sendUrl spelling and the extra monitor keys survive the round-trip
      expect(callsOf("saveStatusPage")[0]!.args[3]).toEqual([
        { id: 3, name: "Core", monitorList: [{ id: 5, sendUrl: 1 }] },
      ]);
    });

    test("a differing public url sends no monitor url on 1.x", async () => {
      // on 1.x the route's url is always the monitor's own, so a differing
      // one can only arrive as raw JSON; the url round-trip is a 2.x
      // custom_url feature, so 1.x keeps { id, sendUrl }
      kuma.state.statusPageGroups[7] = [
        { id: 3, name: "Core", weight: 1, monitorList: [{ id: 5, name: "web" }] },
      ];
      kuma.state.statusPageApiBody = {
        config: {},
        incident: null,
        publicGroupList: [
          {
            id: 3,
            name: "Core",
            monitorList: [
              { id: 5, name: "web", sendUrl: 1, type: "http", url: "https://custom.example.com" },
            ],
          },
        ],
        maintenanceList: [],
      };
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("saveStatusPage")[0]!.args[3]).toEqual([
        { id: 3, name: "Core", monitorList: [{ id: 5, sendUrl: 1 }] },
      ]);
    });

    test("an empty publicGroupList deletes every group", async () => {
      kuma.state.statusPageGroups[7] = [{ id: 3, name: "Core", weight: 1, monitorList: [] }];
      const f = writeJson("page.json", { publicGroupList: [] });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("saveStatusPage")[0]!.args[3]).toEqual([]);
      expect(kuma.state.statusPageGroups[7]).toEqual([]);
    });

    test("a logo URL becomes imgDataUrl and a PNG data URL is stored as an upload", async () => {
      const f = writeJson("page.json", { logo: "https://cdn.example.com/logo.png" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(callsOf("saveStatusPage")[0]!.args[2]).toBe("https://cdn.example.com/logo.png");
      expect(kuma.state.statusPages.find((p) => p.id === 7)!.icon).toBe(
        "https://cdn.example.com/logo.png",
      );

      const f2 = writeJson("page2.json", { logo: "data:image/png;base64,iVBORw0KGgo=" });
      const r2 = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f2],
        creds(kuma.url),
      );
      expect(r2.code).toBe(0);
      expect(callsOf("saveStatusPage")[1]!.args[2]).toBe("data:image/png;base64,iVBORw0KGgo=");
      expect(kuma.state.statusPages.find((p) => p.id === 7)!.icon).toMatch(
        /^\/upload\/logo7\.png\?t=/,
      );
    });

    test("saveStatusPage ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.saveStatusPage = "Only allowed PNG logo.";
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Only allowed PNG logo.");
    });

    test("without --config-file exits 2 before connecting", async () => {
      const r = await run(sb, ["status-pages", "save", "status"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test("a missing config file exits 2 before connecting", async () => {
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", join(sb.dir, "nope.json")],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    test.each([
      ["an unknown key", { id: 1 }],
      ["published", { published: false }],
      ["icon", { icon: "/x.png" }],
      ["a numeric slug", { slug: 5 }],
      ["a bad slug", { slug: "a_b" }],
      ["a blank slug", { slug: "   " }],
      ["an empty title", { title: "" }],
      ["a blank title", { title: "   " }],
      ["a numeric title", { title: 5 }],
      ["a bad theme", { theme: "neon" }],
      ["a numeric theme", { theme: 1 }],
      ["a string showTags", { showTags: "yes" }],
      ["a numeric description", { description: 5 }],
      ["a numeric footerText", { footerText: 5 }],
      ["an object customCSS", { customCSS: {} }],
      ["a numeric googleAnalyticsId", { googleAnalyticsId: 5 }],
      ["a string domainNameList", { domainNameList: "x.example.com" }],
      ["a numeric domain", { domainNameList: ["ok", 5] }],
      ["a numeric logo", { logo: 5 }],
      ["a jpeg data url", { logo: "data:image/jpeg;base64,AAA" }],
      ["a non-png data url", { logo: "data:text/plain;base64,AAA" }],
      ["a string publicGroupList", { publicGroupList: "x" }],
      ["a non-object group", { publicGroupList: [5] }],
      ["a group without monitorList", { publicGroupList: [{ name: "G" }] }],
      ["a group without name", { publicGroupList: [{ monitorList: [] }] }],
      ["an empty group name", { publicGroupList: [{ name: "", monitorList: [] }] }],
      ["a fractional group id", { publicGroupList: [{ id: 1.5, name: "G", monitorList: [] }] }],
      ["a non-object monitor", { publicGroupList: [{ name: "G", monitorList: [5] }] }],
      ["a monitor without id", { publicGroupList: [{ name: "G", monitorList: [{}] }] }],
      ["a zero monitor id", { publicGroupList: [{ name: "G", monitorList: [{ id: 0 }] }] }],
      [
        "a string sendUrl",
        { publicGroupList: [{ name: "G", monitorList: [{ id: 5, sendUrl: "yes" }] }] },
      ],
      [
        "a numeric sendUrl",
        { publicGroupList: [{ name: "G", monitorList: [{ id: 5, sendUrl: 2 }] }] },
      ],
      ["a negative autoRefreshInterval", { autoRefreshInterval: -1 }],
      ["a fractional autoRefreshInterval", { autoRefreshInterval: 1.5 }],
      ["a string autoRefreshInterval", { autoRefreshInterval: "300" }],
      ["a numeric rssTitle", { rssTitle: 5 }],
      ["a numeric analyticsId", { analyticsId: 5 }],
      ["a numeric analyticsScriptUrl", { analyticsScriptUrl: 5 }],
      ["a string showOnlyLastHeartbeat", { showOnlyLastHeartbeat: "yes" }],
      ["an unknown analyticsType", { analyticsType: "bogus" }],
      ["a numeric analyticsType", { analyticsType: 5 }],
    ])("an invalid file (%s) exits 2 before connecting", async (_label, value) => {
      const f = writeJson("page.json", value as Record<string, unknown>);
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    });

    // valid values, but 1.23's saveStatusPage never reads them: refused once
    // the version is known, before any page request is sent
    test.each([
      ["autoRefreshInterval", 300],
      ["rssTitle", "RSS"],
      ["showOnlyLastHeartbeat", true],
      ["analyticsId", "UA-1"],
      ["analyticsScriptUrl", "https://example.com/a.js"],
      ["analyticsType", "umami"],
    ])("%s exits 2 on a 1.x server before saveStatusPage", async (key, value) => {
      const f = writeJson("page.json", { [key]: value });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`"${key}" needs Uptime Kuma 2.x; the server reports 1.23.17`);
      expect(callsOf("getStatusPage")).toHaveLength(0);
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test("a 2.x save key exits 2 with the no-version note when the server sends none", async () => {
      kuma.state.info = null;
      const f = writeJson("page.json", { autoRefreshInterval: 60 });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("the server sent no version, so 1.x was assumed");
      expect(callsOf("saveStatusPage")).toHaveLength(0);
    });

    test.each(["description", "footerText", "customCSS", "googleAnalyticsId"])(
      "%s null in the file is sent as null",
      async (key) => {
        // the fetched value is non-null so the null override is observable
        kuma.state.statusPages.find((p) => p.id === 7)![key] = "old-value";
        const f = writeJson("page.json", { [key]: null });
        const r = await run(
          sb,
          ["status-pages", "save", "status", "--config-file", f],
          creds(kuma.url),
        );
        expect(r.code).toBe(0);
        const config = callsOf("saveStatusPage")[0]!.args[1] as Record<string, unknown>;
        expect(config[key]).toBeNull();
      },
    );

    test("delete and re-add of the same slug reads fresh groups", async () => {
      // the first save caches the page's groups on the public route; delete
      // and re-add do not clear Kuma's apicache, so only the cache-busting
      // query keeps the second save from seeing the deleted page's groups
      const f1 = writeJson("page1.json", {
        publicGroupList: [{ name: "Core", monitorList: [{ id: 5 }] }],
      });
      const s1 = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f1],
        creds(kuma.url),
      );
      expect(s1.code).toBe(0);
      const del = await run(sb, ["status-pages", "delete", "status", "--yes"], creds(kuma.url));
      expect(del.code).toBe(0);
      const add = await run(
        sb,
        ["status-pages", "add", "--slug", "status", "--title", "Status page"],
        creds(kuma.url),
      );
      expect(add.code).toBe(0);
      // AUTOINCREMENT: the re-added page does not reuse the deleted id
      expect(kuma.state.statusPages.find((p) => p.slug === "status")!.id).not.toBe(7);

      const f2 = writeJson("page2.json", { title: "Renamed again" });
      const s2 = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f2],
        creds(kuma.url),
      );
      expect(s2.code).toBe(0);
      expect(s2.json().title).toBe("Renamed again");
      expect(s2.json().publicGroupList).toEqual([]);
      // every public-route read carried the cache-busting query
      expect(kuma.state.apiRequests.length).toBeGreaterThan(0);
      expect(kuma.state.apiRequests.every((u) => u.includes("?_="))).toBe(true);
    });

    test("a failed getStatusPage read-back exits 0 with a warning", async () => {
      // the first getStatusPage (pre-save) passes, the read-back fails
      kuma.state.fail.getStatusPage = [null, "Read-back failed"];
      const f = writeJson("page.json", {
        title: "x",
        publicGroupList: [{ name: "Core", monitorList: [{ id: 5 }] }],
      });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      const j = r.json();
      expect(j.title).toBe("x");
      expect(j.slug).toBe("status");
      // the save response's groups carry the ids Kuma assigned
      expect(j.publicGroupList).toHaveLength(1);
      expect(j.publicGroupList[0].name).toBe("Core");
      expect(typeof j.publicGroupList[0].id).toBe("number");
      expect(j.incident).toBeNull();
      expect(j.incidents).toEqual([]);
      expect(r.stderr).toContain("Read-back failed");
    });

    test("an unexpected read-back shape after the save still exits 70", async () => {
      kuma.state.statusPageApiMalformedAfter = 1;
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(70);
      expect(callsOf("saveStatusPage")).toHaveLength(1);
    });

    test("a failed public-route read-back exits 0 with a warning", async () => {
      // the first /api/status-page request (pre-save) passes, the read-back fails
      kuma.state.statusPageApiFailAfter = 1;
      const f = writeJson("page.json", { title: "x" });
      const r = await run(
        sb,
        ["status-pages", "save", "status", "--config-file", f],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      expect(r.json().title).toBe("x");
      expect(r.stderr).toContain("/api/status-page/status");
      expect(r.stderr).toContain("500");
    });
  });

  describe("unpin", () => {
    test("sends unpinIncident and prints { slug, unpinned: true }", async () => {
      kuma.state.incidents = [{ id: 1, statusPageId: 7, title: "Old", pin: true }];
      const r = await run(sb, ["status-pages", "unpin", "status"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ slug: "status", unpinned: true });
      expect(callsOf("unpinIncident")[0]!.args).toEqual(["status"]);
      expect(kuma.state.incidents[0]!.pin).toBe(false);
    });

    test("an unknown slug exits 1 without calling unpinIncident", async () => {
      const r = await run(sb, ["status-pages", "unpin", "ghost"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("status page ghost not found");
      expect(callsOf("unpinIncident")).toHaveLength(0);
    });

    test("unpinIncident ok:false exits 1 with Kuma's message", async () => {
      kuma.state.fail.unpinIncident = "cannot unpin";
      const r = await run(sb, ["status-pages", "unpin", "status"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot unpin");
    });
  });
});
