import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, sandbox, type Sandbox } from "./helpers/run";

// UPTIME_KUMA_IT_BIN only takes effect while UPTIME_KUMA_IT_URL marks the
// integration environment, so the helper sets both and restores both.
async function withItEnv<T>(
  bin: string | undefined,
  itUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = {
    UPTIME_KUMA_IT_BIN: process.env.UPTIME_KUMA_IT_BIN,
    UPTIME_KUMA_IT_URL: process.env.UPTIME_KUMA_IT_URL,
  };
  for (const [key, value] of [
    ["UPTIME_KUMA_IT_BIN", bin],
    ["UPTIME_KUMA_IT_URL", itUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A non-empty URL is all the gate checks; the fake binary never dials it.
const IT_URL = "http://127.0.0.1:1";

describe("run()", () => {
  test("rejects a concurrent invocation instead of corrupting shared state", async () => {
    const sb = sandbox();
    const kuma = await startFakeKuma();
    try {
      const first = run(sb, ["tags", "list"], creds(kuma.url));
      await expect(run(sb, ["tags", "list"], creds(kuma.url))).rejects.toThrow(
        "cannot run concurrently",
      );
      expect((await first).code).toBe(0);
    } finally {
      await kuma.close();
      sb.cleanup();
    }
  });
});

describe("run() with UPTIME_KUMA_IT_BIN", () => {
  let sb: Sandbox;
  afterEach(() => sb.cleanup());

  function fakeCli(body: string): string {
    sb = sandbox();
    const file = join(sb.dir, "fake-cli");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  test("spawns the binary with the same clean env and returns its exit code", async () => {
    const bin = fakeCli(
      `printf '{"args":"%s","home":"%s","timeout":"%s","marker":"%s"}\\n' "$*" "$HOME" "$UPTIME_KUMA_TIMEOUT" "$IT_MARKER"`,
    );
    const r = await withItEnv(bin, IT_URL, () =>
      run(sb, ["tags", "list", "--name", "x"], { IT_MARKER: "m1" }),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      args: "tags list --name x",
      home: sb.home,
      timeout: "3",
      marker: "m1",
    });
  });

  test("captures stdout, stderr and a nonzero exit code", async () => {
    const bin = fakeCli(`echo out-line; echo err-line >&2; exit 3`);
    const r = await withItEnv(bin, IT_URL, () => run(sb, ["tags", "list"]));
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("out-line\n");
    expect(r.stderr).toBe("err-line\n");
  });

  test("rejects a concurrent invocation like the in-process path", async () => {
    const bin = fakeCli(`sleep 0.2`);
    await withItEnv(bin, IT_URL, async () => {
      const first = run(sb, ["tags", "list"]);
      await expect(run(sb, ["tags", "list"])).rejects.toThrow("cannot run concurrently");
      expect((await first).code).toBe(0);
    });
  });

  test("stays in-process when UPTIME_KUMA_IT_URL is not set", async () => {
    const kuma = await startFakeKuma({
      tags: [{ id: 1, name: "staging", color: "#00ff00" }],
    });
    const bin = fakeCli(`echo '{"from":"binary"}'`);
    try {
      const r = await withItEnv(bin, undefined, () => run(sb, ["tags", "list"], creds(kuma.url)));
      expect(r.code).toBe(0);
      expect(r.json()).toEqual([{ id: 1, name: "staging", color: "#00ff00" }]);
    } finally {
      await kuma.close();
    }
  });

  test("rejects an empty UPTIME_KUMA_IT_BIN", async () => {
    sb = sandbox();
    await expect(withItEnv("", IT_URL, () => run(sb, ["tags"]))).rejects.toThrow("set but empty");
  });

  test("rejects a UPTIME_KUMA_IT_BIN that does not exist", async () => {
    sb = sandbox();
    await expect(withItEnv(join(sb.dir, "nope"), IT_URL, () => run(sb, ["tags"]))).rejects.toThrow(
      "does not exist",
    );
  });

  test("rejects a UPTIME_KUMA_IT_BIN that is not executable", async () => {
    sb = sandbox();
    const file = join(sb.dir, "not-exec");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);
    await expect(withItEnv(file, IT_URL, () => run(sb, ["tags"]))).rejects.toThrow(
      "not executable",
    );
  });
});
