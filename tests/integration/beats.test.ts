import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("beats (real Kuma)", () => {
  let sb: Sandbox;
  let pushId = 0;
  let pushUrl = "";

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add a paused push monitor", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-beat-push",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-beat-push", type: "push", active: false });
    pushId = out.id;
    pushUrl = out.pushUrl;
  }, 120_000);

  test("resume, push an up beat, beats --hours 1 shows it, pause again", async () => {
    const resumed = await cliRun(sb, ["monitors", "resume", String(pushId)]);
    expect(resumed.code).toBe(0);
    expect(resumed.json()).toEqual({ id: pushId, active: true });

    const pushed = await fetch(pushUrl, { signal: AbortSignal.timeout(10_000) });
    expect(pushed.status).toBe(200);

    const r = await cliRun(sb, ["beats", String(pushId), "--hours", "1"]);
    expect(r.code).toBe(0);
    expect(r.json().some((b: any) => b.status === 1)).toBe(true);

    const paused = await cliRun(sb, ["monitors", "pause", String(pushId)]);
    expect(paused.code).toBe(0);
    expect(paused.json()).toEqual({ id: pushId, active: false });
  }, 180_000);

  test("delete --yes removes the push monitor", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, deleted: true });
  }, 120_000);
});
