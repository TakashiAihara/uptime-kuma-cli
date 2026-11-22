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
      JSON.stringify({
        webhookURL: "http://it-user:it-pass@127.0.0.1:9/",
        webhookContentType: "json",
        webhookAdditionalHeaders: '{"Authorization":"Bearer it-header-secret"}',
      }),
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

  test("get prints the stored config with secrets redacted", async () => {
    const r = await cliRun(sb, ["notifications", "get", String(notifId)]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: notifId,
      active: true,
      name: "it-webhook",
      type: "webhook",
      isDefault: false,
      applyExisting: false,
      webhookURL: "http://***@127.0.0.1:9/",
      webhookContentType: "json",
      webhookAdditionalHeaders: "***",
    });
    expect(r.stdout).not.toContain("it-pass");
    expect(r.stdout).not.toContain("it-user");
    expect(r.stdout).not.toContain("it-header-secret");
  }, 120_000);

  test("get resolves the notification by name", async () => {
    const r = await cliRun(sb, ["notifications", "get", "it-webhook"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ id: notifId, name: "it-webhook", type: "webhook" });
  }, 120_000);

  test("get of an unknown id exits 1", async () => {
    const r = await cliRun(sb, ["notifications", "get", "999999"]);
    expect(r.code).toBe(1);
  }, 120_000);

  test("edit sends the config to Kuma and a rename is listed", async () => {
    const r = await cliRun(sb, [
      "notifications",
      "edit",
      String(notifId),
      "--set",
      "webhookContentType=form-data",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ id: notifId, name: "it-webhook", type: "webhook" });

    // Config values are never printed, so only the name can be read back
    const renamed = await cliRun(sb, [
      "notifications",
      "edit",
      String(notifId),
      "--set",
      "name=it-webhook-2",
    ]);
    expect(renamed.code).toBe(0);
    const list = await cliRun(sb, ["notifications", "list"]);
    expect(list.code).toBe(0);
    expect(list.json().find((n: any) => n.id === notifId)).toMatchObject({
      name: "it-webhook-2",
      type: "webhook",
    });
  }, 240_000);

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
