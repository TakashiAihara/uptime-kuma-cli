import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { totpToken } from "../../src/lib.ts";
import { sandbox, writeConfig, type Sandbox } from "../helpers/run";
import { cliRun, reserveLogins, withKuma2FA } from "./helpers";

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
      // Both calls' login credits are taken in one block — a pacing wait
      // between them could push the relogin past the 30 s window — so each
      // run below spends none of its own (4 each: tokenless probe, token,
      // the two adjacent-counter retries).
      await reserveLogins(8);
      // Landing the pair early in a TOTP window makes the relogin's first
      // mint the token Kuma just stored, so the exit 0 below is only
      // reachable through the adjacent-counter retry.
      const drift = Date.now() % 30_000;
      if (drift > 10_000) await new Promise((r) => setTimeout(r, 30_000 - drift + 1_000));
      const login = await cliRun(
        sb,
        ["monitors", "list"],
        { IT_TOTP_SECRET: secret },
        { logins: 0 },
      );
      expect(login.code).toBe(0);

      // Same-window replay: this login's first mint equals the
      // twofa_last_token the previous login stored, so Kuma rejects it and
      // the secret-command path retries an adjacent counter.
      const relogin = await cliRun(
        sb,
        ["monitors", "list"],
        { IT_TOTP_SECRET: secret },
        { logins: 0 },
      );
      expect(relogin.code).toBe(0);

      // Picked so no counter the pacing-delayed send could still land in
      // verifies it — the env token path has no retries, so the rejection
      // is the final answer.
      const valid = new Set(
        [-1, 0, 1, 2, 3, 4, 5].map((d) => totpToken(secret, Date.now() + d * 30_000)),
      );
      let wrong = "000000";
      while (valid.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, "0");
      const denied = await cliRun(
        sb,
        ["monitors", "list"],
        { UPTIME_KUMA_TOTP: wrong },
        { logins: 2 },
      );
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain("Invalid Token!");
      expect(denied.stderr + denied.stdout).not.toContain(wrong);
    });
    // The timeout must outlast the worst settle the test can legitimately
    // reach — socket setup (~3 min), the reserved-slot wait and each
    // call's spawn watchdog (360 s) — so a hung cliRun rejects inside fn
    // and the finally's disable2FA still runs instead of leaving the
    // shared admin token-gated for later files.
  }, 780_000);
});
