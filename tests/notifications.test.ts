import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

const SECRET = "ntfy-secret-value-xyz";

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    notifications: [
      {
        id: 3,
        name: "ntfy home",
        active: true,
        isDefault: true,
        userId: 1,
        config: JSON.stringify({
          name: "ntfy home",
          type: "ntfy",
          isDefault: true,
          ntfyserverurl: "https://ntfy.example.com",
          ntfytopic: "home",
          ntfyPassword: SECRET,
        }),
      },
      {
        id: 1,
        name: "matrix",
        active: false,
        isDefault: false,
        userId: 1,
        config: JSON.stringify({ name: "matrix", type: "matrix", accessToken: SECRET }),
      },
    ],
    proxies: [
      {
        id: 2,
        user_id: 1,
        protocol: "socks5",
        host: "10.0.0.9",
        port: 1080,
        auth: true,
        username: "u1",
        password: SECRET,
        active: true,
        default: false,
        created_date: "2026-10-29 00:00:00",
      },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("notifications", () => {
  test("list prints id/name/type/active/isDefault sorted by id and never the config", async () => {
    const r = await run(sb, ["notifications", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      { id: 1, name: "matrix", type: "matrix", active: false, isDefault: false },
      { id: 3, name: "ntfy home", type: "ntfy", active: true, isDefault: true },
    ]);
    expect(r.stdout).not.toContain(SECRET);
  });

  test("add builds the object from flags, --config-file and --set", async () => {
    const f = join(sb.dir, "cfg.json");
    writeFileSync(f, JSON.stringify({ ntfyPassword: "from-file", ntfypriority: 3 }));
    const r = await run(
      sb,
      [
        "notifications",
        "add",
        "--name",
        "ntfy alt",
        "--type",
        "ntfy",
        "--config-file",
        f,
        "--set",
        "ntfytopic=alt",
        "--set",
        "ntfypriority=5",
        "--default",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 4, name: "ntfy alt", type: "ntfy" });
    const call = kuma.calls.find((c) => c.event === "addNotification")!;
    expect(call.args[1]).toBeNull();
    expect(call.args[0]).toEqual({
      name: "ntfy alt",
      type: "ntfy",
      isDefault: true,
      applyExisting: false,
      ntfyPassword: "from-file",
      ntfypriority: 5,
      ntfytopic: "alt",
    });
    expect(r.stdout).not.toContain("from-file");
  });

  test("add --apply-existing sends applyExisting true", async () => {
    const r = await run(
      sb,
      ["notifications", "add", "--name", "x", "--type", "webhook", "--apply-existing"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(
      (kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any).applyExisting,
    ).toBe(true);
  });

  test("add: explicit flags win over --config-file and --set", async () => {
    const f = join(sb.dir, "cfg2.json");
    writeFileSync(f, JSON.stringify({ name: "from-file", type: "slack", isDefault: false }));
    const r = await run(
      sb,
      [
        "notifications",
        "add",
        "--name",
        "flag-name",
        "--type",
        "ntfy",
        "--default",
        "--config-file",
        f,
        "--set",
        "type=matrix",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any;
    expect(sent.name).toBe("flag-name");
    expect(sent.type).toBe("ntfy");
    expect(sent.isDefault).toBe(true);
  });

  test("add: without the flags, isDefault and applyExisting from --config-file are kept", async () => {
    const f = join(sb.dir, "cfg3.json");
    writeFileSync(f, JSON.stringify({ isDefault: true, applyExisting: true }));
    const r = await run(
      sb,
      ["notifications", "add", "--name", "n", "--type", "ntfy", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any;
    expect(sent.isDefault).toBe(true);
    expect(sent.applyExisting).toBe(true);
  });

  test("add: without flags or config, isDefault and applyExisting are false", async () => {
    const r = await run(
      sb,
      ["notifications", "add", "--name", "n0", "--type", "ntfy"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any;
    expect(sent.isDefault).toBe(false);
    expect(sent.applyExisting).toBe(false);
  });

  test("edit refuses applyExisting in --config-file before connecting", async () => {
    const f = join(sb.dir, "cfg-apply.json");
    writeFileSync(f, JSON.stringify({ applyExisting: true }));
    const r = await run(sb, ["notifications", "edit", "3", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("applyExisting");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit refuses --set applyExisting before connecting", async () => {
    const r = await run(
      sb,
      ["notifications", "edit", "3", "--set", "applyExisting=true"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("applyExisting");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit does not re-send a stored applyExisting", async () => {
    const row = kuma.state.notifications.find((n) => n.id === 1)!;
    row.config = JSON.stringify({ ...JSON.parse(row.config), applyExisting: true });
    const r = await run(sb, ["notifications", "edit", "1", "--set", "x=1"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any;
    expect(sent.applyExisting).toBe(false);
  });

  test("edit merges into the stored config and keeps untouched secrets", async () => {
    const r = await run(
      sb,
      ["notifications", "edit", "3", "--set", "ntfytopic=home2"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, name: "ntfy home", type: "ntfy" });
    const call = kuma.calls.find((c) => c.event === "addNotification")!;
    expect(call.args[1]).toBe(3);
    expect(call.args[0]).toMatchObject({
      ntfytopic: "home2",
      ntfyPassword: SECRET,
      ntfyserverurl: "https://ntfy.example.com",
      type: "ntfy",
    });
    expect(r.stdout).not.toContain(SECRET);
  });

  test("edit without --set or --config-file exits 2 before connecting", async () => {
    const r = await run(sb, ["notifications", "edit", "3"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit of an unknown id exits 1 without sending", async () => {
    const r = await run(sb, ["notifications", "edit", "99", "--set", "a=b"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(kuma.calls.find((c) => c.event === "addNotification")).toBeUndefined();
  });

  test("test sends the stored config and prints Kuma's message", async () => {
    const r = await run(sb, ["notifications", "test", "3"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, ok: true, msg: "Sent Successfully." });
    expect((kuma.calls.find((c) => c.event === "testNotification")!.args[0] as any).ntfytopic).toBe(
      "home",
    );
  });

  test("a failed test exits 1 with Kuma's message", async () => {
    kuma.state.testNotificationResult = { ok: false, msg: "Error: 401 Unauthorized" };
    const r = await run(sb, ["notifications", "test", "3"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("401 Unauthorized");
  });

  test("delete removes the row and prints { id, deleted: true }", async () => {
    const r = await run(sb, ["notifications", "delete", "3", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, deleted: true });
    expect(kuma.state.notifications.map((n) => n.id)).toEqual([1]);
    expect(kuma.calls.find((c) => c.event === "deleteNotification")!.args).toEqual([3]);
  });

  test("delete without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["notifications", "delete", "3"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would delete notification 3");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["notifications", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an unknown id exits 1 with Kuma's 'notification not found'", async () => {
    const r = await run(sb, ["notifications", "delete", "99", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("notification not found");
    expect(kuma.state.notifications.map((n) => n.id).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  test("delete: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.deleteNotification = "cannot delete";
    const r = await run(sb, ["notifications", "delete", "3", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot delete");
    expect(kuma.state.notifications.map((n) => n.id).sort((a, b) => a - b)).toEqual([1, 3]);
  });
});
