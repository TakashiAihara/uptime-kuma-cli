import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { resolveTotp, totpToken } from "../src/lib.ts";
import { FAKE_TOTP_SECRET, type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox, writeConfig } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [{ id: 1, name: "a", type: "http", active: true, notificationIDList: {} }],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

const list = ["monitors", "list"];

describe("credentials and url", () => {
  test("config.toml url and *_command supply everything", async () => {
    const log = join(sb.dir, "log");
    writeConfig(
      sb,
      [
        `url = "${kuma.url}/"`,
        `username_command = "if [ -n \\"$UPTIME_KUMA_PASSWORD\\" ]; then echo user-sees-pw >> ${log}; fi; echo admin"`,
        `password_command = "if [ -n \\"$UPTIME_KUMA_USERNAME\\" ]; then echo pw-sees-user >> ${log}; fi; printf 'pw-from-test\\nsecond line\\n'"`,
      ].join("\n"),
    );
    const r = await run(sb, list);
    expect(r.code).toBe(0);
    expect(r.json()).toHaveLength(1);
    let leaked = "";
    try {
      leaked = readFileSync(log, "utf8");
    } catch {}
    expect(leaked).toBe("");
  });

  test.each([
    ["username_command", "UPTIME_KUMA_PASSWORD", "UPTIME_KUMA_USERNAME", "admin"],
    ["password_command", "UPTIME_KUMA_USERNAME", "UPTIME_KUMA_PASSWORD", "pw-from-test"],
  ])("%s does not see %s given in env", async (key, other, own, value) => {
    const log = join(sb.dir, "seen");
    writeConfig(
      sb,
      `${key} = "if [ -n \\"$${other}\\" ]; then echo saw >> ${log}; fi; echo ${value}"`,
    );
    const r = await run(sb, list, { ...creds(kuma.url), [own]: undefined });
    expect(r.code).toBe(0);
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test("env wins over config and the command does not run", async () => {
    const marker = join(sb.dir, "ran");
    writeConfig(
      sb,
      [`url = "http://127.0.0.1:1"`, `password_command = "touch ${marker}; echo wrong"`].join("\n"),
    );
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("no url anywhere exits 2", async () => {
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_URL: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("UPTIME_KUMA_URL");
  });

  test("a url without scheme exits 2", async () => {
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_URL: "uptime.local" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("http");
  });

  test("no password exits 2", async () => {
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_PASSWORD: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("UPTIME_KUMA_PASSWORD");
  });

  test("a failing password_command exits 2 without printing its output", async () => {
    writeConfig(sb, `password_command = "echo leaked-pw; exit 7"`);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_PASSWORD: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("leaked-pw");
    expect(r.stdout).not.toContain("leaked-pw");
  });

  test("a hanging password_command is cut by UPTIME_KUMA_COMMAND_TIMEOUT", async () => {
    // A compound command so sh forks sleep as a grandchild instead of exec-ing it; only a
    // process-group kill closes the pipe then
    writeConfig(sb, `password_command = "sleep 30; echo late"`);
    const t = Date.now();
    const r = await run(sb, list, {
      ...creds(kuma.url),
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_COMMAND_TIMEOUT: "1",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("timed out");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a broken config.toml exits 2", async () => {
    writeConfig(sb, `url = `);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_URL: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("config.toml");
  });

  test("a wrong password exits 2 with Kuma's message and never prints the password", async () => {
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_PASSWORD: "wrong-pw-abc" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Incorrect username or password.");
    expect(r.stderr + r.stdout).not.toContain("wrong-pw-abc");
  });

  const loginTokens = () =>
    kuma.calls
      .filter((c) => c.event === "login")
      .map((c) => (c.args[0] as { token?: string }).token);

  // A script that prints a fresh TOTP for the secret in IT_TOTP_SECRET, used
  // as a totp_command because sh cannot compute one itself.
  const writeTotpGen = () => {
    const gen = join(sb.dir, "gen-totp.ts");
    const lib = join(import.meta.dir, "..", "src", "lib.ts");
    writeFileSync(
      gen,
      `import { totpToken } from ${JSON.stringify(lib)};\nconst secret = process.env.IT_TOTP_SECRET;\nif (secret === undefined) process.exit(1);\nconsole.log(totpToken(secret, Date.now())); console.log("second-line-ignored");\n`,
    );
    return `${process.execPath} ${gen}`;
  };

  test("an account with 2FA and no token source exits 2 after the tokenless attempt", async () => {
    kuma.state.twoFA = true;
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("2FA");
    expect(loginTokens()).toEqual([""]);
  });

  test("UPTIME_KUMA_TOTP is sent as the login token after tokenRequired", async () => {
    kuma.state.twoFA = true;
    const token = totpToken(FAKE_TOTP_SECRET, Date.now());
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: token });
    expect(r.code).toBe(0);
    expect(r.json()).toHaveLength(1);
    expect(loginTokens()).toEqual(["", token]);
  });

  test("totp_command's first output line is sent as the login token", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "${writeTotpGen()}"`);
    const r = await run(sb, list, { ...creds(kuma.url), IT_TOTP_SECRET: FAKE_TOTP_SECRET });
    expect(r.code).toBe(0);
    const tokens = loginTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^\d{1,6}$/);
  });

  test("totp_secret_command's secret is converted to a login token", async () => {
    kuma.state.twoFA = true;
    const secret = "JBSWY3DPEHPK3PXP";
    kuma.state.twoFASecret = secret;
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    const r = await run(sb, list, { ...creds(kuma.url), IT_TOTP_SECRET: secret });
    expect(r.code).toBe(0);
    const tokens = loginTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^\d{1,6}$/);
    // the secret itself never reaches the socket or the output
    expect(JSON.stringify(kuma.calls)).not.toContain(secret);
    expect(r.stderr + r.stdout).not.toContain(secret);
  });

  test("totp_secret_command accepts a whole otpauth URI", async () => {
    kuma.state.twoFA = true;
    const secret = "JBSWY3DPEHPK3PXP";
    kuma.state.twoFASecret = secret;
    writeConfig(
      sb,
      `totp_secret_command = 'echo "otpauth://totp/uptime-kuma:admin?secret=$(printenv IT_TOTP_SECRET)&issuer=uptime-kuma"'`,
    );
    const r = await run(sb, list, { ...creds(kuma.url), IT_TOTP_SECRET: secret });
    expect(r.code).toBe(0);
    expect(loginTokens()).toHaveLength(2);
  });

  test("an otpauth URI secret may be percent-encoded", async () => {
    kuma.state.twoFA = true;
    writeConfig(
      sb,
      `totp_secret_command = 'echo "otpauth://totp/a:b?secret=%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41"'`,
    );
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
  });

  test.each([
    "otpauth://totp/a:b?secret=%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41#note",
    "otpauth://totp/user#name?secret=%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41",
  ])("an otpauth URI tolerates a hash: %s", async (uri) => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo '${uri}'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
  });
  test("an otpauth URI accepts the notp shape spelled out in lowercase", async () => {
    kuma.state.twoFA = true;
    writeConfig(
      sb,
      `totp_secret_command = 'echo "otpauth://totp/a:b?secret=%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41%41&algorithm=sha1&digits=6&period=30"'`,
    );
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
    expect(loginTokens()).toHaveLength(2);
  });

  test("UPTIME_KUMA_TOTP wins over totp_command and totp_secret_command", async () => {
    kuma.state.twoFA = true;
    const token = totpToken(FAKE_TOTP_SECRET, Date.now());
    writeConfig(
      sb,
      [`totp_command = "echo 000000"`, `totp_secret_command = "echo JBSWY3DPEHPK3PXP"`].join("\n"),
    );
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: token });
    expect(r.code).toBe(0);
    expect(loginTokens()).toEqual(["", token]);
  });

  test("totp_command is preferred over totp_secret_command", async () => {
    kuma.state.twoFA = true;
    const secret = "JBSWY3DPEHPK3PXP";
    kuma.state.twoFASecret = secret;
    writeConfig(
      sb,
      [
        `totp_command = "${writeTotpGen()}"`,
        // a valid base32 secret whose tokens do not match twoFASecret
        `totp_secret_command = "echo CCCCCCCCCCCCCCCC"`,
      ].join("\n"),
    );
    const r = await run(sb, list, { ...creds(kuma.url), IT_TOTP_SECRET: secret });
    expect(r.code).toBe(0);
  });

  test("a failing totp_command exits 2 without printing its output", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "echo leaked-token; exit 7"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("leaked-token");
    expect(r.stdout).not.toContain("leaked-token");
  });

  test("an empty totp_command output exits 2", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "true"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no output");
  });

  test("a hanging totp_command is cut by UPTIME_KUMA_COMMAND_TIMEOUT", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "sleep 30; echo late"`);
    const t = Date.now();
    const r = await run(sb, list, {
      ...creds(kuma.url),
      UPTIME_KUMA_COMMAND_TIMEOUT: "1",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("timed out");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a malformed totp_secret_command secret exits 2", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo 'not base32!'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("base32");
  });

  test("an otpauth URI without a secret parameter exits 2", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo 'otpauth://totp/a:b?issuer=x'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("secret parameter");
  });

  test("a token outside the verification window exits 2 with Invalid Token!", async () => {
    kuma.state.twoFA = true;
    const stale = totpToken(FAKE_TOTP_SECRET, 0);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: stale });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid Token!");
  });

  test("a token from the previous 30-second window is still accepted", async () => {
    kuma.state.twoFA = true;
    // pin the clock so token generation and the fake's verification
    // share one counter even if a window boundary is near
    setSystemTime(1_800_000_000_000);
    try {
      const previous = totpToken(
        FAKE_TOTP_SECRET,
        Math.floor(Date.now() / 30_000) * 30_000 - 30_000,
      );
      const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: previous });
      expect(r.code).toBe(0);
    } finally {
      setSystemTime();
    }
  });

  test("a replayed token is rejected like Kuma's twofa_last_token", async () => {
    kuma.state.twoFA = true;
    const token = totpToken(FAKE_TOTP_SECRET, Date.now());
    const env = { ...creds(kuma.url), UPTIME_KUMA_TOTP: token };
    expect((await run(sb, list, env)).code).toBe(0);
    const second = await run(sb, list, env);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("Invalid Token!");
    // a ready token cannot be re-minted, so no adjacent retry is sent
    expect(loginTokens()).toEqual(["", token, "", token]);
  });

  test("a secret-derived token retries the adjacent windows on Invalid Token!", async () => {
    kuma.state.twoFA = true;
    // valid base32 but not twoFASecret, so every retry fails the same way
    writeConfig(sb, `totp_secret_command = "echo CCCCCCCCCCCCCCCC"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid Token!");
    const tokens = loginTokens();
    expect(tokens).toHaveLength(4);
    expect(tokens[0]).toBe("");
    expect(new Set(tokens.slice(1)).size).toBe(3);
    for (const token of tokens.slice(1)) expect(token).toMatch(/^\d{1,6}$/);
  });

  test("a same-window relogin retries the previous counter's token", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    const env = { ...creds(kuma.url), IT_TOTP_SECRET: kuma.state.twoFASecret };
    // pin the clock so both runs mint the same first token: the second run's
    // first attempt replays it, and only the bumped token can pass
    setSystemTime(1_800_000_000_000);
    try {
      expect((await run(sb, list, env)).code).toBe(0);
      expect((await run(sb, list, env)).code).toBe(0);
      const tokens = loginTokens();
      expect(tokens).toHaveLength(5);
      expect(tokens[3]).toBe(tokens[1]);
      // pinned clock: counter 60_000_000, so the first retry is the
      // previous window's token (counter 59_999_999)
      expect(tokens[4]).toBe(totpToken(FAKE_TOTP_SECRET, 1_799_999_970_000));
    } finally {
      setSystemTime();
    }
  });

  test("a same-window relogin logs in when the server clock is behind", async () => {
    kuma.state.twoFA = true;
    const secret = "BBBBBBBBBBBBBBBB";
    kuma.state.twoFASecret = secret;
    // the fake's clock runs 20 s behind, so a next-window token falls
    // outside the server's ±1 window; the previous-window retry — tried
    // first — is the one that verifies
    kuma.state.twoFASkewMs = -20_000;
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    const env = { ...creds(kuma.url), IT_TOTP_SECRET: secret };
    setSystemTime(1_800_000_000_000);
    try {
      expect((await run(sb, list, env)).code).toBe(0);
      expect((await run(sb, list, env)).code).toBe(0);
      const tokens = loginTokens();
      expect(tokens).toHaveLength(5);
      // pinned clock: counter 60_000_000, so the winning retry is the
      // previous window's token (counter 59_999_999)
      expect(tokens[4]).toBe(totpToken(secret, 1_799_999_970_000));
    } finally {
      setSystemTime();
    }
  });

  test("a same-window relogin logs in when the server clock is ahead", async () => {
    kuma.state.twoFA = true;
    const secret = "BBBBBBBBBBBBBBBB";
    kuma.state.twoFASecret = secret;
    // the fake's clock runs 40 s ahead, so the client's previous-window
    // token falls outside the server's ±1 window and only the
    // next-window retry verifies
    kuma.state.twoFASkewMs = 40_000;
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    const env = { ...creds(kuma.url), IT_TOTP_SECRET: secret };
    setSystemTime(1_800_000_000_000);
    try {
      expect((await run(sb, list, env)).code).toBe(0);
      expect((await run(sb, list, env)).code).toBe(0);
      const tokens = loginTokens();
      expect(tokens).toHaveLength(6);
      // pinned clock: counter 60_000_000 vs the server's 60_000_001, so
      // the first retry (previous window) fails and the second (next)
      // verifies — the order is pinned by the exact tokens
      expect(tokens[4]).toBe(totpToken(secret, 1_799_999_970_000));
      expect(tokens[5]).toBe(totpToken(secret, 1_800_000_030_000));
    } finally {
      setSystemTime();
    }
  });

  test("a token whose binary has fewer than six digits verifies like notp", async () => {
    kuma.state.twoFA = true;
    kuma.state.twoFASecret = "CCCCCCCCCCCCCCCC";
    // counter 21871 of this secret truncates to a 5-digit binary; notp keeps
    // only the decimal's last character, and the fake must agree exactly
    const atMs = 656_130_000;
    setSystemTime(atMs);
    try {
      const token = totpToken("CCCCCCCCCCCCCCCC", atMs);
      expect(token).toBe("8");
      const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: token });
      expect(r.code).toBe(0);
    } finally {
      setSystemTime();
    }
  });

  test("retry tokens stay on the counters adjacent to the minted token", async () => {
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    const saved = { ...process.env };
    const base = {
      PATH: saved.PATH ?? "",
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdg,
      IT_TOTP_SECRET: "CCCCCCCCCCCCCCCC",
    };
    const resolve = async () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, base);
      return resolveTotp();
    };
    // 656_130_000 is counter 21871; resolving again one counter each way
    // afterwards must not move the first resolution's retries
    setSystemTime(656_130_000);
    try {
      const minted = await resolve();
      setSystemTime(656_160_000);
      const next = await resolve();
      setSystemTime(656_100_000);
      const prev = await resolve();
      expect(minted.retryTokens).toEqual([prev.token, next.token]);
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
      setSystemTime();
    }
  });

  test("a same-window relogin retries through Kuma 2.x's authInvalidToken", async () => {
    const k2 = await startFakeKuma({ profile: "2.x" });
    try {
      k2.state.twoFA = true;
      k2.state.twoFASecret = "BBBBBBBBBBBBBBBB";
      writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
      const env = { ...creds(k2.url), IT_TOTP_SECRET: "BBBBBBBBBBBBBBBB" };
      // pinned so both runs mint the same first token: the second run's
      // first attempt replays it and 2.x answers authInvalidToken — only
      // the adjacent-window retry can pass
      setSystemTime(1_800_000_000_000);
      try {
        expect((await run(sb, list, env)).code).toBe(0);
        expect((await run(sb, list, env)).code).toBe(0);
      } finally {
        setSystemTime();
      }
    } finally {
      await k2.close();
    }
  });

  test("a non-token login failure stops the adjacent-window retries", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "printenv IT_TOTP_SECRET"`);
    // the tokenless attempt falls through to tokenRequired; the token
    // attempt gets Kuma's rate-limit reply, which is not an invalid-token
    // answer, so no retry may be sent
    kuma.state.fail.login = [null, "Too frequently, try again later."];
    const r = await run(sb, list, { ...creds(kuma.url), IT_TOTP_SECRET: "CCCCCCCCCCCCCCCC" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Too frequently, try again later.");
    expect(loginTokens()).toHaveLength(2);
    expect(loginTokens()[0]).toBe("");
  });

  test.each([
    "otpauth://totp/x?secret=AAAA&digits=8",
    "otpauth://totp/x?secret=AAAA&algorithm=SHA256",
    "otpauth://totp/x?secret=AAAA&period=60",
    "otpauth://hotp/x?secret=AAAA",
  ])("an otpauth URI with options Kuma cannot use exits 2: %s", async (uri) => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo '${uri}'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("otpauth URI with options");
  });

  test.each([
    "otpauth://totp/x?secret=AAAA&Algorithm=SHA1",
    "otpauth://totp/x?secret=AAAA&DIGITS=6",
    "otpauth://totp/x?Secret=AAAA",
    "otpauth://totp/x?secret=AAAA&period=30&Period=30",
  ])("an otpauth URI with a mixed-case option name exits 2: %s", async (uri) => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo '${uri}'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mixed-case option name");
  });
  test.each([
    "otpauth://totp/x?secret=AAAA&secret=BBBB",
    "otpauth://totp/x?secret=AAAA&digits=6&digits=8",
  ])("an otpauth URI with a repeated option name exits 2: %s", async (uri) => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo '${uri}'"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("repeated option name");
  });
  test("a totp_command that prints only spaces exits 2", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "echo '   '"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("totp_command produced no output");
  });

  test("a padded UPTIME_KUMA_TOTP is trimmed before login", async () => {
    kuma.state.twoFA = true;
    setSystemTime(1_800_000_000_000);
    try {
      const token = totpToken(FAKE_TOTP_SECRET, 1_800_000_000_000);
      const r = await run(sb, list, {
        ...creds(kuma.url),
        UPTIME_KUMA_TOTP: ` ${token} `,
      });
      expect(r.code).toBe(0);
      expect(loginTokens()).toEqual(["", token]);
    } finally {
      setSystemTime();
    }
  });

  test("a blank UPTIME_KUMA_TOTP falls through to totp_command", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_command = "${writeTotpGen()}"`);
    const r = await run(sb, list, {
      ...creds(kuma.url),
      IT_TOTP_SECRET: FAKE_TOTP_SECRET,
      UPTIME_KUMA_TOTP: "   ",
    });
    expect(r.code).toBe(0);
    const tokens = loginTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^\d{1,6}$/);
  });
  test("an account without 2FA sends no token and runs no totp command", async () => {
    const marker = join(sb.dir, "ran");
    writeConfig(sb, `totp_command = "touch ${marker}; echo 123456"`);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: "654321" });
    expect(r.code).toBe(0);
    expect(loginTokens()).toEqual([""]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("secret commands cannot see UPTIME_KUMA_TOTP", async () => {
    const log = join(sb.dir, "seen");
    writeConfig(
      sb,
      `username_command = "echo ran >> ${log}; if [ -n \\"$UPTIME_KUMA_TOTP\\" ]; then echo saw >> ${log}; fi; echo admin"`,
    );
    // no UPTIME_KUMA_USERNAME, so the command really runs; "ran" proves it did
    const r = await run(sb, list, {
      ...creds(kuma.url),
      UPTIME_KUMA_USERNAME: undefined,
      UPTIME_KUMA_TOTP: "123456",
    });
    expect(r.code).toBe(0);
    expect(await Bun.file(log).text()).toBe("ran\n");
  });

  test("a dropped connection during a request exits 2 without waiting for the timeout", async () => {
    kuma.state.disconnectOn = "getMonitorBeats";
    const t = Date.now();
    const r = await run(sb, ["beats", "1"], { ...creds(kuma.url), UPTIME_KUMA_TIMEOUT: "20" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disconnect");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a drop while waiting for the pushed lists exits 2 without waiting for the timeout", async () => {
    kuma.state.dropInsteadOfLists = true;
    const t = Date.now();
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TIMEOUT: "20" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disconnect");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a drop while waiting for heartbeat lists exits 2 without waiting for the timeout", async () => {
    kuma.state.silentHeartbeat = [1];
    kuma.state.dropAfterLists = true;
    const t = Date.now();
    const r = await run(sb, ["beats", "latest"], { ...creds(kuma.url), UPTIME_KUMA_TIMEOUT: "20" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disconnect");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a password_command line keeps surrounding spaces and drops only the line ending", async () => {
    kuma.state.password = " spaced pw ";
    writeConfig(sb, `password_command = "printf ' spaced pw \\\\r\\\\n'"`);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_PASSWORD: undefined });
    expect(r.code).toBe(0);
  });

  test("a refused connection exits 2", async () => {
    const r = await run(sb, list, { ...creds("http://127.0.0.1:1"), UPTIME_KUMA_TIMEOUT: "2" });
    expect(r.code).toBe(2);
  });

  test("a server that never answers is cut by UPTIME_KUMA_TIMEOUT", async () => {
    const silent: Server = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as { port: number }).port;
    const t = Date.now();
    const r = await run(sb, list, {
      ...creds(`http://127.0.0.1:${port}`),
      UPTIME_KUMA_TIMEOUT: "1",
    });
    silent.close();
    expect(r.code).toBe(2);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("a non-numeric UPTIME_KUMA_TIMEOUT exits 2", async () => {
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TIMEOUT: "soon" });
    expect(r.code).toBe(2);
  });
});

