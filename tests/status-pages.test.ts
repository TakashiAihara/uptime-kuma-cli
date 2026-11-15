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
      expect(r.json()).toEqual({
        ...STATUS,
        publicGroupList: [
          { id: 3, name: "Core", weight: 1, monitorList: [{ id: 5, name: "web" }] },
        ],
        incident: {
          id: 1,
          style: "danger",
          title: "Outage",
          content: "db is down",
          pin: true,
          createdDate: "2030-01-01 10:00:00",
          lastUpdatedDate: "2030-01-01 11:00:00",
        },
      });
    });

    test("prints incident null and an empty publicGroupList when there are none", async () => {
      const r = await run(sb, ["status-pages", "get", "ops"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ ...OPS, publicGroupList: [], incident: null });
    });

    test("an unpinned or inactive incident is not shown", async () => {
      kuma.state.incidents = [
        { id: 1, statusPageId: 7, title: "Old", pin: false, active: true },
        { id: 2, statusPageId: 7, title: "Inactive", pin: true, active: false },
      ];
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(0);
      expect(r.json().incident).toBeNull();
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

    test("a failed HTTP fetch exits 1 naming the URL", async () => {
      kuma.state.statusPageApiStatus = 500;
      const r = await run(sb, ["status-pages", "get", "status"], creds(kuma.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("/api/status-page/status");
      expect(r.stderr).toContain("500");
      expect(callsOf("getStatusPage")).toHaveLength(1);
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
