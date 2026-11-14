import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("notifications (real Kuma)", () => {
  let sb: Sandbox;
  let notifId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add --type webhook with a config file", async () => {
    // Port 9 (discard) is unreachable on purpose; notifications test is never called
    const f = join(sb.dir, "webhook.json");
    writeFileSync(
      f,
      JSON.stringify({ webhookURL: "http://127.0.0.1:9/", webhookContentType: "json" }),
    );
    const r = await cliRun(sb, [
      "notifications",
      "add",
      "--name",
      "it-webhook",
      "--type",
      "webhook",
      "--config-file",
      f,
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-webhook", type: "webhook" });
    expect(out.id).toBeGreaterThan(0);
    notifId = out.id;
  }, 120_000);

  test("list shows the new notification", async () => {
    const r = await cliRun(sb, ["notifications", "list"]);
    expect(r.code).toBe(0);
    const row = r.json().find((n: any) => n.id === notifId);
    expect(row).toMatchObject({ name: "it-webhook", type: "webhook" });
  }, 120_000);

  test("edit --set webhookContentType=form-data", async () => {
    const r = await cliRun(sb, [
      "notifications",
      "edit",
      String(notifId),
      "--set",
      "webhookContentType=form-data",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ id: notifId, name: "it-webhook", type: "webhook" });
  }, 120_000);

  test("delete --yes removes it", async () => {
    const r = await cliRun(sb, ["notifications", "delete", String(notifId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: notifId, deleted: true });
  }, 120_000);

  test("deleting it again exits 1", async () => {
    const r = await cliRun(sb, ["notifications", "delete", String(notifId), "--yes"]);
    expect(r.code).toBe(1);
  }, 120_000);
});
