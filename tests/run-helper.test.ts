import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, sandbox, type Sandbox } from "./helpers/run";

async function withBin<T>(bin: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.UPTIME_KUMA_IT_BIN;
  if (bin === undefined) delete process.env.UPTIME_KUMA_IT_BIN;
  else process.env.UPTIME_KUMA_IT_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.UPTIME_KUMA_IT_BIN;
    else process.env.UPTIME_KUMA_IT_BIN = prev;
  }
}

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
    const r = await withBin(bin, () =>
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
    const r = await withBin(bin, () => run(sb, ["tags", "list"]));
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("out-line\n");
    expect(r.stderr).toBe("err-line\n");
  });

  test("rejects a concurrent invocation like the in-process path", async () => {
    const bin = fakeCli(`sleep 0.2`);
    await withBin(bin, async () => {
      const first = run(sb, ["tags", "list"]);
      await expect(run(sb, ["tags", "list"])).rejects.toThrow("cannot run concurrently");
      expect((await first).code).toBe(0);
    });
  });

  test("rejects an empty UPTIME_KUMA_IT_BIN", async () => {
    sb = sandbox();
    await expect(withBin("", () => run(sb, ["tags"]))).rejects.toThrow("set but empty");
  });

  test("rejects a UPTIME_KUMA_IT_BIN that does not exist", async () => {
    sb = sandbox();
    await expect(withBin(join(sb.dir, "nope"), () => run(sb, ["tags"]))).rejects.toThrow(
      "does not exist",
    );
  });

  test("rejects a UPTIME_KUMA_IT_BIN that is not executable", async () => {
    sb = sandbox();
    const file = join(sb.dir, "not-exec");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);
    await expect(withBin(file, () => run(sb, ["tags"]))).rejects.toThrow("not executable");
  });
});
