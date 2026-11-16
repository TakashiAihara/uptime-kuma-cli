/**
 * Runs the integration tests in tests/integration against a real Uptime Kuma.
 *
 *   bun scripts/integration.ts
 *
 * Starts the image in UPTIME_KUMA_IT_IMAGE (default
 * louislam/uptime-kuma:1.23.17) from tests/integration/compose.yaml on
 * 127.0.0.1:${UPTIME_KUMA_IT_PORT:-3901} — the compose file sets
 * UPTIME_KUMA_DB_TYPE=sqlite, which 2.x needs to pick its database — creates
 * the first-run admin over Socket.IO, then runs `bun test tests/integration`
 * with UPTIME_KUMA_IT_* pointing at it. `down -v` (which also removes the
 * anonymous data volume) always runs before `up`, clearing a project left by
 * UPTIME_KUMA_IT_KEEP=1 or a killed run when the port matches — the project
 * name includes the port. UPTIME_KUMA_IT_KEEP=1 skips only the teardown
 * after the run.
 */
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";

const REPO_ROOT = join(import.meta.dir, "..");
const COMPOSE_FILE = join(REPO_ROOT, "tests", "integration", "compose.yaml");
const PORT = process.env.UPTIME_KUMA_IT_PORT || "3901";
const PROJECT = `uptime-kuma-cli-it-${PORT}`;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Throwaway admin in a disposable container, not a secret
const USERNAME = "it-admin";
const PASSWORD = "it-Passw0rd-1234";

const CALL_TIMEOUT_MS = 30_000;
const COMPOSE_UP_TIMEOUT_MS = 300_000;
const COMPOSE_DOWN_TIMEOUT_MS = 60_000;
const TEST_LIMIT_MS = 8 * 60_000;
const KEEP = process.env.UPTIME_KUMA_IT_KEEP === "1";
// An empty value (a mistyped CI matrix key) would make compose fall back to
// 1.23.17 while the job claims another image.
if (process.env.UPTIME_KUMA_IT_IMAGE === "") {
  console.error("UPTIME_KUMA_IT_IMAGE is set but empty");
  process.exit(1);
}
// The major version an image tag names, or undefined for tags like `latest`.
const IMAGE_MAJOR = /:(\d+)(?=[.\-@]|$)/.exec(process.env.UPTIME_KUMA_IT_IMAGE ?? "")?.[1];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function compose(args: string[], timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return Promise.race([
    proc.exited,
    sleep(timeoutMs).then(() => {
      proc.kill();
      return -1;
    }),
  ]);
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
    // The connection handler registers needSetup/setup synchronously and emits
    // info, so a received info means those handlers are already listening
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

let testProc: ReturnType<typeof Bun.spawn> | undefined;

async function runTests(kumaVersion: string): Promise<number> {
  console.log("running bun test tests/integration");
  const proc = Bun.spawn(["bun", "test", "tests/integration"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      UPTIME_KUMA_IT_URL: BASE_URL,
      UPTIME_KUMA_IT_USERNAME: USERNAME,
      UPTIME_KUMA_IT_PASSWORD: PASSWORD,
      UPTIME_KUMA_IT_KUMA_VERSION: kumaVersion,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  testProc = proc;
  const code = await Promise.race([
    proc.exited,
    sleep(TEST_LIMIT_MS).then(() => {
      proc.kill();
      return -1;
    }),
  ]);
  testProc = undefined;
  if (code === -1) console.error(`test run exceeded ${TEST_LIMIT_MS / 60_000} minutes`);
  return code === -1 ? 1 : code;
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
    try {
      const code = await compose(["down", "-v"], COMPOSE_DOWN_TIMEOUT_MS);
      if (code !== 0) {
        console.error(`docker compose down -v exited ${code}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error(`docker compose down -v failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  })();
  return teardownPromise;
}

let signalExit: number | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const code = signal === "SIGINT" ? 130 : 143;
    signalExit ??= code;
    console.error(`\nreceived ${signal}, tearing down`);
    testProc?.kill();
    void teardown().finally(() => process.exit(code));
  });
}

let exitCode = 1;
try {
  // Remove what a KEEP=1 or killed run left behind; the result does not matter
  await compose(["down", "-v"], COMPOSE_DOWN_TIMEOUT_MS);
  if (
    (await compose(["up", "-d", "--wait", "--wait-timeout", "120"], COMPOSE_UP_TIMEOUT_MS)) !== 0
  ) {
    console.error("docker compose up failed");
  } else {
    const version = await setupKuma();
    console.log(`Kuma ${version} ready at ${BASE_URL}`);
    // A CI job that names 2.5.11 must not go green on 1.23 if the image
    // variable stops reaching compose.
    if (IMAGE_MAJOR !== undefined && version.split(".")[0] !== IMAGE_MAJOR) {
      throw new Error(`UPTIME_KUMA_IT_IMAGE names ${IMAGE_MAJOR}.x but Kuma reports ${version}`);
    }
    exitCode = await runTests(version);
    // The server's side of a failure (what it was doing while a call timed
    // out) is gone after down -v, so print its log while the container lives.
    if (exitCode !== 0) {
      console.error("--- Kuma server log (tests failed) ---");
      await compose(["logs", "--no-color", "--timestamps"], COMPOSE_DOWN_TIMEOUT_MS);
    }
  }
} catch (e) {
  console.error(`integration setup failed: ${e instanceof Error ? e.message : e}`);
  exitCode = 1;
} finally {
  if (!(await teardown()) && exitCode === 0) exitCode = 1;
}
process.exit(signalExit ?? exitCode);