// UPTIME_KUMA_URL may carry user:pass@ for a basic-auth proxy in front of Kuma
describe("error messages do not print the password in UPTIME_KUMA_URL", () => {
  const withPw = (url: string) => url.replace("://", "://proxyuser:s3cret@");
  const expectMasked = (r: { code: number; stderr: string; stdout: string }, message: RegExp) => {
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toContain("://***@");
    expect(r.stderr + r.stdout).not.toContain("s3cret");
    expect(r.stderr + r.stdout).not.toContain("proxyuser");
  };

  test("a url with the wrong scheme", async () => {
    const r = await run(sb, list, {
      ...creds(kuma.url),
      UPTIME_KUMA_URL: "ftp://proxyuser:s3cret@h",
    });
    expectMasked(r, /must start with http:\/\/ or https:\/\//);
  });

  test("a refused connection", async () => {
    const r = await run(sb, list, {
      ...creds(withPw("http://127.0.0.1:1")),
      UPTIME_KUMA_TIMEOUT: "2",
    });
    expectMasked(r, /failed to connect to/);
  });

  test("a server that never answers", async () => {
    const silent: Server = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as { port: number }).port;
    const r = await run(sb, list, {
      ...creds(withPw(`http://127.0.0.1:${port}`)),
      UPTIME_KUMA_TIMEOUT: "1",
    });
    silent.close();
    // socket.io's own connect timer, armed first with the same budget, fires first
    expectMasked(r, /failed to connect to .*: timeout/);
  });

  test("a server that never admits the socket to its namespace", async () => {
    kuma.state.stallConnect = true;
    const r = await run(sb, list, { ...creds(withPw(kuma.url)), UPTIME_KUMA_TIMEOUT: "1" });
    expectMasked(r, /timed out connecting to/);
  });

  test("a server that never sends its info", async () => {
    kuma.state.noPreLoginInfo = true;
    const r = await run(sb, list, { ...creds(withPw(kuma.url)), UPTIME_KUMA_TIMEOUT: "1" });
    expectMasked(r, /timed out waiting for the server info from/);
  });

  test("a dropped connection", async () => {
    kuma.state.disconnectOn = "getMonitorBeats";
    const r = await run(sb, ["beats", "1"], {
      ...creds(withPw(kuma.url)),
      UPTIME_KUMA_TIMEOUT: "20",
    });
    expectMasked(r, /socket disconnected from/);
  });
});

describe("meta", () => {
  test("--help lists the command groups", async () => {
    const r = await run(sb, ["--help"]);
    expect(r.code).toBe(0);
    for (const word of ["monitors", "beats", "events", "notifications", "proxies", "tags"])
      expect(r.stdout).toContain(word);
  });

  test("an unknown command exits 2", async () => {
    const r = await run(sb, ["nope"], creds(kuma.url));
    expect(r.code).toBe(2);
  });

  test.each([[[]], [["monitors"]], [["notifications"]], [["proxies"]], [["tags"]]])(
    "no subcommand %p exits 2 with help on stderr",
    async (args) => {
      const r = await run(sb, args, creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Usage");
      expect(kuma.calls).toHaveLength(0);
    },
  );
});
