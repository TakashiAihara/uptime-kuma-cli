import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join, resolve } from "node:path";

import { Server } from "socket.io";

import {
  SHARD_TEST_LIMIT_MS,
  testLimitMs,
  UNSHARDED_TEST_LIMIT_MS,
} from "../scripts/integration-limit.ts";
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
    fail=0
    [ -n "$FAKE_DOWN_FAIL_ALWAYS" ] && fail=1
    if [ -n "$FAKE_DOWN_FAIL_AT" ] && [ "$n" = "$FAKE_DOWN_FAIL_AT" ]; then fail=1; fi
    [ "$fail" = 1 ] && exit 1
    if [ -n "$FAKE_DOWN_IGNORE_TERM_AT" ] && [ "$n" = "$FAKE_DOWN_IGNORE_TERM_AT" ]; then
      trap '' TERM
      exec sleep 60
    fi
    if [ -n "$FAKE_DOWN_SLEEP_AT" ] && [ "$n" = "$FAKE_DOWN_SLEEP_AT" ]; then
      exec sleep "$FAKE_DOWN_SLEEP"
    fi
    exit 0
    ;;
  up)
    sleep "\${FAKE_UP_SLEEP:-0}" &
    pid=$!
    trap 'echo "up termed" >> "$FAKE_LOG"; kill "$pid" 2>/dev/null; exit 0' TERM
    echo "up armed" >> "$FAKE_LOG"
    wait "$pid"
    exit 0
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
    if [ -n "$FAKE_BUILD_SLEEP" ]; then
      "$FAKE_BUILD_GRANDCHILD" &
      wait $!
    fi
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
  if (process.env.FAKE_TEST_IGNORE_TERM === "1") {
    process.on("SIGTERM", () => {});
  } else {
    const term = () => {
      appendFileSync(log, "bun-test-child termed\\n");
      process.exit(0);
    };
    process.on("SIGTERM", term);
    process.on("SIGINT", term);
  }
  const gc = process.env.FAKE_BUILD_GRANDCHILD;
  if (process.env.FAKE_TEST_GC === "1" && gc !== undefined) {
    Bun.spawn([gc], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  }
  appendFileSync(log, "bun-test-child started\\n");
  await new Promise((r) => setTimeout(r, 120_000));
}
appendFileSync(log, "bun-test-child ran\\n");
process.exit(Number(process.env.FAKE_TEST_EXIT ?? "0"));
`;

// The fake build's grandchild stands in for `bun build --compile` under
// scripts/build.ts: it traps TERM itself (logging "grandchild termed") but
// nothing forwards a signal to it, so only a process-group kill ends it.
const FAKE_BUILD_GRANDCHILD = `#!/bin/sh
echo $$ > "\${FAKE_GC_PIDFILE:-/dev/null}"
if [ -n "$FAKE_GC_IGNORE_TERM" ]; then
  trap '' TERM
else
  trap 'echo "grandchild termed" >> "$FAKE_LOG"; kill "$pid" 2>/dev/null; exit 0' TERM
