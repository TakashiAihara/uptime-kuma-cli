import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, disconnect, parseMajorVersion } from "../src/kuma";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, type Sandbox, sandbox } from "./helpers/run";

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

// connect() resolves credentials from env and the config dir, so the sandbox
// keeps the real config and secrets out of the test.
const session = async (init: Parameters<typeof startFakeKuma>[0] = {}) => {
  kuma = await startFakeKuma(init);
  Object.assign(process.env, creds(kuma.url), {
    XDG_CONFIG_HOME: sb.xdg,
    HOME: sb.home,
  });
  return connect();
};

describe("parseMajorVersion", () => {
  const cases: [unknown, number][] = [
    ["1.23.17", 1],
    ["2.5.11", 2],
    ["2.0.0-beta.2", 2],
    ["10.1.0", 10],
    [undefined, 1],
    ["", 1],
    ["abc", 1],
    ["2", 1],
    [2, 1],
    [["2.5.11"], 1],
  ];
  test.each(cases)("%p -> %p", (version, expected) => {
    expect(parseMajorVersion(version)).toBe(expected);
  });
});

describe("connect", () => {
  test("reports the version of the default fake", async () => {
    const s = await session();
    expect(s.serverVersion).toBe("1.23.17");
    expect(s.majorVersion).toBe(1);
  });

  test("a 2.x info payload reports major version 2", async () => {
    const s = await session({ info: { version: "2.5.11", dbType: "sqlite" } });
    expect(s.serverVersion).toBe("2.5.11");
    expect(s.majorVersion).toBe(2);
  });

  test("no info push leaves serverVersion undefined and major 1", async () => {
    const s = await session({ info: null });
    expect(s.serverVersion).toBeUndefined();
    expect(s.majorVersion).toBe(1);
  });

  test("the pre-login info alone hides the version", async () => {
    const s = await session({ skipLists: ["info"] });
    expect(s.serverVersion).toBeUndefined();
    expect(s.majorVersion).toBe(1);
  });

  test("a non-string version is not recorded", async () => {
    const s = await session({ info: { version: 25 } });
    expect(s.serverVersion).toBeUndefined();
    expect(s.majorVersion).toBe(1);
  });
});
