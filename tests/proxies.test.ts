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

describe("proxies", () => {
  test("list never prints the password", async () => {
    const r = await run(sb, ["proxies", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      {
        id: 2,
        protocol: "socks5",
        host: "10.0.0.9",
        port: 1080,
        auth: true,
        username: "u1",
        active: true,
        default: false,
      },
    ]);
    expect(r.stdout).not.toContain(SECRET);
  });

  test("add reads the password from a file", async () => {
    const f = join(sb.dir, "pw");
    writeFileSync(f, "file-pw\n");
    const r = await run(
      sb,
      [
        "proxies",
        "add",
        "--protocol",
        "http",
        "--host",
        "10.0.0.8",
        "--port",
        "3128",
        "--username",
        "u2",
        "--password-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3 });
    const call = kuma.calls.find((c) => c.event === "addProxy")!;
    expect(call.args[1]).toBeNull();
    expect(call.args[0]).toMatchObject({
      protocol: "http",
      host: "10.0.0.8",
      port: 3128,
      auth: true,
      username: "u2",
      password: "file-pw",
      default: false,
      applyExisting: false,
    });
  });

  test("add without credentials sends auth false", async () => {
    const r = await run(
      sb,
      ["proxies", "add", "--protocol", "socks5", "--host", "h", "--port", "1"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((kuma.calls.find((c) => c.event === "addProxy")!.args[0] as any).auth).toBe(false);
  });

  test("add with an unknown protocol exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["proxies", "add", "--protocol", "ftp", "--host", "h", "--port", "1"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --password-file replaces the password without putting it in argv", async () => {
    const f = join(sb.dir, "newpw");
    writeFileSync(f, "replaced-pw\n");
    kuma.state.proxies[0]!.auth = false;
    const r = await run(sb, ["proxies", "edit", "2", "--password-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const call = kuma.calls.find((c) => c.event === "addProxy")!;
    expect((call.args[0] as any).password).toBe("replaced-pw");
    expect((call.args[0] as any).auth).toBe(true);
    expect(r.stdout).not.toContain("replaced-pw");
  });

  test("edit without --set or --password-file exits 2", async () => {
    const r = await run(sb, ["proxies", "edit", "2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit keeps the stored password and changes the port", async () => {
    const r = await run(sb, ["proxies", "edit", "2", "--set", "port=1081"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2 });
    const call = kuma.calls.find((c) => c.event === "addProxy")!;
    expect(call.args[1]).toBe(2);
    expect(call.args[0]).toMatchObject({
      port: 1081,
      password: SECRET,
      host: "10.0.0.9",
      protocol: "socks5",
    });
  });

  test("edit of an unknown id exits 1", async () => {
    const r = await run(sb, ["proxies", "edit", "9", "--set", "port=1"], creds(kuma.url));
    expect(r.code).toBe(1);
  });
});
