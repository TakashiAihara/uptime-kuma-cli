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

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [mon(1, "web"), mon(2, "db")],
    beats: {
      1: [beat(1, 30, 1), beat(1, 10, 0, 1, "down")],
      2: [beat(2, 5, 1)],
    },
    databaseSize: 987654,
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("clear-statistics", () => {
  test("deletes every monitor's beats and prints { cleared: 'statistics' }", async () => {
    const r = await run(sb, ["clear-statistics", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ cleared: "statistics" });
    expect(kuma.calls.find((c) => c.event === "clearStatistics")!.args).toEqual([]);
    expect(kuma.state.beats).toEqual({});
  });

  test("without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["clear-statistics"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would clear statistics of every monitor");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.clearStatistics = "cannot clear";
    const r = await run(sb, ["clear-statistics", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot clear");
    expect(kuma.state.beats[1]).toHaveLength(2);
  });
});

describe("database size", () => {
  test("prints the database file size in bytes", async () => {
    const r = await run(sb, ["database", "size"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ sizeBytes: 987654 });
    expect(kuma.calls.find((c) => c.event === "getDatabaseSize")!.args).toEqual([]);
  });

  test("an answer without a numeric size exits 70", async () => {
    kuma.state.databaseSizeResult = { ok: true };
    const r = await run(sb, ["database", "size"], creds(kuma.url));
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected getDatabaseSize response");
  });

  test("Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.getDatabaseSize = "no database";
    const r = await run(sb, ["database", "size"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no database");
  });
});

describe("database shrink", () => {
  test("on 1.x prints { started: true } — Kuma acks before VACUUM finishes", async () => {
    const r = await run(sb, ["database", "shrink", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ started: true });
    expect(kuma.calls.find((c) => c.event === "shrinkDatabase")!.args).toEqual([]);
  });

  test("on 2.x prints { shrunk: true } — the ack follows the awaited VACUUM", async () => {
    const k2 = await startFakeKuma({ profile: "2.x" });
    try {
      const r = await run(sb, ["database", "shrink", "--yes"], creds(k2.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ shrunk: true });
      expect(k2.calls.find((c) => c.event === "shrinkDatabase")!.args).toEqual([]);
    } finally {
      await k2.close();
    }
  });

  test("without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["database", "shrink"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would shrink the database");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.shrinkDatabase = "cannot shrink";
    const r = await run(sb, ["database", "shrink", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot shrink");
  });

  test("the ack wait outlives UPTIME_KUMA_TIMEOUT for a slow VACUUM", async () => {
    // a slow ack is a 2.x shape: 1.23.17 answers before VACUUM finishes
    const k2 = await startFakeKuma({ profile: "2.x" });
    try {
      k2.state.ackDelay.shrinkDatabase = 3500;
      const r = await run(sb, ["database", "shrink", "--yes"], creds(k2.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ shrunk: true });
    } finally {
      await k2.close();
    }
  }, 15_000);

  test("UPTIME_KUMA_SHRINK_TIMEOUT bounds the ack wait", async () => {
    const k2 = await startFakeKuma({ profile: "2.x" });
    try {
      k2.state.ackDelay.shrinkDatabase = 3500;
      const r = await run(sb, ["database", "shrink", "--yes"], {
        ...creds(k2.url),
        UPTIME_KUMA_SHRINK_TIMEOUT: "2",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timed out during shrinkDatabase");
    } finally {
      await k2.close();
    }
  }, 15_000);

  test("an invalid UPTIME_KUMA_SHRINK_TIMEOUT exits 2 before connecting", async () => {
    const r = await run(sb, ["database", "shrink", "--yes"], {
      ...creds(kuma.url),
      UPTIME_KUMA_SHRINK_TIMEOUT: "abc",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("UPTIME_KUMA_SHRINK_TIMEOUT");
    expect(kuma.calls).toHaveLength(0);
  });
});

describe("database commands on a non-sqlite 2.x backend", () => {
  const mariadb = async () => {
    const k2 = await startFakeKuma({ profile: "2.x" });
    k2.state.info = { ...k2.state.info, dbType: "mariadb" };
    return k2;
  };

  test("database size exits 2 naming the backend, without requesting", async () => {
    const k2 = await mariadb();
    try {
      const r = await run(sb, ["database", "size"], creds(k2.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"database size" needs a sqlite database');
      expect(r.stderr).toContain('"mariadb"');
      expect(k2.calls.find((c) => c.event === "getDatabaseSize")).toBeUndefined();
    } finally {
      await k2.close();
    }
  });

  test("database shrink exits 2 naming the backend, without requesting", async () => {
    const k2 = await mariadb();
    try {
      const r = await run(sb, ["database", "shrink", "--yes"], creds(k2.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"database shrink" needs a sqlite database');
      expect(r.stderr).toContain('"mariadb"');
      expect(k2.calls.find((c) => c.event === "shrinkDatabase")).toBeUndefined();
    } finally {
      await k2.close();
    }
  });

  test("a sqlite 2.x backend still answers database size", async () => {
    const k2 = await startFakeKuma({ profile: "2.x" });
    try {
      const r = await run(sb, ["database", "size"], creds(k2.url));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ sizeBytes: 1048576 });
    } finally {
      await k2.close();
    }
  });
});
