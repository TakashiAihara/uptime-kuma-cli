import { io, type Socket } from "socket.io-client";
import { parseMajorVersion, parseMinorVersion } from "../../src/kuma";
import { run, type Result, type Sandbox } from "../helpers/run";

// Tests that 2.x breaks until the named issue lands are skipped with
// skipIf(on2x); the fix removes the skip.
const itVersion = process.env.UPTIME_KUMA_IT_KUMA_VERSION;
export const on2x = parseMajorVersion(itVersion) >= 2;

// ntp.js first ships in 2.5.0 (upstream #7214), so on2x alone does not say
// the monitor type exists — a 2.0-2.4 leg must take the refusal branch too.
export const onNtp =
  parseMajorVersion(itVersion) > 2 ||
  (parseMajorVersion(itVersion) === 2 && parseMinorVersion(itVersion) >= 5);

// snmp.js exists on every released 2.x, but its v3 branch and the
// snmp_v3_username column first ship in 2.1.0 — a 2.0.x leg takes the
// field-gate refusal for a v3 add.
export const onSnmpV3 =
  parseMajorVersion(itVersion) > 2 ||
  (parseMajorVersion(itVersion) === 2 && parseMinorVersion(itVersion) >= 1);

// websocket-upgrade.js and its ws_* columns first ship in 2.1.0 — 1.x and
// 2.0.x legs take the type-gate refusal for any add or type change.
export const onWsUpgrade =
  parseMajorVersion(itVersion) > 2 ||
  (parseMajorVersion(itVersion) === 2 && parseMinorVersion(itVersion) >= 1);

// oracledb.js first ships in 2.3.0 (upstream #7156) — 1.x and 2.0-2.2 legs
// take the type-gate refusal for any add or type change.
export const onOracleDb =
  parseMajorVersion(itVersion) > 2 ||
  (parseMajorVersion(itVersion) === 2 && parseMinorVersion(itVersion) >= 3);

// deleteChildren and the incident events (getIncidentHistory / editIncident /
// resolveIncident / deleteIncident) first ship in 2.1.0 — 1.x and 2.0.x legs
// take the refusal branch for `delete --children` and the incident commands.
export const on21 =
  parseMajorVersion(itVersion) > 2 ||
  (parseMajorVersion(itVersion) === 2 && parseMinorVersion(itVersion) >= 1);

// Kuma allows 20 logins per minute for the whole instance, and a single
// invocation can spend several (a 2FA login sends a tokenless probe plus
// the token and up to two adjacent retries), so calls reserve the login
// count they can spend and the per-minute total is paced under the limit.
const WINDOW_MS = 60_000;
const MAX_LOGINS_PER_WINDOW = 15;
const reserved: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reserving several calls' logins as one block lets back-to-back calls
// spend them without a pacing wait in between — needed when the wait
// itself would change what is being measured (a TOTP window boundary).
export async function reserveLogins(logins: number): Promise<void> {
  await takeLogins(logins);
}

async function takeLogins(logins: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (reserved.length > 0 && now - reserved[0]! >= WINDOW_MS) reserved.shift();
    if (reserved.length + logins <= MAX_LOGINS_PER_WINDOW) {
      reserved.push(...Array<number>(logins).fill(now));
      break;
    }
    await sleep(reserved[0]! + WINDOW_MS - now + 20);
  }
}

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
  opts: { logins?: number } = {},
): Promise<Result> {
  await takeLogins(opts.logins ?? 1);
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
    // The socket login is a login event too; it shares the per-minute
    // budget with cliRun instead of bypassing the limiter
    await takeLogins(1);
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

// The integration admin is the only account, so 2FA coverage toggles it for
// the length of fn: prepare2FA mints a secret and returns it inside the
// otpauth uri, save2FA flips twofa_status (the emits the UI's enable-2FA
// dialog makes), and fn runs with that secret. The finally's disable2FA
// restores the tokenless login the rest of the suite needs — a left-on 2FA
// would fail every later login, so a refused answer here is rethrown over
// whatever fn itself produced.
export async function withKuma2FA<T>(fn: (secret: string) => Promise<T>): Promise<T> {
  return withKuma(async (call) => {
    const password = itEnv().UPTIME_KUMA_PASSWORD;
    const ack = async (event: "prepare2FA" | "save2FA" | "disable2FA") => {
      const res = await call<{ ok?: boolean; uri?: string; msg?: string }>(event, [password]);
      if (res?.ok !== true) throw new Error(`${event} failed: ${res?.msg ?? "no answer"}`);
      return res;
    };

    const prepared = await ack("prepare2FA");
    const secret =
      typeof prepared.uri === "string"
        ? new URLSearchParams(prepared.uri.slice(prepared.uri.indexOf("?"))).get("secret")
        : null;
    if (!secret) throw new Error("prepare2FA uri carries no secret");
    try {
      await ack("save2FA");
      return await fn(secret);
    } finally {
      await ack("disable2FA");
    }
  });
}
