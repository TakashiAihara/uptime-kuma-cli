/**
 * Runs the integration tests in tests/integration against a real Uptime Kuma.
 *
 *   bun scripts/integration.ts
 *
 * Starts louislam/uptime-kuma:1.23.17 from tests/integration/compose.yaml on
 * 127.0.0.1:${UPTIME_KUMA_IT_PORT:-3901}, creates the first-run admin over
 * Socket.IO, then runs `bun test tests/integration` with UPTIME_KUMA_IT_*
 * pointing at it. The compose project is always torn down afterwards
 * (`down -v`, which also removes the anonymous data volume, so the next run
 * starts empty) unless UPTIME_KUMA_IT_KEEP=1.
 */
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";

const REPO_ROOT = join(import.meta.dir, "..");
const COMPOSE_FILE = join(REPO_ROOT, "tests", "integration", "compose.yaml");
const PROJECT = "uptime-kuma-cli-it";
const PORT = process.env.UPTIME_KUMA_IT_PORT ?? "3901";
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Throwaway admin in a disposable container, not a secret
const USERNAME = "it-admin";
const PASSWORD = "it-Passw0rd-1234";

const POLL_MS = 1_000;
const FETCH_TIMEOUT_MS = 5_000;
const WAIT_LIMIT_MS = 120_000;
const CALL_TIMEOUT_MS = 30_000;
const COMPOSE_UP_TIMEOUT_MS = 300_000;
const COMPOSE_DOWN_TIMEOUT_MS = 60_000;
const TEST_LIMIT_MS = 15 * 60_000;
const KEEP = process.env.UPTIME_KUMA_IT_KEEP === "1";

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

async function waitForKuma(): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the server is up; setup state does not matter here
      await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `Kuma did not answer at ${BASE_URL}/ within ${WAIT_LIMIT_MS / 1000}s (${lastError})`,
  );
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

async function setupKuma(): Promise<void> {
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    reconnection: false,
    timeout: CALL_TIMEOUT_MS,
  });
  try {
    // Kuma registers its socket handlers only after awaiting sendInfo(), and
    // info is the last thing sendInfo emits, so waiting for it means the
    // handlers exist (louislam/uptime-kuma#7710).
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
    console.log(`Kuma setup complete at ${BASE_URL}`);
  } finally {
    socket.disconnect();
  }
}

async function runTests(): Promise<number> {
  console.log("running bun test tests/integration");
  const proc = Bun.spawn(["bun", "test", "tests/integration"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      UPTIME_KUMA_IT_URL: BASE_URL,
      UPTIME_KUMA_IT_USERNAME: USERNAME,
      UPTIME_KUMA_IT_PASSWORD: PASSWORD,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await Promise.race([
    proc.exited,
    sleep(TEST_LIMIT_MS).then(() => {
      proc.kill();
      return -1;
    }),
  ]);
  if (code === -1) console.error(`test run exceeded ${TEST_LIMIT_MS / 60_000} minutes`);
  return code === -1 ? 1 : code;
}

let tornDown = false;
async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  if (KEEP) {
    console.log("UPTIME_KUMA_IT_KEEP=1: leaving the compose project up");
    return;
  }
  try {
    const code = await compose(["down", "-v"], COMPOSE_DOWN_TIMEOUT_MS);
    if (code !== 0) console.error(`docker compose down -v exited ${code}`);
  } catch (e) {
    console.error(`docker compose down -v failed: ${e instanceof Error ? e.message : e}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`\nreceived ${signal}, tearing down`);
    void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

let exitCode = 1;
try {
  if ((await compose(["up", "-d"], COMPOSE_UP_TIMEOUT_MS)) !== 0) {
    console.error("docker compose up -d failed");
  } else {
    await waitForKuma();
    await setupKuma();
    exitCode = await runTests();
  }
} catch (e) {
  console.error(`integration setup failed: ${e instanceof Error ? e.message : e}`);
  exitCode = 1;
} finally {
  await teardown();
}
process.exit(exitCode);
