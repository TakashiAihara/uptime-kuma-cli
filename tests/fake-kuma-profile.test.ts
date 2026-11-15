import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, disconnect } from "../src/kuma";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

const ENV_KEYS = [
  "UPTIME_KUMA_URL",
  "UPTIME_KUMA_USERNAME",
  "UPTIME_KUMA_PASSWORD",
  "XDG_CONFIG_HOME",
  "HOME",
] as const;

let kuma: FakeKuma | undefined;
let sb: Sandbox;
const savedEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

beforeEach(() => {
  sb = sandbox();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(async () => {
  disconnect();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await kuma?.close();
  kuma = undefined;
  sb.cleanup();
});

describe("fake kuma 2.x profile", () => {
  test("connect reports the 2.x version and major version", async () => {
    kuma = await startFakeKuma({ profile: "2.x" });
    Object.assign(process.env, creds(kuma.url), {
      XDG_CONFIG_HOME: sb.xdg,
      HOME: sb.home,
    });
    const s = await connect();
    expect(s.serverVersion).toBe("2.5.11");
    expect(s.majorVersion).toBe(2);
  });

  test("monitors add fails on the NOT NULL conditions column", async () => {
    kuma = await startFakeKuma({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--paused"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SQLITE_CONSTRAINT: NOT NULL constraint failed: monitor.conditions");
  });

  test("the default profile accepts the same add", async () => {
    kuma = await startFakeKuma();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--paused"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
  });
});
