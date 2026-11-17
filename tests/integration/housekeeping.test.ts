import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("housekeeping (real Kuma)", () => {
  let sb: Sandbox;
  let pushId = 0;
  let pushUrl = "";

  const pushBeat = async (down = false) => {
    const url = down ? pushUrl.replace("status=up", "status=down") : pushUrl;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBe(200);
  };

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("database size prints a positive byte size", async () => {
    const r = await cliRun(sb, ["database", "size"]);
    expect(r.code).toBe(0);
    expect(r.json().sizeBytes).toBeGreaterThan(0);
  }, 120_000);

  test("database shrink --yes succeeds", async () => {
    const r = await cliRun(sb, ["database", "shrink", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ shrunk: true });
  }, 120_000);

  test("add and resume a push monitor", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-housekeeping",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    pushId = out.id;
    pushUrl = out.pushUrl;

    const resumed = await cliRun(sb, ["monitors", "resume", String(pushId)]);
    expect(resumed.code).toBe(0);
  }, 180_000);

  test("clear-beats deletes the monitor's beats", async () => {
    await pushBeat();
    await pushBeat(true);
    const before = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(before.code).toBe(0);
    expect(before.json().length).toBeGreaterThan(0);

    const r = await cliRun(sb, ["monitors", "clear-beats", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, cleared: "beats" });

    const after = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(after.code).toBe(0);
    expect(after.json()).toEqual([]);
  }, 180_000);

  test("clear-events keeps the beats but empties events", async () => {
    await pushBeat();
    await pushBeat(true);
    const eventsBefore = await cliRun(sb, ["events", String(pushId), "--hours", "1"]);
    expect(eventsBefore.code).toBe(0);
    expect(eventsBefore.json().length).toBeGreaterThan(0);

    const r = await cliRun(sb, ["monitors", "clear-events", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, cleared: "events" });

    const eventsAfter = await cliRun(sb, ["events", String(pushId), "--hours", "1"]);
    expect(eventsAfter.code).toBe(0);
    expect(eventsAfter.json()).toEqual([]);

    const beatsAfter = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(beatsAfter.code).toBe(0);
    expect(beatsAfter.json().length).toBeGreaterThan(0);
    expect(beatsAfter.json().every((b: any) => b.msg === "")).toBe(true);
  }, 180_000);

  test("clear-statistics wipes every monitor's beats", async () => {
    await pushBeat();
    const before = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(before.code).toBe(0);
    expect(before.json().length).toBeGreaterThan(0);

    const r = await cliRun(sb, ["clear-statistics", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ cleared: "statistics" });

    const after = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(after.code).toBe(0);
    expect(after.json()).toEqual([]);
  }, 180_000);

  test("delete --yes removes the push monitor", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, deleted: true });
  }, 120_000);
});
