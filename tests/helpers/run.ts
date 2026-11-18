import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// In-process equivalent of spawning the CLI: same clean env, same captured
// stdout/stderr and exit code, but the run stays inside the test process so
// `bun test --coverage` instruments src/commands too. console.* bypasses
// process.stdout.write under Bun, so both are patched. The patched globals are
// process-wide, so concurrent run() calls are rejected outright instead of
// corrupting each other's env and captured output. UPTIME_KUMA_IT_BIN points
// run() at a compiled binary instead, so the integration suite exercises the
// artifact users install rather than runCli; the spawn path patches nothing
// but shares the same guard so callers see one behavior.
let runActive = false;

// Well past the longest call the suite makes legitimately — per-test budgets
// top out at 5 minutes, so a call still running then belongs to a failed
// test — and it keeps a hung binary from holding `bun test` open past the
// test timeouts that would otherwise be the only bound.
const BIN_TIMEOUT_MS = 300_000;

async function runBinary(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<Result> {
  if (bin === "") throw new Error("UPTIME_KUMA_IT_BIN is set but empty");
  if (!existsSync(bin)) {
    throw new Error(`UPTIME_KUMA_IT_BIN=${bin} does not exist`);
  }
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(`UPTIME_KUMA_IT_BIN=${bin} is not executable`);
  }
  const proc = Bun.spawn([bin, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), BIN_TIMEOUT_MS);
  });
  const code = await Promise.race([proc.exited, timeoutP]);
  clearTimeout(timer);
  if (code === "timeout") {
    proc.kill();
    await Promise.allSettled([stdoutP, stderrP, proc.exited]);
    throw new Error(`${bin} ${args.join(" ")} did not exit within ${BIN_TIMEOUT_MS}ms`);
  }
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

export async function run(
  sb: Sandbox,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<Result> {
  if (runActive) {
    throw new Error("run() cannot run concurrently");
  }
  runActive = true;
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

  const bin = process.env.UPTIME_KUMA_IT_BIN;
  if (bin !== undefined) {
    try {
      return await runBinary(bin, args, base);
    } finally {
      runActive = false;
    }
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
    runActive = false;
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
