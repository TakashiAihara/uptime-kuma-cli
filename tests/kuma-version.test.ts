import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  const cases: [string | undefined, number][] = [
    ["1.23.17", 1],
    ["2.5.11", 2],
    ["2.0.0-beta.2", 2],
    ["2.0.0-beta.2-temp", 2],
    ["3.0.0-beta.0", 3],
    ["10.1.0", 10],
    [undefined, 1],
    ["", 1],
    ["abc", 1],
    ["2", 1],
    ["2.5", 1],
    ["x2.5.11", 1],
  ];
  test.each(cases)("%p -> %p", (version, expected) => {
    expect(parseMajorVersion(version)).toBe(expected);
  });
});

describe("connect waits for the pre-login info before login", () => {
  test("a server that registers its listeners late (2.5.11's awaited sendInfo) still logs in", async () => {
    // longer than any fixed pause a broken fix might use instead of the wait
    const s = await session({ profile: "2.x", listenersDelayMs: 1500 });
    expect(s.serverVersion).toBe("2.5.11");
  });

  test("a server that never sends the pre-login info exits 2 naming it", async () => {
    process.env.UPTIME_KUMA_TIMEOUT = "1";
    try {
      const err = await session({ noPreLoginInfo: true }).catch((e) => e);
      expect(err).toMatchObject({ exitCode: 2 });
      expect(String(err.message)).toContain("timed out waiting for the server info");
    } finally {
      delete process.env.UPTIME_KUMA_TIMEOUT;
    }
  });
});

describe("connect", () => {
  test("reports the version of the default fake without a warning", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await session();
      expect(s.serverVersion).toBe("1.23.17");
      expect(s.majorVersion).toBe(1);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test("an info that arrives shortly after the lists is still read", async () => {
    const s = await session({ info: { version: "2.5.11" }, infoDelayMs: 150 });
    expect(s.serverVersion).toBe("2.5.11");
    expect(s.majorVersion).toBe(2);
  });

  test("a 2.x info payload reports major version 2", async () => {
    const s = await session({ info: { version: "2.5.11", dbType: "sqlite" } });
    expect(s.serverVersion).toBe("2.5.11");
    expect(s.majorVersion).toBe(2);
  });

  test("an info sent before the login answer, like 2.x, is read", async () => {
    const s = await session({ info: { version: "2.5.11" }, infoBeforeLoginAck: true });
    expect(s.serverVersion).toBe("2.5.11");
    expect(s.majorVersion).toBe(2);
  });

  test("no info push falls back to major 1 with a warning", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const s = await session({ info: null });
      // the grace is short; a server without a version must not stall every command
      expect(Date.now() - started).toBeLessThan(1500);
      expect(s.serverVersion).toBeUndefined();
      expect(s.majorVersion).toBe(1);
      expect(err).toHaveBeenCalledWith(
        "warning: the server sent no version after login; assuming Uptime Kuma 1.x",
      );
    } finally {
      err.mockRestore();
    }
  });

  test("the fake's pre-login info carries no version", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await session({ skipLists: ["info"] });
      expect(s.serverVersion).toBeUndefined();
      expect(s.majorVersion).toBe(1);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  test("a non-string version is not recorded", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await session({ info: { version: 25 } });
      expect(s.serverVersion).toBeUndefined();
      expect(s.majorVersion).toBe(1);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
