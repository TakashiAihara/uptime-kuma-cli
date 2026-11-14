import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

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

// The env is rebuilt from scratch so real UPTIME_KUMA_* values or the user's config never leak in.
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
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: base,
    stdout: "pipe",
    stderr: "pipe",
    cwd: sb.dir,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

export const creds = (url: string) => ({
  UPTIME_KUMA_URL: url,
  UPTIME_KUMA_USERNAME: "admin",
  UPTIME_KUMA_PASSWORD: "pw-from-test",
});