fi
echo "grandchild started" >> "$FAKE_LOG"
sleep 60 &
pid=$!
wait "$pid"
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startSetupKuma(version = "1.23.17"): Promise<{
  port: number;
  connected: Promise<void>;
  close: () => Promise<void>;
}> {
  const http = createServer();
  const sockets = new Set<Socket>();
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  let markConnected!: () => void;
  const connected = new Promise<void>((r) => {
    markConnected = r;
  });
  const setupDelay = Number(process.env.FAKE_SETUP_DELAY_MS ?? "0");
  const io = new Server(http);
  io.on("connection", (socket) => {
    markConnected();
    socket.emit("info", {});
    socket.on("needSetup", (ack: (v: boolean) => void) => setTimeout(() => ack(true), setupDelay));
    socket.on("setup", (_u: unknown, _p: unknown, ack: (v: unknown) => void) => ack({ ok: true }));
    socket.on("login", (_c: unknown, ack: (v: unknown) => void) => {
      ack({ ok: true });
      socket.emit("info", { version });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  return {
    port,
    connected,
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
  writeFileSync(join(bin, "build-grandchild"), FAKE_BUILD_GRANDCHILD, { mode: 0o755 });
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
      FAKE_BUILD_GRANDCHILD: join(bin, "build-grandchild"),
      TMPDIR: sb.dir,
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

// kill(pid, 0) also succeeds for a zombie, and a SIGKILLed grandchild
// reparented to a non-reaping init would look alive forever — treat the Z
// state as gone and poll briefly for the reap.
async function processGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    if (stat.startsWith("Z")) return true;
    await sleep(100);
  }
  return false;
}

describe("scripts/integration.ts signal handling", () => {
  let sb: Sandbox;
  let kuma: { port: number; connected: Promise<void>; close: () => Promise<void> };
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
    runner = startRunner(sb, kuma.port, { FAKE_UP_SLEEP: "60" });
    await waitForLog(runner.log, "up armed");
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "up -d --wait")).toBe(1);
    expect(countLines(log, "down -v")).toBe(2);
    const termed = log.indexOf("up termed");
    const lastDown = log.lastIndexOf("down -v");
    expect(termed).toBeGreaterThan(-1);
    expect(lastDown).toBeGreaterThan(termed);
    expect(log).not.toContain("bun-test-child");
  }, 30_000);

  test("SIGINT during the pre-up down -v skips up and still tears down", async () => {
    runner = startRunner(sb, kuma.port, {
      FAKE_DOWN_SLEEP_AT: "1",
      FAKE_DOWN_SLEEP: "60",
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

  test("SIGINT during the build kills its process group and still tears down", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_BUILD_SLEEP: "60" });
    await waitForLog(runner.log, "grandchild started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    // Only a process-group kill reaches the compile grandchild; a plain
    // kill() on the build wrapper would leave it running.
    expect(log).toContain("grandchild termed");
    expect(log).not.toContain("up -d --wait");
    expect(log).not.toContain("bun-test-child");
    expect(countLines(log, "down -v")).toBe(1);
  }, 30_000);

  test("SIGINT during the build leaves no grandchild behind when it ignores SIGTERM", async () => {
    const pidFile = join(sb.dir, "grandchild.pid");
    runner = startRunner(sb, kuma.port, {
      FAKE_BUILD_SLEEP: "60",
      FAKE_GC_IGNORE_TERM: "1",
      FAKE_GC_PIDFILE: pidFile,
    });
    await waitForLog(runner.log, "grandchild started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    expect(log).not.toContain("up -d --wait");
    expect(countLines(log, "down -v")).toBe(1);
    // The wrapper's exited resolves while the TERM-ignoring grandchild is
    // still alive; only the post-exit group SIGKILL sweep can end it.
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await processGone(gcPid)).toBe(true);
  }, 30_000);

  test("SIGTERM during the final down -v retries teardown and exits 143", async () => {
    runner = startRunner(sb, kuma.port, {
      FAKE_DOWN_SLEEP_AT: "2",
      FAKE_DOWN_SLEEP: "60",
    });
    await waitForCount(runner.log, "down -v", 2);
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "down -v")).toBe(3);
    expect(log.indexOf("bun-test-child ran")).toBeLessThan(log.lastIndexOf("down -v"));
  }, 30_000);

  test("SIGINT escalates to SIGKILL when the test child ignores SIGTERM", async () => {
    const start = Date.now();
    runner = startRunner(sb, kuma.port, {
      FAKE_TEST_HANG: "1",
      FAKE_TEST_IGNORE_TERM: "1",
    });
    await waitForLog(runner.log, "bun-test-child started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    // The 5 s grace period must elapse before SIGKILL ends the child.
    expect(Date.now() - start).toBeGreaterThanOrEqual(4_000);
    const log = readFileSync(runner.log, "utf8");
    expect(log).not.toContain("bun-test-child termed");
    expect(countLines(log, "down -v")).toBe(2);
  }, 30_000);

  test("SIGTERM during setupKuma skips the test run and still tears down", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_SETUP_DELAY_MS: "2000" });
    await kuma.connected;
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    const log = readFileSync(runner.log, "utf8");
    expect(log).toContain("up -d --wait");
    expect(log).not.toContain("bun-test-child");
    expect(countLines(log, "down -v")).toBe(2);
    expect(await runner.output()).not.toContain("Kuma 1.23.17 ready");
  }, 30_000);

  test("UPTIME_KUMA_IT_KEEP=1 leaves the project up even on SIGINT", async () => {
    runner = startRunner(sb, kuma.port, { UPTIME_KUMA_IT_KEEP: "1", FAKE_TEST_HANG: "1" });
    await waitForLog(runner.log, "bun-test-child started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    // Only the pre-up cleanup ran; the final teardown is skipped by KEEP.
    expect(countLines(log, "down -v")).toBe(1);
    expect(log).toContain("bun-test-child termed");
    expect(await runner.output()).toContain("UPTIME_KUMA_IT_KEEP=1");
  }, 30_000);

  test("UPTIME_KUMA_IT_KEEP=1 during the build still leaves no grandchild behind", async () => {
    const pidFile = join(sb.dir, "grandchild.pid");
    runner = startRunner(sb, kuma.port, {
      UPTIME_KUMA_IT_KEEP: "1",
      FAKE_BUILD_SLEEP: "60",
      FAKE_GC_IGNORE_TERM: "1",
      FAKE_GC_PIDFILE: pidFile,
    });
    await waitForLog(runner.log, "grandchild started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const log = readFileSync(runner.log, "utf8");
    expect(log).not.toContain("up -d --wait");
    // The signal landed during the build: the pre-up down never ran and
    // KEEP skips the teardown, so no down -v appears at all.
    expect(countLines(log, "down -v")).toBe(0);
    // KEEP resolves teardown instantly, so the main finally could exit
    // before the signal path's group sweep unless both await it.
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await processGone(gcPid)).toBe(true);
  }, 30_000);

  test("a second signal during build cleanup cannot cut the grandchild sweep short", async () => {
    const pidFile = join(sb.dir, "grandchild.pid");
    runner = startRunner(sb, kuma.port, {
      UPTIME_KUMA_IT_KEEP: "1",
      FAKE_BUILD_SLEEP: "60",
      FAKE_GC_IGNORE_TERM: "1",
      FAKE_GC_PIDFILE: pidFile,
    });
    await waitForLog(runner.log, "grandchild started");
    runner.proc.kill("SIGINT");
    // Land the second signal while the first cleanup is still inside the
    // grace-period poll for the TERM-ignoring grandchild.
    await sleep(200);
    runner.proc.kill("SIGTERM");
    expect(await runner.exited).toBe(130);
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await processGone(gcPid)).toBe(true);
  }, 30_000);

  test("SIGINT during bun test leaves no test grandchild behind", async () => {
    const pidFile = join(sb.dir, "grandchild.pid");
    runner = startRunner(sb, kuma.port, {
      FAKE_TEST_HANG: "1",
      FAKE_TEST_GC: "1",
      FAKE_GC_IGNORE_TERM: "1",
      FAKE_GC_PIDFILE: pidFile,
    });
    await waitForLog(runner.log, "grandchild started");
    runner.proc.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await processGone(gcPid)).toBe(true);
  }, 30_000);

  test("an invalid UPTIME_KUMA_IT_DOWN_TIMEOUT_MS fails fast", async () => {
    runner = startRunner(sb, kuma.port, { UPTIME_KUMA_IT_DOWN_TIMEOUT_MS: "abc" });
    expect(await runner.exited).toBe(1);
    expect(await runner.output()).toContain("UPTIME_KUMA_IT_DOWN_TIMEOUT_MS");
  }, 30_000);

  // A sharded run reads timings.json for balancing but must not rewrite
  // it: --update-timings under --shard keeps only that shard's entries
  // and would shrink the table the next run splits by — even on a 2.x
  // image, the only version whose runs may refresh the table
  test("UPTIME_KUMA_IT_SHARD forwards --shard and reads timings without rewriting them", async () => {
    const kuma2 = await startSetupKuma("2.5.11");
    try {
      runner = startRunner(sb, kuma2.port, {
        UPTIME_KUMA_IT_IMAGE: "louislam/uptime-kuma:2.5.11",
        UPTIME_KUMA_IT_SHARD: "2/3",
      });
      await waitForLog(runner.log, "bun-test-child ran");
      const bunTest = readFileSync(runner.log, "utf8")
        .split("\n")
        .find((l) => l.startsWith("bun test "));
      expect(bunTest).toContain("tests/integration --shard=2/3 --timings=");
      expect(bunTest).not.toContain("--update-timings");
      expect(await runner.exited).toBe(0);
      expect(await runner.output()).toContain("bun test bound: 20 minutes");
    } finally {
      await kuma2.close();
    }
  }, 30_000);

  // "1/1" is a valid spec that bun runs as a single all-file slice;
  // it forwards like any shard and the bound treats it as unsharded
  test("UPTIME_KUMA_IT_SHARD=1/1 forwards --shard=1/1", async () => {
    runner = startRunner(sb, kuma.port, { UPTIME_KUMA_IT_SHARD: "1/1" });
    await waitForLog(runner.log, "bun-test-child ran");
    const bunTest = readFileSync(runner.log, "utf8")
      .split("\n")
      .find((l) => l.startsWith("bun test "));
    expect(bunTest).toContain("tests/integration --shard=1/1 --timings=");
    expect(bunTest).not.toContain("--update-timings");
    expect(await runner.exited).toBe(0);
    expect(await runner.output()).toContain("bun test bound: 35 minutes");
  }, 30_000);

  // --update-timings rides only an unsharded run on a 2.x image: it is
  // what refreshes tests/integration/timings.json for the next CI
  // split, and the table holds 2.x-measured durations
  test("an unsharded run on a 2.x image records and updates timings", async () => {
    const kuma2 = await startSetupKuma("2.5.11");
    try {
      runner = startRunner(sb, kuma2.port, {
        UPTIME_KUMA_IT_IMAGE: "louislam/uptime-kuma:2.5.11",
      });
      await waitForLog(runner.log, "bun-test-child ran");
      const bunTest = readFileSync(runner.log, "utf8")
        .split("\n")
        .find((l) => l.startsWith("bun test "));
      expect(bunTest).not.toContain("--shard=");
      expect(bunTest).toContain("--update-timings");
      expect(await runner.exited).toBe(0);
      expect(await runner.output()).toContain("bun test bound: 35 minutes");
    } finally {
      await kuma2.close();
    }
  }, 30_000);

  // The default image is 1.x: an unsharded run there must not rewrite
  // the 2.x-measured timings.json and leave the tree dirty
  test("an unsharded run on the default 1.x image skips the timings refresh", async () => {
    runner = startRunner(sb, kuma.port, {});
    await waitForLog(runner.log, "bun-test-child ran");
    const bunTest = readFileSync(runner.log, "utf8")
      .split("\n")
      .find((l) => l.startsWith("bun test "));
    expect(bunTest).not.toContain("--shard=");
    expect(bunTest).not.toContain("--update-timings");
    expect(bunTest).toContain("--timings=");
    expect(await runner.exited).toBe(0);
    const out = await runner.output();
    expect(out).toContain("not refreshing timings.json");
    expect(out).toContain("bun test bound: 35 minutes");
  }, 30_000);

  test("invalid UPTIME_KUMA_IT_SHARD values fail fast", async () => {
    for (const shard of ["", "bogus", "3/2", "0/2"]) {
      runner = startRunner(sb, kuma.port, { UPTIME_KUMA_IT_SHARD: shard });
      expect(await runner.exited).toBe(1);
      expect(await runner.output()).toContain("UPTIME_KUMA_IT_SHARD");
    }
  }, 30_000);

  test("a timed-out down -v is reaped before the next compose call", async () => {
    runner = startRunner(sb, kuma.port, {
      UPTIME_KUMA_IT_DOWN_TIMEOUT_MS: "200",
      FAKE_DOWN_IGNORE_TERM_AT: "1",
    });
    // The first down ignores SIGTERM, so the timeout's kill only ends it
    // after the 5 s grace escalates to SIGKILL; the run continues to `up`
    // and the final teardown issues the second down.
    await waitForCount(runner.log, "down -v", 1);
    const killedAt = Date.now();
    await waitForCount(runner.log, "down -v", 2);
    const gap = Date.now() - killedAt;
    expect(await runner.exited).toBe(0);
    const log = readFileSync(runner.log, "utf8");
    expect(countLines(log, "down -v")).toBe(2);
    // Without awaiting the killed child's exited, the next compose call
    // would start ~200 ms after the timeout, not after the SIGKILL reap.
    expect(gap).toBeGreaterThanOrEqual(4_000);
  }, 30_000);

  test("a down -v that keeps failing exits 1 after the retries", async () => {
    runner = startRunner(sb, kuma.port, { FAKE_DOWN_FAIL_ALWAYS: "1" });
    expect(await runner.exited).toBe(1);
    const log = readFileSync(runner.log, "utf8");
    // 1 pre-up attempt + 3 teardown attempts, all refused by the fake.
    expect(countLines(log, "down -v")).toBe(4);
    expect(log).toContain("bun-test-child ran");
    expect(await runner.output()).toContain("could not remove the compose project");
  }, 30_000);
});

