import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("list shows the new proxy", async () => {
    const r = await cliRun(sb, ["proxies", "list"]);
    expect(r.code).toBe(0);
    const row = r.json().find((p: any) => p.id === proxyId);
    expect(row).toMatchObject({
      protocol: "http",
      host: "127.0.0.1",
      port: 3128,
      auth: false,
    });
  }, 120_000);

  test("edit --set port=3129", async () => {
    const r = await cliRun(sb, ["proxies", "edit", String(proxyId), "--set", "port=3129"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: proxyId });
  }, 120_000);

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
