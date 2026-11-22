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
        auth: 1,
        username: "u1",
        password: SECRET,
        active: 1,
        default: 0,
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

  test("get prints the stored config with secrets redacted", async () => {
    const r = await run(sb, ["notifications", "get", "3"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 3,
      active: true,
      name: "ntfy home",
      type: "ntfy",
      isDefault: true,
      ntfyserverurl: "https://ntfy.example.com",
      ntfytopic: "home",
      ntfyPassword: "***",
    });
    expect(r.stdout).not.toContain(SECRET);
  });

  test("get resolves a notification name to its id", async () => {
    const r = await run(sb, ["notifications", "get", "matrix"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 1,
      active: false,
      isDefault: false,
      name: "matrix",
      type: "matrix",
      accessToken: "***",
    });
    expect(r.stdout).not.toContain(SECRET);
  });

  test("get masks url userinfo, header blocks, bodies and credential urls", async () => {
    kuma.state.notifications.push({
      id: 7,
      name: "hooks",
      active: true,
      isDefault: false,
      userId: 1,
      config: JSON.stringify({
        id: 42,
        active: false,
        name: "hooks",
        type: "webhook",
        webhookURL: "https://user:s3cr3t-pw@example.com/hook",
        webhookAdditionalHeaders: '{"Authorization":"Bearer hdr-tok-123"}',
        webhookCustomBody: '{"a":1}',
        discordWebhookUrl: "https://discord.com/api/webhooks/1/dsc-tok-456",
        slackwebhookURL: "https://hooks.slack.com/services/T/B/sl-tok-789",
        gotifyserverurl: "https://gotify.example.com/hook?token=gt-tok-1&foo=bar",
        ntfyIcon: "https://example.com/icon.png",
        pushoverapptoken: "",
        // an add-time flag stored in the config is not printed — edit
        // refuses the key, so a get -> edit round trip must not carry it
        applyExisting: true,
      }),
    });
    const r = await run(sb, ["notifications", "get", "7"], creds(kuma.url));
    expect(r.code).toBe(0);
    // the row's id / active / isDefault win over copies stored inside the config
    expect(r.json()).toEqual({
      id: 7,
      active: true,
      isDefault: false,
      name: "hooks",
      type: "webhook",
      // a webhook url is a bearer credential — it prints "***", not just
      // its userinfo; other urls keep the readable form with userinfo and
      // secret-named query params masked
      webhookURL: "***",
      webhookAdditionalHeaders: "***",
      webhookCustomBody: "***",
      discordWebhookUrl: "***",
      slackwebhookURL: "***",
      gotifyserverurl: "https://gotify.example.com/hook?token=***&foo=bar",
      ntfyIcon: "https://example.com/icon.png",
      pushoverapptoken: "",
    });
    expect(r.stdout).not.toContain("s3cr3t-pw");
    expect(r.stdout).not.toContain("hdr-tok-123");
    expect(r.stdout).not.toContain("dsc-tok-456");
    expect(r.stdout).not.toContain("sl-tok-789");
    expect(r.stdout).not.toContain("gt-tok-1");
    expect(r.json()).not.toHaveProperty("applyExisting");
  });

  test("get masks secret query params even when the url does not parse", async () => {
    kuma.state.notifications.push({
      id: 11,
      name: "badport",
      active: true,
      isDefault: false,
      userId: 1,
      config: JSON.stringify({
        type: "gotify",
        gotifyserverurl: "https://gotify.example.com:bad/?token=gt-tok-2&foo=bar",
      }),
    });
    const r = await run(sb, ["notifications", "get", "11"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().gotifyserverurl).toBe("https://gotify.example.com:bad/?token=***&foo=bar");
    expect(r.stdout).not.toContain("gt-tok-2");
  });

  test("get masks a percent-encoded secret query param name", async () => {
    kuma.state.notifications.push({
      id: 12,
      name: "encoded",
      active: true,
      isDefault: false,
      userId: 1,
      config: JSON.stringify({
        type: "gotify",
        gotifyserverurl: "https://gotify.example.com/?%74oken=enc-tok-3&safe=1",
      }),
    });
    const r = await run(sb, ["notifications", "get", "12"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().gotifyserverurl).toBe("https://gotify.example.com/?%74oken=***&safe=1");
    expect(r.stdout).not.toContain("enc-tok-3");
  });

  test("get masks userinfo in every url of a newline-separated relays list", async () => {
    kuma.state.notifications.push({
      id: 9,
      name: "nostr",
      active: true,
      isDefault: false,
      userId: 1,
      config: JSON.stringify({
        type: "nostr",
        relays: "wss://public.example/\nwss://user:rlay-pw@private.example/\nnot a url",
      }),
    });
    const r = await run(sb, ["notifications", "get", "9"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().relays).toBe("wss://public.example/\nwss://***@private.example/\nnot a url");
    expect(r.stdout).not.toContain("rlay-pw");
  });

  test("get reports the row's isDefault over a divergent copy in the config", async () => {
    kuma.state.notifications.push({
      id: 10,
      name: "diverged",
      active: true,
      isDefault: false,
      userId: 1,
      // the bean column coerces falsy values the stored json keeps verbatim
      config: JSON.stringify({ type: "ntfy", isDefault: null }),
    });
    const r = await run(sb, ["notifications", "get", "10"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().isDefault).toBe(false);
  });

  test("get of an unknown id exits 1", async () => {
    const r = await run(sb, ["notifications", "get", "99"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("notification 99 not found");
  });

  test("get of a row with an unreadable config exits 2", async () => {
    kuma.state.notifications.push({
      id: 8,
      name: "broken",
      active: true,
      isDefault: false,
      userId: 1,
      config: "not json",
    });
    const r = await run(sb, ["notifications", "get", "8"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unreadable stored config");
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

  test("edit ignores the redacted values a get -> --config-file round trip carries", async () => {
    const f = join(sb.dir, "roundtrip.json");
    writeFileSync(
      f,
      JSON.stringify({
        id: 99,
        active: false,
        name: "ntfy home",
        type: "ntfy",
        ntfyPassword: "***",
        ntfyserverurl: "https://***@ntfy.example.com",
        ntfytopic: "home2",
      }),
    );
    const r = await run(sb, ["notifications", "edit", "3", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "addNotification")!.args[0] as any;
    expect(sent).toMatchObject({
      ntfyPassword: SECRET,
      ntfyserverurl: "https://ntfy.example.com",
      ntfytopic: "home2",
      applyExisting: false,
    });
    expect(sent).not.toHaveProperty("id");
    expect(sent).not.toHaveProperty("active");
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

  test("edit resolves a notification name to its id", async () => {
    const r = await run(
      sb,
      ["notifications", "edit", "ntfy home", "--set", "ntfytopic=home2"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, name: "ntfy home", type: "ntfy" });
    expect(kuma.calls.find((c) => c.event === "addNotification")!.args[1]).toBe(3);
  });

  test("test resolves a notification name to its id", async () => {
    const r = await run(sb, ["notifications", "test", "matrix"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, ok: true, msg: "Sent Successfully." });
    expect(kuma.calls.find((c) => c.event === "testNotification")).toBeDefined();
  });

  test("delete resolves a notification name and sends the numeric id", async () => {
    const r = await run(sb, ["notifications", "delete", "ntfy home", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, deleted: true });
    expect(kuma.calls.find((c) => c.event === "deleteNotification")!.args).toEqual([3]);
  });

  test("an unknown notification name exits 2 naming it", async () => {
    const r = await run(sb, ["notifications", "test", "No Such"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no notification named "No Such"');
    expect(kuma.calls.find((c) => c.event === "testNotification")).toBeUndefined();
  });

  test("an ambiguous notification name exits 2 naming the candidate ids", async () => {
    kuma.state.notifications.push({
      id: 9,
      name: "matrix",
      active: true,
      isDefault: false,
      userId: 1,
      config: JSON.stringify({ name: "matrix", type: "matrix" }),
    });
    const r = await run(sb, ["notifications", "test", "matrix"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('notification name "matrix" is ambiguous: ids 1, 9');
    expect(kuma.calls.find((c) => c.event === "testNotification")).toBeUndefined();
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

  test("delete with an unknown notification name exits 2 without sending deleteNotification", async () => {
    const r = await run(sb, ["notifications", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no notification named "abc"');
    expect(kuma.calls.find((c) => c.event === "deleteNotification")).toBeUndefined();
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
