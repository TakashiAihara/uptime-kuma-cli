import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { beat, type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

const mon = (id: number, name: string, active = true) => ({
  id,
  name,
  type: "http",
  active,
  url: "https://x",
  notificationIDList: {},
});

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [mon(3, "web"), mon(1, "db"), mon(5, "idle", false)],
    beats: {
      1: [
        beat(1, 60 * 30, 1, 1, "first up"),
        beat(1, 120, 0, 1, "timeout"),
        beat(1, 90, 0, 0, "timeout"),
        beat(1, 60, 1, 1, "back"),
        beat(1, 30, 1, 0, "ok-30"),
        beat(1, 10, 1, 0, "ok-10"),
      ],
      3: [beat(3, 5, 0, 1, "down now")],
    },
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("beats <id>", () => {
  test("defaults to 24 hours, newest first, in the documented shape", async () => {
    const r = await run(sb, ["beats", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.map((b: any) => b.msg)).toEqual(["ok-10", "ok-30", "back", "timeout", "timeout"]);
    expect(Object.keys(out[0]).sort()).toEqual(["important", "msg", "ping", "status", "time"]);
    const call = kuma.calls.find((c) => c.event === "getMonitorBeats")!;
    expect(call.args).toEqual([1, 24]);
  });

  test("--hours widens the window", async () => {
    const r = await run(sb, ["beats", "1", "--hours", "48"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toHaveLength(6);
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")!.args).toEqual([1, 48]);
  });

  test("--limit keeps the newest n", async () => {
    const r = await run(sb, ["beats", "1", "--limit", "2"], creds(kuma.url));
    expect(r.json().map((b: any) => b.msg)).toEqual(["ok-10", "ok-30"]);
  });

  test("--important keeps only status changes", async () => {
    const r = await run(sb, ["beats", "1", "--important"], creds(kuma.url));
    expect(r.json().map((b: any) => b.msg)).toEqual(["back", "timeout"]);
  });

  test("Kuma's refusal exits 1", async () => {
    kuma.state.fail.getMonitorBeats = "Invalid period.";
    const r = await run(sb, ["beats", "1"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid period.");
  });

  test("resolves a monitor name to its id", async () => {
    const r = await run(sb, ["beats", "web"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")!.args).toEqual([3, 24]);
  });

  test("an unknown monitor name exits 2", async () => {
    const r = await run(sb, ["beats", "No Such"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no monitor named "No Such"');
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")).toBeUndefined();
  });
});

describe("beats / events option checks", () => {
  test.each([
    [["beats", "1", "--hours", "-1"], "--hours"],
    [["beats", "1", "--hours", "0"], "--hours"],
    [["beats", "1", "--hours", "1e2"], "--hours"],
    [["beats", "1", "--limit", "0"], "--limit"],
    [["beats", "1", "--limit", "1.5"], "--limit"],
    [["beats", "1", "--limit", "0x10"], "--limit"],
    [["events", "1", "--hours", "-5"], "--hours"],
  ])("%p exits 2 before connecting", async (args, word) => {
    const r = await run(sb, args, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(word);
    expect(kuma.calls).toHaveLength(0);
  });
});

describe("beats latest", () => {
  test("lists each monitor's newest beat sorted by id, null when there is none", async () => {
    const r = await run(sb, ["beats", "latest"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.map((x: any) => x.id)).toEqual([1, 3, 5]);
    expect(out[0]).toMatchObject({ id: 1, name: "db", active: true, status: 1, msg: "ok-10" });
    expect(out[1]).toMatchObject({ id: 3, name: "web", status: 0, msg: "down now" });
    expect(out[2]).toEqual({
      id: 5,
      name: "idle",
      active: false,
      time: null,
      status: null,
      msg: null,
    });
  });

  test("a monitor whose heartbeatList never arrives exits 2 naming it", async () => {
    kuma.state.silentHeartbeat = [3];
    const r = await run(sb, ["beats", "latest"], { ...creds(kuma.url), UPTIME_KUMA_TIMEOUT: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("3 (web)");
    expect(r.stderr).not.toContain("1 (db)");
  });

  test("a monitor named latest stays unreachable by name — the subcommand wins", async () => {
    kuma.state.monitors.push(mon(7, "latest"));
    const r = await run(sb, ["beats", "latest"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().map((x: any) => x.id)).toContain(7);
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")).toBeUndefined();
  });
});

describe("events", () => {
  test("lists status changes newest first over 168 hours by default", async () => {
    const r = await run(sb, ["events", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().map((e: any) => e.msg)).toEqual(["back", "timeout", "first up"]);
    expect(Object.keys(r.json()[0]).sort()).toEqual(["msg", "status", "time"]);
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")!.args).toEqual([1, 168]);
  });

  test("--by-day counts downs and ups per UTC day", async () => {
    kuma.state.beats[2] = [
      { ...beat(2, 0, 0, 1), time: "2026-10-14 23:59:00" },
      { ...beat(2, 0, 1, 1), time: "2026-10-15 00:01:00" },
      { ...beat(2, 0, 0, 1), time: "2026-10-15 03:00:00" },
      { ...beat(2, 0, 0, 0), time: "2026-10-15 03:01:00" },
      { ...beat(2, 0, 2, 1), time: "2026-10-15 04:00:00" },
      { ...beat(2, 0, 1, 1), time: "2026-10-16 09:00:00" },
    ];
    kuma.state.monitors.push(mon(2, "old"));
    const r = await run(sb, ["events", "2", "--hours", "100000", "--by-day"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      { date: "2026-10-14", down: 1, up: 0 },
      { date: "2026-10-15", down: 1, up: 1 },
      { date: "2026-10-16", down: 0, up: 1 },
    ]);
  });

  test("resolves a monitor name to its id", async () => {
    const r = await run(sb, ["events", "db"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(kuma.calls.find((c) => c.event === "getMonitorBeats")!.args).toEqual([1, 168]);
  });
});
