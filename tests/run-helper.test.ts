import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startFakeKuma } from "./helpers/fake-kuma";
import { creds, resetRunWarnings, run, sandbox, type Sandbox } from "./helpers/run";

// UPTIME_KUMA_IT_BIN only takes effect while UPTIME_KUMA_IT_URL marks the
// integration environment, so the helper sets both and restores both.
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
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

async function withItEnv<T>(
  bin: string | undefined,
  itUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withEnv({ UPTIME_KUMA_IT_BIN: bin, UPTIME_KUMA_IT_URL: itUrl }, fn);
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

  test("kills a binary that outlives the watchdog", async () => {
    // trap makes the shell ignore SIGTERM, so only SIGKILL ends the run.
    const bin = fakeCli(`trap '' TERM; sleep 30`);
    const started = Date.now();
    await expect(
      withEnv(
        {
          UPTIME_KUMA_IT_BIN: bin,
          UPTIME_KUMA_IT_URL: IT_URL,
          UPTIME_KUMA_IT_BIN_TIMEOUT_MS: "500",
        },
        () => run(sb, ["tags", "list"]),
      ),
    ).rejects.toThrow("did not finish within 500ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("kills a binary whose descendant keeps the pipes open", async () => {
    // The backgrounded sleep inherits the pipes and outlives the killed
    // shell; without cancelling the reads the run would wait for it.
    const bin = fakeCli(`sleep 30 & wait`);
    const started = Date.now();
    await expect(
      withEnv(
        {
          UPTIME_KUMA_IT_BIN: bin,
          UPTIME_KUMA_IT_URL: IT_URL,
          UPTIME_KUMA_IT_BIN_TIMEOUT_MS: "500",
        },
        () => run(sb, ["tags", "list"]),
      ),
    ).rejects.toThrow("did not finish within 500ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("drains output larger than the pipe buffer while the binary runs", async () => {
    const bin = fakeCli(`seq 1 200000`);
    const r = await withEnv(
      {
        UPTIME_KUMA_IT_BIN: bin,
        UPTIME_KUMA_IT_URL: IT_URL,
        UPTIME_KUMA_IT_BIN_TIMEOUT_MS: "3000",
      },
      () => run(sb, ["tags", "list"]),
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(65536);
  });

  test("rejects an invalid UPTIME_KUMA_IT_BIN_TIMEOUT_MS", async () => {
    const bin = fakeCli(`echo hi`);
    for (const bad of ["abc", "9999999999"]) {
      await expect(
        withEnv(
          {
            UPTIME_KUMA_IT_BIN: bin,
            UPTIME_KUMA_IT_URL: IT_URL,
            UPTIME_KUMA_IT_BIN_TIMEOUT_MS: bad,
          },
          () => run(sb, ["tags", "list"]),
        ),
      ).rejects.toThrow("must be an integer between 1 and 2147483647");
    }
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

  test("warns once when UPTIME_KUMA_IT_URL is set without UPTIME_KUMA_IT_BIN", async () => {
    sb = sandbox();
    resetRunWarnings();
    const kuma = await startFakeKuma({ tags: [] });
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withItEnv(undefined, IT_URL, async () => {
        for (let i = 0; i < 2; i++) {
          const r = await run(sb, ["tags", "list"], creds(kuma.url));
          expect(r.code).toBe(0);
        }
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("UPTIME_KUMA_IT_BIN");
    } finally {
      spy.mockRestore();
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
