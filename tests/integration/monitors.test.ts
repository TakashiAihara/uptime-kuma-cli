import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("monitors (real Kuma)", () => {
  let sb: Sandbox;
  let pushId = 0;
  let pushToken = "";
  let httpId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add --type push --paused prints pushToken and pushUrl", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-push",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-push", type: "push", active: false });
    expect(out.id).toBeGreaterThan(0);
    expect(out.pushToken).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(out.pushUrl).toContain(`/api/push/${out.pushToken}?status=up&msg=OK&ping=`);
    pushId = out.id;
    pushToken = out.pushToken;
  }, 120_000);

  test("add --type http --paused creates a paused http monitor", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "http",
      "--name",
      "it-http",
      "--url",
      "http://localhost:3001",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-http", type: "http", active: false });
    httpId = out.id;
  }, 120_000);

  test("add with the same name exits 3 without creating a second monitor", async () => {
    const r = await cliRun(sb, ["monitors", "add", "--type", "push", "--name", "it-push"]);
    expect(r.code).toBe(3);
    expect(r.json()).toEqual({ id: pushId, name: "it-push", skipped: true });
  }, 120_000);

  test("list --name it- shows the monitors created above", async () => {
    const r = await cliRun(sb, ["monitors", "list", "--name", "it-"]);
    expect(r.code).toBe(0);
    const names = r.json().map((m: any) => m.name);
    expect(names).toEqual(expect.arrayContaining(["it-push", "it-http"]));
  }, 120_000);

  test("get returns the push monitor with its stored pushToken", async () => {
    const r = await cliRun(sb, ["monitors", "get", String(pushId)]);
    expect(r.code).toBe(0);
    const m = r.json();
    expect(m.id).toBe(pushId);
    expect(m.name).toBe("it-push");
    expect(m.type).toBe("push");
    expect(m.pushToken).toBe(pushToken);
  }, 120_000);

  test("edit --set maxretries=2 is saved", async () => {
    const r = await cliRun(sb, ["monitors", "edit", String(pushId), "--set", "maxretries=2"]);
    expect(r.code).toBe(0);
    expect(r.json().maxretries).toBe(2);
  }, 120_000);

  test("get shows the edited maxretries", async () => {
    const r = await cliRun(sb, ["monitors", "get", String(pushId)]);
    expect(r.code).toBe(0);
    expect(r.json().maxretries).toBe(2);
  }, 120_000);

  test("resume then pause the push monitor", async () => {
    const resumed = await cliRun(sb, ["monitors", "resume", String(pushId)]);
    expect(resumed.code).toBe(0);
    expect(resumed.json()).toEqual({ id: pushId, active: true });
    const paused = await cliRun(sb, ["monitors", "pause", String(pushId)]);
    expect(paused.code).toBe(0);
    expect(paused.json()).toEqual({ id: pushId, active: false });
  }, 180_000);

  test("delete --yes removes the http monitor and get then exits 1", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(httpId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: httpId, deleted: true });
    const g = await cliRun(sb, ["monitors", "get", String(httpId)]);
    expect(g.code).toBe(1);
  }, 180_000);

  test("delete --yes removes the push monitor", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, deleted: true });
  }, 120_000);
});
