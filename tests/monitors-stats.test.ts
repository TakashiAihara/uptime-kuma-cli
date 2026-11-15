import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { beat, type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

const mon = (id: number, name: string) => ({
  id,
  name,
  type: "http",
  active: true,
  url: "https://x",
  notificationIDList: {},
});

// monitor_tls_info.info_json is the JSON.stringify of checkCertificate's
// result; the CLI reads certInfo.validTo and certInfo.daysRemaining
const certJson = (validTo: string, daysRemaining: number) =>
  JSON.stringify({ valid: true, certInfo: { validTo, daysRemaining } });

const CERT_1 = certJson("2027-01-02T03:04:05.000Z", 47);
const CERT_2 = certJson("2027-02-03T04:05:06.000Z", 33);
const CERT_4 = certJson("2027-03-04T05:06:07.000Z", 12);

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [mon(1, "alpha"), mon(2, "beta"), mon(3, "gamma"), mon(4, "delta")],
    beats: {
      // the 30h-old beat counts only in the 30d window: uptime24h 0.75 vs uptime30d 0.8
      1: [beat(1, 60 * 30, 1), beat(1, 20, 1), beat(1, 15, 0), beat(1, 10, 1), beat(1, 5, 1)],
      3: [beat(3, 5, 1), beat(3, 10, 0)],
      4: [beat(4, 5, 1)],
    },
    stats: {
      1: { certInfo: CERT_1 },
      2: { certInfo: CERT_2 },
      4: { certInfo: CERT_4 },
    },
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("monitors stats", () => {
  test("prints every monitor's stats in monitorList order", async () => {
    const r = await run(sb, ["monitors", "stats"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      {
        id: 1,
        name: "alpha",
        uptime24h: 0.75,
        uptime30d: 0.8,
        avgPing: 12,
        certExpiresAt: "2027-01-02T03:04:05.000Z",
        certDaysRemaining: 47,
      },
      {
        id: 2,
        name: "beta",
        uptime24h: 0,
        uptime30d: 0,
        avgPing: null,
        certExpiresAt: "2027-02-03T04:05:06.000Z",
        certDaysRemaining: 33,
      },
      {
        id: 3,
        name: "gamma",
        uptime24h: 0.5,
        uptime30d: 0.5,
        avgPing: 12,
        certExpiresAt: null,
        certDaysRemaining: null,
      },
      {
        id: 4,
        name: "delta",
        uptime24h: 1,
        uptime30d: 1,
        avgPing: 12,
        certExpiresAt: "2027-03-04T05:06:07.000Z",
        certDaysRemaining: 12,
      },
    ]);
  });

  test("one id prints a single object and keeps a middle monitor's certInfo", async () => {
    const r = await run(sb, ["monitors", "stats", "2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(Array.isArray(out)).toBe(false);
    expect(out).toEqual({
      id: 2,
      name: "beta",
      uptime24h: 0,
      uptime30d: 0,
      avgPing: null,
      certExpiresAt: "2027-02-03T04:05:06.000Z",
      certDaysRemaining: 33,
    });
  });

  test("a monitor without certInfo reports null cert fields", async () => {
    const r = await run(sb, ["monitors", "stats", "3"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 3,
      name: "gamma",
      uptime24h: 0.5,
      uptime30d: 0.5,
      avgPing: 12,
      certExpiresAt: null,
      certDaysRemaining: null,
    });
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "stats", "99"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 99 not found");
  });

  test("a monitor whose stats never arrive exits 2 naming it", async () => {
    kuma.state.silentStats = [3];
    const r = await run(sb, ["monitors", "stats"], {
      ...creds(kuma.url),
      UPTIME_KUMA_TIMEOUT: "1",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("3 (gamma)");
    expect(r.stderr).not.toContain("1 (alpha)");
  });

  test.each(["avgPing", "uptime24", "uptime720"])(
    "a monitor missing only its %s exits 2 naming it",
    async (event) => {
      kuma.state.skipStatEvents = { 3: [event] };
      const r = await run(sb, ["monitors", "stats"], {
        ...creds(kuma.url),
        UPTIME_KUMA_TIMEOUT: "1",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("3 (gamma)");
    },
  );

  test("the last monitor's certInfo inside the grace is kept", async () => {
    kuma.state.certInfoDelay = { 4: 100 };
    const r = await run(sb, ["monitors", "stats", "4"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      id: 4,
      certExpiresAt: "2027-03-04T05:06:07.000Z",
      certDaysRemaining: 12,
    });
  });

  test("the last monitor's certInfo past the grace is absent", async () => {
    kuma.state.certInfoDelay = { 4: 600 };
    const r = await run(sb, ["monitors", "stats", "4"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      id: 4,
      certExpiresAt: null,
      certDaysRemaining: null,
    });
  });

  test("an unreadable validTo and a non-number daysRemaining give nulls", async () => {
    kuma.state.stats[1] = {
      certInfo: JSON.stringify({ valid: true, certInfo: { validTo: "soon", daysRemaining: "12" } }),
    };
    const r = await run(sb, ["monitors", "stats", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ id: 1, certExpiresAt: null, certDaysRemaining: null });
  });

  test("an avgPing that is not a number reads as null", async () => {
    kuma.state.stats[1] = { avgPing: "NaN" as unknown as number };
    const r = await run(sb, ["monitors", "stats", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().avgPing).toBeNull();
  });

  test("a malformed info_json gives null cert fields, not a crash", async () => {
    kuma.state.stats[1] = { certInfo: "{not json" };
    const r = await run(sb, ["monitors", "stats", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 1,
      name: "alpha",
      uptime24h: 0.75,
      uptime30d: 0.8,
      avgPing: 12,
      certExpiresAt: null,
      certDaysRemaining: null,
    });
  });

  test("a later stats re-emission does not replace the first values", async () => {
    kuma.state.resendStats = {
      1: {
        avgPing: 99,
        uptime24h: 0.11,
        uptime30d: 0.22,
        certInfo: certJson("2030-01-01T00:00:00.000Z", 5),
      },
    };
    const r = await run(sb, ["monitors", "stats"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()[0]).toEqual({
      id: 1,
      name: "alpha",
      uptime24h: 0.75,
      uptime30d: 0.8,
      avgPing: 12,
      certExpiresAt: "2027-01-02T03:04:05.000Z",
      certDaysRemaining: 47,
    });
  });
});
