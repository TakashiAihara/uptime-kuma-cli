import { io, type Socket } from "socket.io-client";
import { parseMajorVersion } from "../../src/kuma";
import { run, type Result, type Sandbox } from "../helpers/run";

// Tests that 2.x breaks until the named issue lands are skipped with
// skipIf(on2x); the fix removes the skip.
export const on2x = parseMajorVersion(process.env.UPTIME_KUMA_IT_KUMA_VERSION) >= 2;

// Every CLI invocation logs in once and Kuma 1.23 allows 20 logins per minute
// for the whole instance, so invocation starts are paced to stay under it.
const WINDOW_MS = 60_000;
const MAX_STARTS_PER_WINDOW = 15;
const starts: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function itEnv(): Record<string, string> {
  return {
    UPTIME_KUMA_URL: process.env.UPTIME_KUMA_IT_URL ?? "",
    UPTIME_KUMA_USERNAME: process.env.UPTIME_KUMA_IT_USERNAME ?? "",
    UPTIME_KUMA_PASSWORD: process.env.UPTIME_KUMA_IT_PASSWORD ?? "",
    UPTIME_KUMA_TIMEOUT: "20",
  };
}

export async function cliRun(
  sb: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<Result> {
  for (;;) {
    const now = Date.now();
    while (starts.length > 0 && now - starts[0]! >= WINDOW_MS) starts.shift();
    if (starts.length < MAX_STARTS_PER_WINDOW) {
      starts.push(now);
      break;
    }
    await sleep(starts[0]! + WINDOW_MS - now + 20);
  }
  const r = await run(sb, args, { ...itEnv(), ...env });
  // A failing assert only shows the exit code; the CLI's message is the
  // evidence, and the CI log is the only place it can be read afterwards.
  if (r.code !== 0) {
    console.error(
      `[cliRun] ${args.join(" ")} exited ${r.code} at ${new Date().toISOString()}: ${r.stderr.trim()}`,
    );
  }
  return r;
}

const SOCKET_TIMEOUT_MS = 30_000;

function emitAck<T>(socket: Socket, event: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out during ${event}`)),
      SOCKET_TIMEOUT_MS,
    );
    socket.emit(event, ...args, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

// A logged-in Socket.IO session for state no CLI command can express — the
// UI's monitor custom URL reaches Kuma only as monitor_group.custom_url,
// which saveStatusPage stores from a sent monitor url.
export async function withKuma<T>(
  fn: (call: <R>(event: string, args?: unknown[]) => Promise<R>) => Promise<T>,
): Promise<T> {
  const socket = io(process.env.UPTIME_KUMA_IT_URL ?? "", {
    transports: ["websocket"],
    reconnection: false,
    timeout: SOCKET_TIMEOUT_MS,
  });
  try {
    // 2.x registers its login listener only after the pre-login sendInfo,
    // whose last act is emitting info; 1.23 emits it right away too
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for info")),
        SOCKET_TIMEOUT_MS,
      );
      socket.once("connect_error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`failed to connect: ${err.message}`));
      });
      socket.once("info", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const login = await emitAck<{ ok?: boolean; msg?: string }>(socket, "login", [
      {
        username: process.env.UPTIME_KUMA_IT_USERNAME ?? "",
        password: process.env.UPTIME_KUMA_IT_PASSWORD ?? "",
        token: "",
      },
    ]);
    if (login?.ok !== true) {
      throw new Error(`Kuma login failed: ${login?.msg ?? "no answer"}`);
    }
    return await fn((event, args = []) => emitAck(socket, event, args));
  } finally {
    socket.disconnect();
  }
}
