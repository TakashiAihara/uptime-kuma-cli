import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { totpToken } from "../../src/lib.ts";
import { sandbox, writeConfig, type Sandbox } from "../helpers/run";
import { cliRun, withKuma2FA } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("login (real Kuma)", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  // Kuma 2.x answers the i18n key authIncorrectCreds; the CLI maps it back
  // to the 1.x text, so the assertion holds on both versions
  test("a wrong password exits 2 with Kuma's message", async () => {
    const r = await cliRun(sb, ["monitors", "list"], { UPTIME_KUMA_PASSWORD: "wrong-pw-abc" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Incorrect username or password.");
    expect(r.stderr).not.toContain("authIncorrectCreds");
    expect(r.stderr + r.stdout).not.toContain("wrong-pw-abc");
  }, 120_000);

  test("with 2FA a token login and a same-window relogin exit 0, a wrong token exits 2", async () => {
    await withKuma2FA(async (secret) => {
      // cliRun's pacing can hold an invocation for most of a minute before
      // spawn, while a pre-minted UPTIME_KUMA_TOTP lives one 30 s counter.
      // totp_secret_command mints inside the spawned login instead — at use
      // time, through the same resolveTotp a real account would drive.
      writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
      const login = await cliRun(sb, ["monitors", "list"], { IT_TOTP_SECRET: secret });
      expect(login.code).toBe(0);

      // Inside one 30 s window this login's first mint equals the
      // twofa_last_token the previous login just stored, so the replay
      // rejection reaches the adjacent-counter retry only the
      // secret-command path can mint; a rolled-over window takes the fresh
      // mint instead. Either way the relogin succeeds.
      const relogin = await cliRun(sb, ["monitors", "list"], { IT_TOTP_SECRET: secret });
      expect(relogin.code).toBe(0);

      // Picked so no counter the pacing-delayed send could still land in
      // verifies it — the env token path has no retries, so the rejection
      // is the final answer.
      const valid = new Set(
        [-1, 0, 1, 2, 3, 4, 5].map((d) => totpToken(secret, Date.now() + d * 30_000)),
      );
      let wrong = "000000";
      while (valid.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, "0");
      const denied = await cliRun(sb, ["monitors", "list"], { UPTIME_KUMA_TOTP: wrong });
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain("Invalid Token!");
      expect(denied.stderr + denied.stdout).not.toContain(wrong);
    });
  }, 300_000);
});
