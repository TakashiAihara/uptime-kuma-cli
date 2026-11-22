/**
 * Runs the integration tests in tests/integration against a real Uptime Kuma.
 *
 *   bun scripts/integration.ts
 *
 * Starts the image in UPTIME_KUMA_IT_IMAGE (default
 * louislam/uptime-kuma:1.23.17) from tests/integration/compose.yaml on
 * 127.0.0.1:${UPTIME_KUMA_IT_PORT:-3901} — the compose file sets
 * UPTIME_KUMA_DB_TYPE=sqlite, which 2.x needs to pick its database — creates
 * the first-run admin over Socket.IO, builds the host binary with
 * scripts/build.ts, then runs `bun test tests/integration` with
 * UPTIME_KUMA_IT_* pointing at it and UPTIME_KUMA_IT_BIN at that binary, so
 * the suite exercises the compiled artifact rather than only runCli.
 * UPTIME_KUMA_IT_SHARD="<i>/<n>" forwards the spec to `bun test --shard` so
 * CI legs each run a slice of the file list; --timings reads the measured
 * per-file durations in tests/integration/timings.json to balance the
 * split by time rather than file count, and unsharded runs add
 * --update-timings to refresh that file (a sharded write would keep only
 * the shard's own entries).
 * `down -v` (which also removes the
 * anonymous data volume) always runs before `up`, clearing a project left by
 * UPTIME_KUMA_IT_KEEP=1 or a killed run when the port matches — the project
 * name includes the port. UPTIME_KUMA_IT_KEEP=1 skips only the teardown
 * after the run.
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io, type Socket } from "socket.io-client";

import { testLimitMs } from "./integration-limit.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const COMPOSE_FILE = join(REPO_ROOT, "tests", "integration", "compose.yaml");
const TIMINGS_FILE = join(REPO_ROOT, "tests", "integration", "timings.json");
const PORT = process.env.UPTIME_KUMA_IT_PORT || "3901";
const PROJECT = `uptime-kuma-cli-it-${PORT}`;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Throwaway admin in a disposable container, not a secret
const USERNAME = "it-admin";
const PASSWORD = "it-Passw0rd-1234";

const CALL_TIMEOUT_MS = 30_000;
const COMPOSE_UP_TIMEOUT_MS = 300_000;
// Overridable so tests can reach the timeout path without waiting a minute.
// setTimeout overflows above 2^31-1 and fires after ~1ms, so the bound is
// the timer's own range, not just "positive" — the same check
// UPTIME_KUMA_IT_BIN_TIMEOUT_MS gets in tests/helpers/run.ts.
const DOWN_TIMEOUT_ENV = process.env.UPTIME_KUMA_IT_DOWN_TIMEOUT_MS;
const COMPOSE_DOWN_TIMEOUT_MS = DOWN_TIMEOUT_ENV === undefined ? 60_000 : Number(DOWN_TIMEOUT_ENV);
if (
  DOWN_TIMEOUT_ENV !== undefined &&
  (!Number.isInteger(COMPOSE_DOWN_TIMEOUT_MS) ||
    COMPOSE_DOWN_TIMEOUT_MS <= 0 ||
    COMPOSE_DOWN_TIMEOUT_MS > 2_147_483_647)
) {
  console.error(
    `UPTIME_KUMA_IT_DOWN_TIMEOUT_MS must be an integer between 1 and 2147483647, got "${DOWN_TIMEOUT_ENV}"`,
  );
  process.exit(1);
}
// A signalled `down -v` exits non-zero (Ctrl-C reaches it through the shared
// process group), so teardown retries: the next attempt usually finishes the
// removal the signal interrupted.
const TEARDOWN_ATTEMPTS = 3;
// Children a signal kills get this long to exit before SIGKILL.
const KILL_GRACE_MS = 5_000;

const KEEP = process.env.UPTIME_KUMA_IT_KEEP === "1";
// An empty value (a mistyped CI matrix key) would make compose fall back to
// 1.23.17 while the job claims another image.
if (process.env.UPTIME_KUMA_IT_IMAGE === "") {
  console.error("UPTIME_KUMA_IT_IMAGE is set but empty");
  process.exit(1);
}
// The major version an image tag names, or undefined for tags like `latest`.
const IMAGE_MAJOR = /:(\d+)(?=[.\-@]|$)/.exec(process.env.UPTIME_KUMA_IT_IMAGE ?? "")?.[1];

// UPTIME_KUMA_IT_SHARD is bun's --shard spec ("<i>/<n>"); unset runs every
// file. An empty value is a mistyped CI matrix key, and a malformed or
// out-of-range spec would only fail deep inside `bun test` — reject both
// here like the empty image.
const SHARD_ENV = process.env.UPTIME_KUMA_IT_SHARD;
if (SHARD_ENV === "") {
  console.error("UPTIME_KUMA_IT_SHARD is set but empty");
  process.exit(1);
}
const SHARD = /^([0-9]+)\/([0-9]+)$/.exec(SHARD_ENV ?? "");
if (
  SHARD_ENV !== undefined &&
  (SHARD === null || Number(SHARD[1]) < 1 || Number(SHARD[1]) > Number(SHARD[2]))
) {
  console.error(`UPTIME_KUMA_IT_SHARD must be "<i>/<n>" with 1 <= i <= n, got "${SHARD_ENV}"`);
  process.exit(1);
}
const SHARD_SPEC = SHARD === null ? undefined : `${Number(SHARD[1])}/${Number(SHARD[2])}`;
const TEST_LIMIT_MS = testLimitMs(SHARD_SPEC);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Child = ReturnType<typeof Bun.spawn>;

// The compose child currently running, if any — tracked so a signal can kill
// it: process.exit does not reap children, and an orphaned `up` could still
// create containers after the down -v.
let composeProc: Child | undefined;

async function compose(args: string[], timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  composeProc = proc;
  try {
    // cleared when the child exits first: a pending timer would still fire
    // killChild on a pid the OS may have recycled to another process
    let timedOut = false;
    let sweep: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(proc);
      // escalates to SIGKILL after the grace if the child ignores the TERM,
      // which is what lets proc.exited settle below
      sweep = awaitChildren([proc]);
    }, timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    // the TERM→KILL sweep is awaited before the caller moves on, like the
    // signal path does — a TERM-ignoring child must not outlive the teardown
    if (timedOut) await sweep;
    return timedOut ? -1 : code;
  } finally {
    if (composeProc === proc) composeProc = undefined;
  }
}

function emitAck<T>(socket: Socket, event: string, args: unknown[], timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out during ${event}`)), timeoutMs);
    socket.emit(event, ...args, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

async function setupKuma(): Promise<string> {
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    reconnection: false,
    timeout: CALL_TIMEOUT_MS,
  });
  try {
    // 1.23 registers needSetup/setup at once; 2.5.11 registers them right
    // after awaiting the pre-login sendInfo, whose last act is emitting info.
    // Either way a received info means those handlers are listening.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out connecting to ${BASE_URL}`)),
        CALL_TIMEOUT_MS * 2,
      );
      socket.once("connect_error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`failed to connect to ${BASE_URL}: ${err.message}`));
      });
      socket.once("info", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const needSetup = await emitAck<boolean>(socket, "needSetup", [], CALL_TIMEOUT_MS);
    if (needSetup !== true) {
      throw new Error("Kuma reports setup is not needed; expected a fresh database");
    }
    const res = await emitAck<{ ok?: boolean; msg?: string }>(
      socket,
      "setup",
      [USERNAME, PASSWORD],
      CALL_TIMEOUT_MS,
    );
    if (res?.ok !== true) {
      throw new Error(`Kuma setup failed: ${res?.msg ?? "no answer"}`);
    }
    // The versioned info proves the fresh admin can log in; 2.x emits it
    // inside afterLogin before the login answer, 1.23 between the pushed
    // lists after it, so the listener must be registered before the emit.
    let version: string | undefined;
    socket.on("info", (data: unknown) => {
      const v = (data as { version?: unknown } | null | undefined)?.version;
      if (typeof v === "string") version = v;
    });
    const login = await emitAck<{ ok?: boolean; msg?: string }>(
      socket,
      "login",
      [{ username: USERNAME, password: PASSWORD, token: "" }],
      CALL_TIMEOUT_MS,
    );
    if (login?.ok !== true) {
      throw new Error(`Kuma login after setup failed: ${login?.msg ?? "no answer"}`);
    }
    const infoDeadline = Date.now() + CALL_TIMEOUT_MS;
    while (version === undefined) {
      if (Date.now() >= infoDeadline) {
        throw new Error("Kuma sent no versioned info after login");
      }
      await sleep(10);
    }
    return version;
  } finally {
    socket.disconnect();
  }
}

let testProc: Child | undefined;

async function runTests(kumaVersion: string): Promise<number> {
  const args = ["test", "tests/integration"];
  if (SHARD_SPEC !== undefined) args.push(`--shard=${SHARD_SPEC}`);
  args.push(`--timings=${TIMINGS_FILE}`);
  // --update-timings under --shard writes only that shard's files and
  // drops the rest, so shard runs read the table for balancing without
  // rewriting it; unsharded runs are what refresh it
  if (SHARD_SPEC === undefined) args.push("--update-timings");
  console.log(`running bun ${args.join(" ")}`);
  // detached gives the test run its own process group so a signal (or the
  // timeout below) reaches the compiled-binary grandchildren the suite
  // spawns, not just the bun test wrapper.
  const proc = Bun.spawn(["bun", ...args], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      UPTIME_KUMA_IT_URL: BASE_URL,
      UPTIME_KUMA_IT_USERNAME: USERNAME,
      UPTIME_KUMA_IT_PASSWORD: PASSWORD,
      UPTIME_KUMA_IT_KUMA_VERSION: kumaVersion,
      // after the ...process.env spread so an inherited value cannot point
      // the suite at a stale binary instead of the build above
      UPTIME_KUMA_IT_BIN: BIN,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  testProc = proc;
  groupKillPids.add(proc.pid);
  // the flag, not the exit code, marks a timeout: killChild's SIGTERM
  // settles proc.exited with 143, which a raced sentinel would have
  // reported without the "exceeded" message. The timer is cleared when the
  // child exits first — a pending one would fire killChild on a pid the OS
  // may have recycled to another process by then
  let timedOut = false;
  let sweep: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killChild(proc);
    sweep = awaitChildren([proc]);
  }, TEST_LIMIT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  testProc = undefined;
  if (timedOut) {
    console.error(`test run exceeded ${TEST_LIMIT_MS / 60_000} minutes`);
    // the detached group's grandchildren got the same TERM; wait out the
    // escalation like the signal path does so none outlive the teardown
    await sweep;
    return 1;
  }
  return code;
}

// Shared so the finally and a signal handler await the same down -v.
let teardownPromise: Promise<boolean> | undefined;

// Resolves false when the compose project could not be removed.
function teardown(): Promise<boolean> {
  teardownPromise ??= (async () => {
    if (KEEP) {
      console.log("UPTIME_KUMA_IT_KEEP=1: leaving the compose project up");
      return true;
    }
    for (let attempt = 1; attempt <= TEARDOWN_ATTEMPTS; attempt++) {
      try {
        const code = await compose(["down", "-v"], COMPOSE_DOWN_TIMEOUT_MS);
        if (code === 0) return true;
        console.error(`docker compose down -v exited ${code}`);
      } catch (e) {
        console.error(`docker compose down -v failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.error(
      `could not remove the compose project; delete it with: docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`,
    );
    return false;
  })();
  return teardownPromise;
}

let signalExit: number | null = null;

// Pids of children spawned detached: killing them must target the process
// group (-pid) so grandchildren — the compile under scripts/build.ts — die
// too. Tracked by pid rather than the buildProc variable because the 5s
// SIGKILL escalation can fire after main cleared buildProc, and a detached
// child's exited resolves when the wrapper dies while a TERM-ignoring
// grandchild would linger.
const groupKillPids = new Set<number>();

// Waits for children a signal or a timeout killed, escalating to SIGKILL
// after the grace period so one that ignores SIGTERM cannot outlive the
// teardown and keep creating containers next to the down -v.
async function awaitChildren(children: Child[]): Promise<void> {
  if (children.length === 0) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  await Promise.race([
    Promise.all(children.map((c) => c.exited)),
    sleep(KILL_GRACE_MS).then(() =>
      Promise.all(
        children.map((c) => {
          killChild(c, "SIGKILL");
          return c.exited;
        }),
      ),
    ),
  ]);
  // exited only covers the tracked child itself: a detached group's
  // grandchildren got the same SIGTERM and deserve the rest of the grace
  // period, then whatever group survives gets SIGKILL.
  for (const c of children) {
    if (!groupKillPids.has(c.pid)) continue;
    while (groupAlive(c.pid) && Date.now() < deadline) await sleep(50);
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// The build child runs detached in its own process group so signalling it
// also reaches the compile grandchildren scripts/build.ts spawns; the other
// children share this process group, where a plain kill() is enough.
function killChild(child: Child, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  if (groupKillPids.has(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // the group is already gone
    }
  }
  child.kill(signal);
}

// The signal path's child sweep + teardown + scratch-dir removal, shared
// with the main finally: with KEEP=1 the teardown resolves instantly, so
// without this the main flow's process.exit could cut the sweep off and
// leave a TERM-ignoring grandchild behind.
let signalCleanup: Promise<void> | undefined;

// Waits for the children a signal killed, then runs the shared teardown and
// exits. The main flow reaches the same cleanup through its finally; the
// first process.exit wins, and both report the first signal's code.
async function exitAfterTeardown(code: number, children: Child[]): Promise<void> {
  // The first signal owns the cleanup; a second one only awaits it — its
  // children were already killed individually by the handler, and
  // overwriting the promise would let this path exit before the first
  // cleanup's child sweep finishes.
  signalCleanup ??= (async () => {
    await awaitChildren(children);
    await teardown();
    rmSync(buildDir, { recursive: true, force: true });
  })();
  await signalCleanup;
  process.exit(signalExit ?? code);
}

// The suite runs the compiled binary, so the host target is built before
// anything else — a compile error should not wait behind a multi-minute image
// pull. It builds in a scratch dir rather than dist/: UPTIME_KUMA_IT_PORT
// exists so parallel runs can share a checkout, and a fixed outfile would let
// one run rewrite the binary another is executing (or clobber a local
// RELEASE_TAG build). Target names mirror TARGETS in scripts/build.ts; a host
// outside them (windows, 32-bit linux) has no runnable binary.
const HOST_TARGET = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(HOST_TARGET)) {
  console.error(`no release target for ${HOST_TARGET}`);
  process.exit(1);
}
const buildDir = mkdtempSync(join(tmpdir(), "uptime-kuma-cli-it-build-"));
// Handlers go up as soon as there is something to clean: a signal during the
// build would otherwise kill the parent outright and leak the scratch dir.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const code = signal === "SIGINT" ? 130 : 143;
    signalExit ??= code;
    console.error(`\nreceived ${signal}, tearing down`);
    // Kill what the main flow may be waiting on so its awaits resolve; the
    // exit path then waits for them before teardown, so nothing (like `up`)
    // keeps working while the down -v runs.
    const children = [testProc, composeProc, buildProc].filter((p): p is Child => p !== undefined);
    for (const child of children) killChild(child);
    void exitAfterTeardown(code, children);
  });
}
for (const name of ["src", "package.json", "node_modules"]) {
  symlinkSync(join(REPO_ROOT, name), join(buildDir, name));
}
console.log(`building uptime-kuma-cli-${HOST_TARGET}`);
// spawn, not spawnSync: the event loop must stay free so the signal
// handlers can kill a hung build through buildProc like the other children.
// detached gives the build its own process group so killChild can reach the
// compile grandchildren scripts/build.ts spawns.
let buildProc: Child | undefined;
const build = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "build.ts"), HOST_TARGET], {
  cwd: buildDir,
  stdout: "inherit",
  stderr: "inherit",
  detached: true,
});
buildProc = build;
groupKillPids.add(build.pid);
await build.exited;
buildProc = undefined;
// A null exitCode means the build child died to a signal — in practice
// Ctrl+C hitting the whole foreground group — so report 130, not 1. When a
// handled signal already started the teardown, let it own the exit instead.
if (build.exitCode !== 0 && signalExit === null) {
  rmSync(buildDir, { recursive: true, force: true });
  process.exit(build.exitCode ?? 130);
}
const BIN = join(buildDir, "dist", `uptime-kuma-cli-${HOST_TARGET}`);

let exitCode = 1;
try {
  // Remove what a KEEP=1 or killed run left behind; the result does not
  // matter — but only when no signal already started the teardown, whose
  // own down -v must not overlap this one.
  if (signalExit === null) {
    await compose(["down", "-v"], COMPOSE_DOWN_TIMEOUT_MS);
  }
  // A signal during the build fires its handler at the build await; bail
  // before compose up so the handler's exit cannot orphan the up child. The
  // flag is re-checked after every await: a signal kills the in-flight
  // compose child, and nothing may start the next phase behind the teardown.
  if (signalExit === null) {
    const upCode = await compose(
      ["up", "-d", "--wait", "--wait-timeout", "120"],
      COMPOSE_UP_TIMEOUT_MS,
    );
    if (signalExit === null) {
      if (upCode !== 0) {
        console.error("docker compose up failed");
        console.error("--- Kuma server log (compose up failed) ---");
        await compose(["logs", "--no-color", "--timestamps"], COMPOSE_DOWN_TIMEOUT_MS);
      } else {
        const version = await setupKuma();
        if (signalExit === null) {
          console.log(`Kuma ${version} ready at ${BASE_URL}`);
          // A CI job that names 2.5.11 must not go green on 1.23 if the image
          // variable stops reaching compose.
          if (IMAGE_MAJOR !== undefined && version.split(".")[0] !== IMAGE_MAJOR) {
            throw new Error(
              `UPTIME_KUMA_IT_IMAGE names ${IMAGE_MAJOR}.x but Kuma reports ${version}`,
            );
          }
          exitCode = await runTests(version);
          // The server's side of a failure (what it was doing while a call
          // timed out) is gone after down -v, so print its log while the
          // container lives.
          if (exitCode !== 0 && signalExit === null) {
            console.error("--- Kuma server log (tests failed) ---");
            await compose(["logs", "--no-color", "--timestamps"], COMPOSE_DOWN_TIMEOUT_MS);
          }
        }
      }
    }
  }
} catch (e) {
  console.error(`integration setup failed: ${e instanceof Error ? e.message : e}`);
  exitCode = 1;
  // a setup that timed out during login is the same #52 symptom
  if (signalExit === null) {
    console.error("--- Kuma server log (setup failed) ---");
    await compose(["logs", "--no-color", "--timestamps"], COMPOSE_DOWN_TIMEOUT_MS);
  }
} finally {
  if (signalCleanup === undefined) {
    rmSync(buildDir, { recursive: true, force: true });
    if (!(await teardown()) && exitCode === 0) exitCode = 1;
  }
  // Covers a signal that arrived while the normal teardown above ran: its
  // cleanup still has to finish (child sweep included) before this exit.
  await signalCleanup;
}
process.exit(signalExit ?? exitCode);
