import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, sandbox, type Sandbox } from "./helpers/run";

const ROOT = join(import.meta.dir, "..");
const TIMEOUT_MS = 20_000;

type ProcOut = { code: number; stdout: string; stderr: string };

// The in-process run() helper covers command behavior, but only a real
// process proves the entry point boots, propagates its exit code, and that
// disconnect() releases the socket — without it the process would hang.
async function spawnCli(
  sb: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<ProcOut> {
  const proc = Bun.spawn([process.execPath, join(ROOT, "src/cli.ts"), ...args], {
    cwd: sb.dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdg,
      UPTIME_KUMA_TIMEOUT: "3",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), TIMEOUT_MS));
  const code = await Promise.race([proc.exited, timer]);
  if (code === "timeout") {
    proc.kill();
    await Promise.allSettled([stdoutP, stderrP, proc.exited]);
    throw new Error(`bun src/cli.ts ${args.join(" ")} did not exit within ${TIMEOUT_MS}ms`);
  }
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  return { code, stdout, stderr };
}

let kuma: FakeKuma;
let sb: Sandbox;

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    tags: [{ id: 1, name: "staging", color: "#00ff00" }],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("cli as a real process", () => {
  test("a command that connects exits 0 instead of hanging on the socket", async () => {
    const r = await spawnCli(sb, ["tags", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ id: 1, name: "staging", color: "#00ff00" }]);
  });

  test("an unknown command exits 2", async () => {
    const r = await spawnCli(sb, ["not-a-command"]);
    expect(r.code).toBe(2);
  });
});
