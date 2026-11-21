import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("api-keys (real Kuma)", () => {
  let sb: Sandbox;
  let keyId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("key lifecycle: add, list, disable, enable, delete", async () => {
    const add = await cliRun(sb, [
      "api-keys",
      "add",
      "--name",
      "it-key",
      "--expires",
      "2099-01-01T00:00",
    ]);
    expect(add.code).toBe(0);
    const added = add.json();
    keyId = added.id;
    expect(added.name).toBe("it-key");
    expect(added.expires).toBe("2099-01-01 00:00:00");
    expect(added.active).toBe(true);
    // the clear key is "uk<id>_<nanoid(40)>" and is returned only by add
    expect(added.key).toMatch(new RegExp(`^uk${keyId}_[A-Za-z0-9_-]{40}$`));

    const list = await cliRun(sb, ["api-keys", "list"]);
    expect(list.code).toBe(0);
    const row = list.json().find((k: any) => k.id === keyId);
    expect(row).toEqual({
      id: keyId,
      name: "it-key",
      expires: "2099-01-01 00:00:00",
      active: true,
      status: "active",
    });

    const disable = await cliRun(sb, ["api-keys", "disable", String(keyId)]);
    expect(disable.code).toBe(0);
    expect(disable.json()).toEqual({ id: keyId, active: false });

    const enable = await cliRun(sb, ["api-keys", "enable", String(keyId)]);
    expect(enable.code).toBe(0);
    expect(enable.json()).toEqual({ id: keyId, active: true });

    // without --yes the command refuses before connecting
    const noYes = await cliRun(sb, ["api-keys", "delete", String(keyId)]);
    expect(noYes.code).toBe(2);

    const del = await cliRun(sb, ["api-keys", "delete", String(keyId), "--yes"]);
    expect(del.code).toBe(0);
    expect(del.json()).toEqual({ id: keyId, deleted: true });

    // the DELETE answers ok for an unknown id, so the CLI's own pre-check
    // against apiKeyList is what makes a second delete exit 1
    const again = await cliRun(sb, ["api-keys", "delete", String(keyId), "--yes"]);
    expect(again.code).toBe(1);

    const after = await cliRun(sb, ["api-keys", "list"]);
    expect(after.code).toBe(0);
    expect(after.json().some((k: any) => k.id === keyId)).toBe(false);
  }, 300_000);
});
