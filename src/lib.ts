import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function fail(exitCode: number, message: string): never {
  throw new CliError(exitCode, message);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --set key=value: the value is JSON when it parses, else the raw string.
export function parseSets(values: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of values ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) fail(2, `--set expects key=value, got "${item}"`);
    const raw = item.slice(eq + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // not JSON: keep the raw string
    }
    out[item.slice(0, eq)] = value;
  }
  return out;
}

// Kuma sends notificationIDList as an object of truthy ids; an array only
// appears in user input such as `--set notificationIDList=[3]`. Both shapes
// normalize to the sorted list of truthy ids.
export function notificationIdArray(value: unknown): number[] {
  const ids = new Set<number>();
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n)) ids.add(n);
  };
  if (Array.isArray(value)) {
    for (const v of value) add(v);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (v) add(k);
  }
  return [...ids].sort((a, b) => a - b);
}

// The shape Kuma expects on the wire: an object of truthy ids.
export function notificationIdObject(value: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  for (const id of notificationIdArray(value)) out[String(id)] = true;
  return out;
}

export function parseId(value: string, flag: string): number {
  // Kuma ids start at 1
  if (!/^[1-9]\d*$/.test(value)) fail(2, `${flag} must be a positive integer id, got "${value}"`);
  return Number(value);
}

export function parsePositiveNumber(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    fail(2, `${flag} must be a positive number, got "${value}"`);
  }
  return n;
}

export function parsePositiveInteger(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(2, `${flag} must be a positive integer, got "${value}"`);
  }
  return n;
}

export function parseNonNegativeInteger(value: string, flag: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < 0) {
    fail(2, `${flag} must be an integer of 0 or more, got "${value}"`);
  }
  return n;
}

export function parsePort(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    fail(2, `${flag} must be a port number, got "${value}"`);
  }
  return n;
}

// Local ISO 8601 datetimes without an offset
// ("YYYY-MM-DDTHH:mm[:ss[.fff]]") — the shape the CLI's datetime flags take.
// Kuma stores such strings verbatim and reads them as local time, so an
// offset designator would be stored with the value and misparsed; the CLI
// refuses it. The calendar fields are checked directly because Date.parse
// rolls an impossible day into the next month and engines differ on T24:00.
const OFFSET_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:\d{2}|\d{2})?)$/;

const LOCAL_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

export function hasOffsetDesignator(value: string): boolean {
  return OFFSET_DATETIME.test(value);
}

// The wall-clock fields of a local datetime, for callers that re-emit the
// value in another spelling; seconds default to "00" and fraction keeps its
// leading dot or is "".
export type LocalDateTimeFields = {
  date: string;
  time: string;
  seconds: string;
  fraction: string;
};

export function localDateTimeFields(value: unknown): LocalDateTimeFields | null {
  if (typeof value !== "string") return null;
  const m = LOCAL_PARTS.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day < 1 || day > dim) return null;
  return {
    date: `${y}-${mo}-${d}`,
    time: `${h}:${mi}`,
    seconds: m[6] ?? "00",
    fraction: m[7] === undefined ? "" : `.${m[7]}`,
  };
}

export function isLocalDateTime(value: unknown): value is string {
  return localDateTimeFields(value) !== null;
}

