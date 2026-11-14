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

export function parseNonNegativeNumber(value: string, flag: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    fail(2, `${flag} must be a number of 0 or more, got "${value}"`);
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

// A secret keeps its surrounding spaces; only the CR of a CRLF ending is dropped.
export function firstSecretLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// Both secret env vars are stripped from the child's env so a username_command
// can never see the password and vice versa.
async function runSecretCommand(command: string, timeoutMs: number, name: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "UPTIME_KUMA_USERNAME" && key !== "UPTIME_KUMA_PASSWORD") {
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