// scripts/integration-limit.ts picks the suite bound from the shard
// spec's slice count; the shard bound must also outlast the suite's
// largest per-test timeout — login.test.ts's 2FA test budgets 780s
// and can start ~2.6 minutes into its shard — and the whole-suite bound
// must outlast the measured total minus login.test.ts's share plus
// that file's whole timeout budget, the worst legitimate case the
// timings.json refresh run lives under, or the runner kills a
// slow-but-legitimate run before the test's own timeout and its
// finally cleanup
describe("scripts/integration-limit.ts", () => {
  const IT_DIR = join(REPO, "tests", "integration");
  const timeoutArgs = (path: string) =>
    [...readFileSync(path, "utf8").matchAll(/\},\s*([\d_]+)\);/g)].map((m) =>
      Number(m[1]!.replaceAll("_", "")),
    );
  const maxTestTimeout = () =>
    Math.max(
      ...readdirSync(IT_DIR)
        .filter((f) => f.endsWith(".test.ts"))
        .flatMap((f) => timeoutArgs(join(IT_DIR, f))),
    );
  const timings = () =>
    (
      JSON.parse(readFileSync(join(IT_DIR, "timings.json"), "utf8")) as {
        files: Record<string, number>;
      }
    ).files;

  test("a three-slice shard run gets the per-shard bound", () => {
    expect(testLimitMs("2/3")).toBe(1_200_000);
    expect(testLimitMs("3/4")).toBe(1_200_000);
    expect(SHARD_TEST_LIMIT_MS).toBe(1_200_000);
  });

  // "1/1" passes shard validation and bun runs every file as one
  // slice; n <= 2 leaves slices bigger than any the shard bound was
  // sized against, so those specs — and an unset one — keep the
  // whole-suite bound
  test("whole-suite and coarse-slice runs keep the whole-suite bound", () => {
    expect(testLimitMs(undefined)).toBe(2_100_000);
    expect(testLimitMs("1/1")).toBe(2_100_000);
    expect(testLimitMs("1/2")).toBe(2_100_000);
    expect(testLimitMs("2/2")).toBe(2_100_000);
    expect(UNSHARDED_TEST_LIMIT_MS).toBe(2_100_000);
  });

  // login.test.ts's 2FA test declares the suite's largest budget; a
  // bound below it would kill the shard before the test's own timeout
  // fires and its finally cleanup runs
  test("the shard bound outlasts the largest per-test timeout in the suite", () => {
    expect(maxTestTimeout()).toBe(780_000);
    expect(SHARD_TEST_LIMIT_MS).toBeGreaterThan(maxTestTimeout());
  });

  // an unsharded run places every file end to end, so its worst
  // legitimate case is the measured total minus login.test.ts's
  // share plus that file's whole declared timeout budget — the 2FA
  // test's 780s and the wrong-password test's 120s back to back —
  // and the timings.json refresh run lives under this bound
  test("the whole-suite bound outlasts the suite's worst legitimate case", () => {
    const nonLogin = Object.entries(timings())
      .filter(([f]) => f !== "tests/integration/login.test.ts")
      .reduce((a, [, v]) => a + v, 0);
    const loginBudget = timeoutArgs(join(IT_DIR, "login.test.ts")).reduce((a, b) => a + b, 0);
    expect(UNSHARDED_TEST_LIMIT_MS).toBeGreaterThan(nonLogin + loginBudget);
  });

  // bun merges --update-timings into the existing table, so entries
  // for deleted or renamed files would linger and inflate the total
  // above — pin the table to exactly the files the suite has
  test("timings.json covers exactly the integration test files", () => {
    const expected = readdirSync(IT_DIR)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `tests/integration/${f}`)
      .sort();
    expect(Object.keys(timings()).sort()).toEqual(expected);
  });
});