// Ordering must not go through Date.parse: it resolves the offset-free
// strings in the CLI host's timezone, where DST can reorder local times.
// Compare the fields instead; callers run isLocalDateTime first.
export function compareLocalDateTimes(a: string, b: string): number {
  const pa = LOCAL_PARTS.exec(a);
  const pb = LOCAL_PARTS.exec(b);
  if (pa === null || pb === null) return Number.NaN;
  for (let i = 1; i <= 6; i++) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const fa = pa[7] ?? "";
  const fb = pb[7] ?? "";
  const width = Math.max(fa.length, fb.length);
  const sa = fa.padEnd(width, "0");
  const sb = fb.padEnd(width, "0");
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

export function readJsonFile(path: string, flag: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return fail(2, `${flag} ${path}: ${(e as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(2, `${flag} ${path} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(2, `${flag} ${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function readTextFile(path: string, flag: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    return fail(2, `${flag} ${path}: ${(e as Error).message}`);
  }
}

type Config = {
  url?: string;
  username_command?: string;
  password_command?: string;
  totp_command?: string;
  totp_secret_command?: string;
};

export function loadConfig(): Config {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const path = join(xdg, "uptime-kuma-cli", "config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    return fail(2, `cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    return fail(2, `cannot parse ${path}: ${(e as Error).message}`);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    url: str(parsed.url),
    username_command: str(parsed.username_command),
    password_command: str(parsed.password_command),
    totp_command: str(parsed.totp_command),
    totp_secret_command: str(parsed.totp_secret_command),
  };
}

function positiveTimeoutMs(name: string, fallbackSeconds: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallbackSeconds * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(2, `${name} must be a positive number of seconds, got "${raw}"`);
  }
  return seconds * 1000;
}

export function socketTimeoutMs(): number {
  return positiveTimeoutMs("UPTIME_KUMA_TIMEOUT", 30);
}

export function commandTimeoutMs(): number {
  return positiveTimeoutMs("UPTIME_KUMA_COMMAND_TIMEOUT", 60);
}

// shrinkDatabase's VACUUM is the one request whose server-side work Kuma does
// not bound itself, so it gets its own, longer ack budget.
export function shrinkTimeoutMs(): number {
  return positiveTimeoutMs("UPTIME_KUMA_SHRINK_TIMEOUT", 600);
}

// A secret keeps its surrounding spaces; only the CR of a CRLF ending is dropped.
export function firstSecretLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// Every secret env var is stripped from the child's env so a *_command
// can never see the password and vice versa.
async function runSecretCommand(command: string, timeoutMs: number, name: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "UPTIME_KUMA_USERNAME" &&
      key !== "UPTIME_KUMA_PASSWORD" &&
      key !== "UPTIME_KUMA_TOTP"
    ) {
      env[key] = value;
    }
  }
  // detached makes the child's pid its process group id, so a timeout can also stop grandchildren
  // (e.g. `sleep` under sh) that would otherwise hold the stdout pipe open
  const proc = Bun.spawn(["sh", "-c", command], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  }, timeoutMs);
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  // stdout may hold the secret: report only that the command failed, never its output
  if (timedOut) fail(2, `${name} timed out`);
  if (exitCode !== 0) fail(2, `${name} failed`);
  const secret = firstSecretLine(stdout);
  if (!secret) fail(2, `${name} produced no output`);
  return secret;
}

async function resolveSecret(
  envName: "UPTIME_KUMA_USERNAME" | "UPTIME_KUMA_PASSWORD",
  command: string | undefined,
  configKey: string,
  timeoutMs: number,
): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (command === undefined) {
    fail(2, `${envName} is not set (set the env var or ${configKey} in config.toml)`);
  }
  return runSecretCommand(command, timeoutMs, envName);
}

