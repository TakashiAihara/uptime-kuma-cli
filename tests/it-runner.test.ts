import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join, resolve } from "node:path";
import { Server } from "socket.io";
import { sandbox, type Sandbox } from "./helpers/run";

const REPO = resolve(import.meta.dir, "..");
const RUNNER = join(REPO, "scripts", "integration.ts");

// scripts/integration.ts is exercised against fake `docker` and `bun`
// binaries on PATH: the fakes log every call to FAKE_LOG so tests can assert
// the order of compose invocations and child exits around a signal. The
// setupKuma Socket.IO handshake is answered by a stub server bound to an
// ephemeral port, which becomes UPTIME_KUMA_IT_PORT for the runner.

const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
shift 5
case "$1" in
  down)
    n=0
    [ -f "$FAKE_DOWN_COUNT" ] && n=$(cat "$FAKE_DOWN_COUNT")
    n=$((n + 1))
    echo "$n" > "$FAKE_DOWN_COUNT"
    if [ -n "$FAKE_DOWN_FAIL_AT" ] && [ "$n" = "$FAKE_DOWN_FAIL_AT" ]; then
      exit 1
    fi
    if [ -n "$FAKE_DOWN_SLEEP_AT" ] && [ "$n" = "$FAKE_DOWN_SLEEP_AT" ]; then
      exec sleep "$FAKE_DOWN_SLEEP"
    fi
    exit 0
    ;;
  up)
    exec sleep "\${FAKE_UP_SLEEP:-0}"
    ;;
  *)
    exit 0
    ;;
esac
`;

const FAKE_BUN = `#!/bin/sh
echo "bun $*" >> "$FAKE_LOG"
case "$1" in
  *build.ts)
    [ -n "$FAKE_BUILD_SLEEP" ] && sleep "$FAKE_BUILD_SLEEP"
    mkdir -p dist
    printf '#!/bin/sh\\nexit 0\\n' > "dist/uptime-kuma-cli-$2"
    chmod +x "dist/uptime-kuma-cli-$2"
    exit 0
    ;;
  test)
    exec "$REAL_BUN" "$FAKE_TEST_CHILD"
    ;;
  *)
    exec "$REAL_BUN" "$@"
    ;;
esac
`;

// The fake `bun test` child: logs "ran" and exits FAKE_TEST_EXIT, or with
// FAKE_TEST_HANG=1 installs signal handlers first, logs "started", then hangs
// until signalled — "started" therefore means the handlers are already live.
const FAKE_TEST_CHILD = `import { appendFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
if (log === undefined) throw new Error("FAKE_LOG unset");
if (process.env.FAKE_TEST_HANG === "1") {
  const term = () => {
    appendFileSync(log, "bun-test-child termed\\n");
    process.exit(0);
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", term);
  appendFileSync(log, "bun-test-child started\\n");
  await new Promise(() => {});
}
appendFileSync(log, "bun-test-child ran\\n");
process.exit(Number(process.env.FAKE_TEST_EXIT ?? "0"));
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startSetupKuma(): Promise<{ port: number; close: () => Promise<void> }> {
  const http = createServer();
  const sockets = new Set<Socket>();
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const io = new Server(http);
  io.on("connection", (socket) => {
    socket.emit("info", {});
    socket.on("needSetup", (ack: (v: boolean) => void) => ack(true));
    socket.on("setup", (_u: unknown, _p: unknown, ack: (v: unknown) => void) => ack({ ok: true }));
    socket.on("login", (_c: unknown, ack: (v: unknown) => void) => {
      ack({ ok: true });
      socket.emit("info", { version: "1.23.17" });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        io.close();
        for (const s of sockets) s.destroy();
        http.close(() => r());
      }),
  };
}

type Runner = {
  proc: ReturnType<typeof Bun.spawn>;
  log: string;
  exited: Promise<number>;
  output: () => Promise<string>;
};

function startRunner(sb: Sandbox, port: number, env: Record<string, string>): Runner {
  const bin = join(sb.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(sb.dir, "calls.log");
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "bun"), FAKE_BUN, { mode: 0o755 });
  writeFileSync(join(sb.dir, "fake-test-child.ts"), FAKE_TEST_CHILD);
  const proc = Bun.spawn([process.execPath, RUNNER], {
    cwd: REPO,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: sb.home,
      UPTIME_KUMA_IT_PORT: String(port),
      FAKE_LOG: log,
      FAKE_DOWN_COUNT: join(sb.dir, "down.count"),
      REAL_BUN: process.execPath,
      FAKE_TEST_CHILD: join(sb.dir, "fake-test-child.ts"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  return {
    proc,
    log,
    exited: proc.exited,
    output: async () => `--- stdout ---\n${await stdoutP}\n--- stderr ---\n${await stderrP}`,
  };
}

async function waitForLog(log: string, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)} in calls.log:\n${text}`);
    }
    await sleep(50);
  }
}

async function waitForCount(log: string, needle: string, count: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (countLines(text, needle) >= count) return text;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} x ${JSON.stringify(needle)} in calls.log:\n${text}`,
      );
    }
    await sleep(50);
  }
}

