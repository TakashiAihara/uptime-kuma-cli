import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("tags (real Kuma)", () => {
  let sb: Sandbox;
  let tagId = 0;
  let monitorId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("tag lifecycle: create, attach on add, filter, retag, untag, delete", async () => {
    const addTag = await cliRun(sb, ["tags", "add", "--name", "it-env", "--color", "#123456"]);
    expect(addTag.code).toBe(0);
    tagId = addTag.json().id;

    const add = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-tagged",
      "--paused",
      "--tag",
      `${tagId}:prod`,
    ]);
    expect(add.code).toBe(0);
    monitorId = add.json().id;
    expect(add.json().tags).toEqual([{ tagId, name: "it-env", value: "prod" }]);

    const list = await cliRun(sb, ["monitors", "list", "--tag", "it-env"]);
    expect(list.code).toBe(0);
    const found = list.json().find((m: any) => m.id === monitorId);
    expect(found).toBeDefined();
    expect(found.tags).toEqual([{ tagId, name: "it-env", value: "prod" }]);

    const retag = await cliRun(sb, [
      "monitors",
      "retag",
      String(monitorId),
      "--tag",
      String(tagId),
      "--value",
      "staging",
    ]);
    expect(retag.code).toBe(0);
    expect(retag.json()).toEqual({ id: monitorId, tagId, value: "staging" });

    const get = await cliRun(sb, ["monitors", "get", String(monitorId)]);
    expect(get.code).toBe(0);
    expect(get.json().tags).toEqual([{ tagId, name: "it-env", value: "staging" }]);

    const untag = await cliRun(sb, [
      "monitors",
      "untag",
      String(monitorId),
      "--tag",
      String(tagId),
      "--value",
      "staging",
    ]);
    expect(untag.code).toBe(0);
    expect(untag.json()).toEqual({ id: monitorId, tagId, value: "staging", removed: true });

    const delMonitor = await cliRun(sb, ["monitors", "delete", String(monitorId), "--yes"]);
    expect(delMonitor.code).toBe(0);
    const delTag = await cliRun(sb, ["tags", "delete", String(tagId), "--yes"]);
    expect(delTag.code).toBe(0);
  }, 300_000);
});
