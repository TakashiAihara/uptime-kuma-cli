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