function countLines(text: string, needle: string): number {
  return text.split("\n").filter((l) => l.includes(needle)).length;
}

describe("scripts/integration.ts signal handling", () => {
  let sb: Sandbox;
  let kuma: { port: number; close: () => Promise<void> };
  let runner: Runner | undefined;

  beforeEach(async () => {
    sb = sandbox();
    kuma = await startSetupKuma();
  });

  afterEach(async () => {
    if (runner !== undefined && runner.proc.exitCode === null) {
      runner.proc.kill("SIGKILL");
      await runner.proc.exited;
    }
    runner = undefined;
    await kuma.close();
    sb.cleanup();
  });

  test("SIGTERM during compose up kills the up child before the down -v", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_UP_SLEEP: "300" });
    await waitForLog(runner.log, "up -d --wait");
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "up -d --wait")).toBe(1);
    expect(countLines(log, "down -v")).toBe(2);
    expect(log.indexOf("down -v", log.indexOf("up -d --wait"))).toBeGreaterThan(
      log.indexOf("up -d --wait"),
    );
    expect(log).not.toContain("bun-test-child");
  }, 30_000);

  test("SIGINT during the pre-up down -v skips up and still tears down", async () => {
    runner = startRunner(sb, kuma.port, {
      FAKE_DOWN_SLEEP_AT: "1",
      FAKE_DOWN_SLEEP: "300",
    });
    await waitForLog(runner.log, "down -v");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    expect(log).not.toContain("up -d --wait");
    expect(countLines(log, "down -v")).toBe(2);
  }, 30_000);

  test("a failed down -v is retried and the run still exits 0", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_DOWN_FAIL_AT: "2" });
    expect(await runner.exited).toBe(0);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "down -v")).toBe(3);
    expect(log).toContain("bun-test-child ran");
    expect(await runner.output()).toContain("Kuma 1.23.17 ready");
  }, 30_000);

  test("SIGINT during bun test waits for it to exit before the down -v", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_TEST_HANG: "1" });
    await waitForLog(runner.log, "bun-test-child started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    const termed = log.indexOf("bun-test-child termed");
    const lastDown = log.lastIndexOf("down -v");
    expect(termed).toBeGreaterThan(-1);
    expect(lastDown).toBeGreaterThan(termed);
  }, 30_000);

  test("SIGINT during the build skips up and still tears down", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_BUILD_SLEEP: "2" });
    await waitForLog(runner.log, "build.ts");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    expect(log).not.toContain("up -d --wait");
    // The pre-up down may be killed before its fake docker logs the call, so
    // only the teardown down -v is guaranteed to appear.
    expect(countLines(log, "down -v")).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("SIGTERM during the final down -v retries teardown and exits 143", async () => {
    runner = startRunner(sb, kuma.port, {
      FAKE_DOWN_SLEEP_AT: "2",
      FAKE_DOWN_SLEEP: "300",
    });
    await waitForCount(runner.log, "down -v", 2);
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "down -v")).toBe(3);
    expect(log.indexOf("bun-test-child ran")).toBeLessThan(log.lastIndexOf("down -v"));
  }, 30_000);
});
