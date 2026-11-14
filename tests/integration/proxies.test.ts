import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("proxies (real Kuma)", () => {
  let sb: Sandbox;
  let proxyId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add --protocol http --host 127.0.0.1 --port 3128", async () => {
    const r = await cliRun(sb, [
      "proxies",
      "add",
      "--protocol",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "3128",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.id).toBeGreaterThan(0);
    proxyId = out.id;
  }, 120_000);

  test("list shows the whole row", async () => {
    const r = await cliRun(sb, ["proxies", "list"]);
    expect(r.code).toBe(0);
    const row = r.json().find((p: any) => p.id === proxyId);
    expect(row).toEqual({
      id: proxyId,
      protocol: "http",
      host: "127.0.0.1",
      port: 3128,
      auth: false,
      username: null,
      active: true,
      default: false,
    });
  }, 120_000);

  test("edit --set port=3129 is stored", async () => {
    const r = await cliRun(sb, ["proxies", "edit", String(proxyId), "--set", "port=3129"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: proxyId });
    const list = await cliRun(sb, ["proxies", "list"]);
    expect(list.code).toBe(0);
    expect(list.json().find((p: any) => p.id === proxyId)).toMatchObject({ port: 3129 });
  }, 180_000);

  test("a proxy added with credentials and --default lists auth/default true", async () => {
    const f = join(sb.dir, "proxy-pw");
    writeFileSync(f, "it-proxy-pw\n");
    const r = await cliRun(sb, [
      "proxies",
      "add",
      "--protocol",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "3128",
      "--username",
      "u",
      "--password-file",
      f,
      "--default",
    ]);
    expect(r.code).toBe(0);
    const authedId = r.json().id;
    expect(authedId).toBeGreaterThan(0);

    const list = await cliRun(sb, ["proxies", "list"]);
    expect(list.code).toBe(0);
    expect(list.json().find((p: any) => p.id === authedId)).toEqual({
      id: authedId,
      protocol: "http",
      host: "127.0.0.1",
      port: 3128,
      auth: true,
      username: "u",
      active: true,
      default: true,
    });

    const del = await cliRun(sb, ["proxies", "delete", String(authedId), "--yes"]);
    expect(del.code).toBe(0);
    expect(del.json()).toEqual({ id: authedId, deleted: true });
  }, 240_000);

  test("delete --yes removes it", async () => {
    const r = await cliRun(sb, ["proxies", "delete", String(proxyId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: proxyId, deleted: true });
  }, 120_000);

  test("deleting it again exits 1", async () => {
    const r = await cliRun(sb, ["proxies", "delete", String(proxyId), "--yes"]);
    expect(r.code).toBe(1);
  }, 120_000);
});
