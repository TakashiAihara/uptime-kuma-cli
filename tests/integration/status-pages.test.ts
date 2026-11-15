import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("status-pages (real Kuma)", () => {
  let sb: Sandbox;
  // unique per run so a kept container does not hit the slug UNIQUE index
  const slug = `it-sp-${Date.now().toString(36)}`;
  const title = "it status page";

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add a status page", async () => {
    const r = await cliRun(sb, ["status-pages", "add", "--slug", slug, "--title", title]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ slug, title, theme: "auto" });
    expect(r.json().id).toBeGreaterThan(0);
  }, 120_000);

  test("list shows the page", async () => {
    const r = await cliRun(sb, ["status-pages", "list"]);
    expect(r.code).toBe(0);
    expect(r.json()).toContainEqual(expect.objectContaining({ slug, title }));
  }, 120_000);

  test("incident posts and pins an incident", async () => {
    const r = await cliRun(sb, [
      "status-pages",
      "incident",
      slug,
      "--title",
      "it incident",
      "--content",
      "it content",
      "--style",
      "warning",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      title: "it incident",
      content: "it content",
      style: "warning",
    });
    expect(r.json().pin).toBeTruthy();
  }, 120_000);

  test("get returns the config with the pinned incident", async () => {
    const r = await cliRun(sb, ["status-pages", "get", slug]);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.slug).toBe(slug);
    expect(j.title).toBe(title);
    expect(j.publicGroupList).toEqual([]);
    expect(j.incident).toMatchObject({ title: "it incident", style: "warning" });
    // Kuma caches /api/status-page/:slug for 5 minutes; unpin is not verified
    // through get because the cached body would still show the incident
  }, 120_000);

  test("save renames the title and attaches a group with one monitor", async () => {
    const mon = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-sp-mon",
      "--paused",
    ]);
    expect(mon.code).toBe(0);
    const monitorId = mon.json().id;
    expect(monitorId).toBeGreaterThan(0);

    const f = join(sb.dir, "page.json");
    writeFileSync(
      f,
      JSON.stringify({
        title: "it status page renamed",
        publicGroupList: [{ name: "Core", monitorList: [{ id: monitorId, sendUrl: true }] }],
      }),
    );
    const r = await cliRun(sb, ["status-pages", "save", slug, "--config-file", f]);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.title).toBe("it status page renamed");
    expect(j.slug).toBe(slug);
    // the save response's groups carry the id Kuma assigned
    expect(j.publicGroupList).toHaveLength(1);
    expect(j.publicGroupList[0].name).toBe("Core");
    expect(j.publicGroupList[0].id).toBeGreaterThan(0);
    expect(j.publicGroupList[0].monitorList).toEqual([{ id: monitorId, sendUrl: true }]);
    // the incident pinned by the earlier test is still shown
    expect(j.incident).toMatchObject({ title: "it incident" });

    const g = await cliRun(sb, ["status-pages", "get", slug]);
    expect(g.code).toBe(0);
    expect(g.json().title).toBe("it status page renamed");
    expect(g.json().publicGroupList[0].name).toBe("Core");
    expect(g.json().publicGroupList[0].monitorList[0].id).toBe(monitorId);
    expect(g.json().publicGroupList[0].monitorList[0].sendUrl).toBeTruthy();

    const del = await cliRun(sb, ["monitors", "delete", String(monitorId), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  test("unpin the incident", async () => {
    const r = await cliRun(sb, ["status-pages", "unpin", slug]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ slug, unpinned: true });
  }, 120_000);

  test("delete the status page", async () => {
    const r = await cliRun(sb, ["status-pages", "delete", slug, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ slug, deleted: true });
    const list = await cliRun(sb, ["status-pages", "list"]);
    expect(list.code).toBe(0);
    expect(list.json()).not.toContainEqual(expect.objectContaining({ slug }));
  }, 240_000);
});
