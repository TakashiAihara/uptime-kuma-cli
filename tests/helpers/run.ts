import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { runCli } from "../../src/cli.ts";

export type Result = { code: number; stdout: string; stderr: string; json: () => any };

export type Sandbox = { dir: string; xdg: string; home: string; cleanup: () => void };

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "uptime-kuma-cli-test-"));
  const xdg = join(dir, "xdg");
  const home = join(dir, "home");
  mkdirSync(xdg, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { dir, xdg, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeConfig(sb: Sandbox, toml: string) {
  const d = join(sb.xdg, "uptime-kuma-cli");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "config.toml"), toml);
}

// In-process equivalent of spawning `bun src/cli.ts`: same clean env, same
// captured stdout/stderr and exit code, but the run stays inside the test
// process so `bun test --coverage` instruments src/commands too. console.*
// bypasses process.stdout.write under Bun, so both are patched.
export async function run(
  sb: Sandbox,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sb.home,
    XDG_CONFIG_HOME: sb.xdg,
    UPTIME_KUMA_TIMEOUT: "3",
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }

  const savedEnv = { ...process.env };
  const savedWrite = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  const savedConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const makeWrite =
    (append: (s: string) => void) =>
    (chunk: unknown, ...rest: unknown[]) => {
      append(typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array));
      const cb = rest.find((a) => typeof a === "function");
      if (typeof cb === "function") cb();
      return true;
    };
  process.stdout.write = makeWrite((s) => {
    stdout += s;
  }) as typeof process.stdout.write;
  process.stderr.write = makeWrite((s) => {
    stderr += s;
  }) as typeof process.stderr.write;
  const toOut = (...a: unknown[]) => {
    stdout += `${format(...a)}\n`;
  };
  const toErr = (...a: unknown[]) => {
    stderr += `${format(...a)}\n`;
  };
  console.log = toOut;
  console.info = toOut;
  console.debug = toOut;
  console.warn = toErr;
  console.error = toErr;

  let code: number;
  try {
    // The spawned CLI saw exactly `base` as its environment; reproduce that by
    // emptying process.env for the duration of the call.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, base);
    code = await runCli(args);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    process.stdout.write = savedWrite.stdout;
    process.stderr.write = savedWrite.stderr;
    Object.assign(console, savedConsole);
  }
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

export const creds = (url: string) => ({
  UPTIME_KUMA_URL: url,
  UPTIME_KUMA_USERNAME: "admin",
  UPTIME_KUMA_PASSWORD: "pw-from-test",
});
