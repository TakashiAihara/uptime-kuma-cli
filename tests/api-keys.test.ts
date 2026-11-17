import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

beforeEach(async () => {
  sb = sandbox();
  // out of id order on purpose: list must sort; expires is the stored
  // "yyyy-MM-dd HH:mm:ss" spelling, active the BOOLEAN column's 0/1
  kuma = await startFakeKuma({
    apiKeys: [
      { id: 3, name: "paused", active: 0, expires: "2030-01-01 00:00:00" },
      { id: 1, name: "deploy", active: 1, expires: null },
      { id: 2, name: "ci-expired", active: 1, expires: "2020-01-01 00:00:00" },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

// a local ISO datetime one year out, so --expires never hits the
// before-today refusal however old the checkout is
const futureLocal = (): { date: string; hm: string } => {
  const d = new Date(Date.now() + 365 * 86400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hm: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
};

describe("api-keys list", () => {
  test("prints the public rows sorted by id, without the stored secret", async () => {
    const r = await run(sb, ["api-keys", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      { id: 1, name: "deploy", expires: null, active: true, status: "active" },
      {
        id: 2,
        name: "ci-expired",
        expires: "2020-01-01 00:00:00",
        active: true,
        status: "expired",
      },
      {
        id: 3,
        name: "paused",
        expires: "2030-01-01 00:00:00",
        active: false,
        status: "inactive",
      },
    ]);
  });

  test("prints an empty array when Kuma has no keys", async () => {
    kuma.state.apiKeys = [];
    const r = await run(sb, ["api-keys", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([]);
  });

  test("times out when the server never pushes apiKeyList", async () => {
    kuma.state.skipLists = ["apiKeyList"];
    const r = await run(sb, ["api-keys", "list"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("timed out waiting for pushed lists");
    expect(r.stderr).toContain("apiKeyList");
  });
});

describe("api-keys add", () => {
  test("sends the UI payload and prints the one-time clear key", async () => {
    const r = await run(sb, ["api-keys", "add", "--name", "ci deploy"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.id).toBe(4);
    expect(out.name).toBe("ci deploy");
    expect(out.expires).toBeNull();
    expect(out.active).toBe(true);
    expect(out.key).toMatch(/^uk4_[A-Za-z0-9_-]{40}$/);
    // the clear key prints on stdout exactly once and never on stderr
    expect(r.stdout.split(String(out.key))).toHaveLength(2);
    expect(r.stderr).not.toContain(String(out.key));
    expect(r.stderr).toContain("only once");
    expect(kuma.calls.find((c) => c.event === "addAPIKey")!.args).toEqual([
      { name: "ci deploy", expires: null, active: 1 },
    ]);
    const stored = kuma.state.apiKeys.find((k) => k.id === 4)!;
    expect(stored.name).toBe("ci deploy");
    expect(stored.active).toBe(1);
    // the row keeps the hash stand-in, never the clear key
    expect(stored.key).toBe(`hash:${String(out.key).slice(4)}`);
    // and a later list still cannot show it
    const l = await run(sb, ["api-keys", "list"], creds(kuma.url));
    expect(l.json()).toContainEqual({
      id: 4,
      name: "ci deploy",
      expires: null,
      active: true,
      status: "active",
    });
  });

  test("add does not wait for the apiKeyList push", async () => {
    kuma.state.skipLists = ["apiKeyList"];
    const r = await run(sb, ["api-keys", "add", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().id).toBe(4);
  });

  test("add --expires sends the datepicker's space-separated spelling", async () => {
    const { date, hm } = futureLocal();
    const r = await run(
      sb,
      ["api-keys", "add", "--name", "metrics", "--expires", `${date}T${hm}`],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().expires).toBe(`${date} ${hm}:00`);
    expect(kuma.calls.find((c) => c.event === "addAPIKey")!.args).toEqual([
      { name: "metrics", expires: `${date} ${hm}:00`, active: 1 },
    ]);
  });

  test("add --expires keeps seconds", async () => {
    const { date, hm } = futureLocal();
    const r = await run(
      sb,
      ["api-keys", "add", "--name", "metrics", "--expires", `${date}T${hm}:05`],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().expires).toBe(`${date} ${hm}:05`);
  });

  test("add --expires with fractional seconds exits 2 before connecting", async () => {
    const { date, hm } = futureLocal();
    const r = await run(
      sb,
      ["api-keys", "add", "--name", "x", "--expires", `${date}T${hm}:05.250`],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("fractional seconds");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add --expires today is accepted, the datepicker's minDate boundary", async () => {
    // run() wipes the environment, so the CLI's localToday() falls back to
    // the OS zone; pin both sides to UTC or the dates can differ by a day
    const today = new Date().toISOString().slice(0, 10);
    const r = await run(sb, ["api-keys", "add", "--name", "x", "--expires", `${today}T23:59`], {
      ...creds(kuma.url),
      TZ: "UTC",
    });
    expect(r.code).toBe(0);
    expect(r.json().expires).toBe(`${today} 23:59:00`);
  });

  test("add --expires before today exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["api-keys", "add", "--name", "x", "--expires", "2020-06-15T10:00"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--expires");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([
    "not-a-date",
    "2027-02-31T10:00",
    "2027-13-40T99:99",
    "2027-01-15 09:30",
    "2027-01-15T09:30:00Z",
    "2027-01-15T09:30:00+09:00",
  ])("add rejects --expires %p with exit 2 before connecting", async (expires) => {
    const r = await run(
      sb,
      ["api-keys", "add", "--name", "x", "--expires", expires],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--expires");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add without --name exits 2 before connecting", async () => {
    const r = await run(sb, ["api-keys", "add"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("add with an empty --name exits 2 before connecting", async () => {
    const r = await run(sb, ["api-keys", "add", "--name", ""], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.addAPIKey = "cannot create key";
    const r = await run(sb, ["api-keys", "add", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot create key");
    expect(kuma.state.apiKeys).toHaveLength(3);
  });

  test("add: an addAPIKey answer without key/keyID exits 70", async () => {
    kuma.state.addAPIKeyResult = { ok: true, msg: "Added Successfully." };
    const r = await run(sb, ["api-keys", "add", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected addAPIKey response");
  });
});

describe("api-keys enable / disable", () => {
  test("enable sends enableAPIKey and prints { id, active: true }", async () => {
    const r = await run(sb, ["api-keys", "enable", "3"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, active: true });
    expect(kuma.calls.find((c) => c.event === "enableAPIKey")!.args).toEqual([3]);
    expect(kuma.state.apiKeys.find((k) => k.id === 3)!.active).toBe(1);
  });

  test("disable sends disableAPIKey and prints { id, active: false }", async () => {
    const r = await run(sb, ["api-keys", "disable", "1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, active: false });
    expect(kuma.calls.find((c) => c.event === "disableAPIKey")!.args).toEqual([1]);
    expect(kuma.state.apiKeys.find((k) => k.id === 1)!.active).toBe(0);
  });

  test.each([
    ["enable", "enableAPIKey"],
    ["disable", "disableAPIKey"],
  ])("%s of an unknown id exits 1 without sending %s", async (cmd, event) => {
    const r = await run(sb, ["api-keys", cmd, "9"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api key 9 not found");
    expect(kuma.calls.find((c) => c.event === event)).toBeUndefined();
  });

  test.each(["enable", "disable"])(
    "%s with an invalid id exits 2 before connecting",
    async (cmd) => {
      const r = await run(sb, ["api-keys", cmd, "abc"], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("positive integer");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("enable: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.enableAPIKey = "cannot enable";
    const r = await run(sb, ["api-keys", "enable", "1"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot enable");
  });
});

describe("api-keys delete", () => {
  test("delete --yes removes the key and prints { id, deleted: true }", async () => {
    const r = await run(sb, ["api-keys", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2, deleted: true });
    expect(kuma.calls.find((c) => c.event === "deleteAPIKey")!.args).toEqual([2]);
    expect(kuma.state.apiKeys.map((k) => k.id).sort()).toEqual([1, 3]);
  });

  test("delete without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["api-keys", "delete", "2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would delete api key 2");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["api-keys", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete of an unknown id exits 1 without sending deleteAPIKey", async () => {
    const r = await run(sb, ["api-keys", "delete", "9", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api key 9 not found");
    expect(kuma.calls.find((c) => c.event === "deleteAPIKey")).toBeUndefined();
    expect(kuma.state.apiKeys).toHaveLength(3);
  });

  test("delete: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.deleteAPIKey = "cannot delete";
    const r = await run(sb, ["api-keys", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot delete");
    expect(kuma.state.apiKeys).toHaveLength(3);
  });
});