// RFC 4648 base32, case-insensitive; "=" padding and whitespace are ignored —
// Kuma's prepare2FA strips the padding from the otpauth URI secret anyway.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
  const out = Buffer.alloc(Math.floor((clean.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) {
      fail(2, "totp_secret_command produced a secret that is not base32");
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n] = (buffer >> bits) & 0xff;
      n += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (n === 0) fail(2, "totp_secret_command produced an empty base32 secret");
  return out.subarray(0, n);
}

// Kuma verifies the login token with notp.totp.verify(token, twofa_secret,
// { window: 1, time: 30 }): HMAC-SHA1 over the 30-second counter, dynamic
// truncation, then the last 6 characters of the decimal value — notp does
// not zero-pad, so a binary below 100000 yields a shorter token and the
// string compare needs the same shape. The secret users hold is the base32
// string from the otpauth URI, which decodes to the stored key.
export function totpToken(secret: string, atMs: number = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[19]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const digits = String(binary);
  return digits.slice(digits.length - 6);
}

// totp_secret_command may print the bare base32 secret or the whole
// otpauth:// URI a vault entry stores; both reduce to the secret value.
function totpSecret(output: string): string {
  const text = output.trim();
  if (!text.toLowerCase().startsWith("otpauth://")) return text;
  const raw = /[?&]secret=([^&\s#]+)/i.exec(text)?.[1];
  if (raw === undefined) {
    fail(2, "totp_secret_command printed an otpauth URI without a secret parameter");
  }
  // notp only knows SHA-1, 6 digits and 30-second periods, so a URI asking
  // for anything else would mint tokens Kuma never accepts — refuse it here
  // instead of failing later with Invalid Token.
  const kind = /^otpauth:\/\/([^/?]+)/i.exec(text)?.[1]?.toLowerCase();
  const query = text.includes("?") ? text.slice(text.indexOf("?")) : "";
  const params = new URLSearchParams(query);
  if (
    kind !== "totp" ||
    (params.get("algorithm") ?? "SHA1").toUpperCase() !== "SHA1" ||
    (params.get("digits") ?? "6") !== "6" ||
    (params.get("period") ?? "30") !== "30"
  ) {
    fail(
      2,
      "totp_secret_command printed an otpauth URI with options Kuma cannot use (needs TOTP, SHA1, 6 digits, 30 s period)",
    );
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type TotpResolution = {
  token: string;
  // Only the secret_command source can mint more tokens: Kuma rejects a
  // token equal to the last accepted one and a TOTP repeats every 30 s, so a
  // second login inside one window collides; the adjacent counters' tokens
  // still verify (Kuma's ±1 window) but differ. Next window first, then the
  // previous one, so a client clock running ahead of the server still has a
  // retry inside the server's window.
  retryTokens: string[];
};

// Called only when the server answered tokenRequired, so a configured TOTP
// source never runs for accounts without 2FA. Precedence: the env token, then
// a command that prints a ready token, then a command that prints the secret
// the CLI turns into one.
export async function resolveTotp(): Promise<TotpResolution> {
  const fromEnv = process.env.UPTIME_KUMA_TOTP?.trim();
  if (fromEnv) return { token: fromEnv, retryTokens: [] };
  const config = loadConfig();
  const timeoutMs = commandTimeoutMs();
  if (config.totp_command !== undefined) {
    const token = (await runSecretCommand(config.totp_command, timeoutMs, "totp_command")).trim();
    if (!token) fail(2, "totp_command produced no output");
    return { token, retryTokens: [] };
  }
  if (config.totp_secret_command !== undefined) {
    const output = await runSecretCommand(
      config.totp_secret_command,
      timeoutMs,
      "totp_secret_command",
    );
    const secret = totpSecret(output);
    // Mint all three from one counter: the retries are the adjacent
    // counters of the token just sent, wherever the clock is when they run.
    const counter = Math.floor(Date.now() / 30_000);
    return {
      token: totpToken(secret, counter * 30_000),
      retryTokens: [
        totpToken(secret, (counter + 1) * 30_000),
        totpToken(secret, (counter - 1) * 30_000),
      ],
    };
  }
  fail(2, "login requires a 2FA token; set UPTIME_KUMA_TOTP, totp_command or totp_secret_command");
}

export async function resolveCredentials(): Promise<{
  url: string;
  username: string;
  password: string;
}> {
  const config = loadConfig();
  const rawUrl = process.env.UPTIME_KUMA_URL || config.url;
  if (!rawUrl) {
    fail(2, "no Uptime Kuma url configured (set UPTIME_KUMA_URL or url in config.toml)");
  }
  const url = rawUrl.replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    fail(2, `Uptime Kuma url must start with http:// or https://, got "${rawUrl}"`);
  }
  const timeoutMs = commandTimeoutMs();
  const username = await resolveSecret(
    "UPTIME_KUMA_USERNAME",
    config.username_command,
    "username_command",
    timeoutMs,
  );
  const password = await resolveSecret(
    "UPTIME_KUMA_PASSWORD",
    config.password_command,
    "password_command",
    timeoutMs,
  );
  return { url, username, password };
}
