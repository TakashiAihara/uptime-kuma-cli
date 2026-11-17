import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { totpToken } from "../src/lib.ts";
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

  // A script that prints a fresh TOTP for the given secret, used as a
  // totp_command because sh cannot compute one itself.
  const writeTotpGen = (secret: string) => {
    const gen = join(sb.dir, "gen-totp.ts");
    const lib = join(import.meta.dir, "..", "src", "lib.ts");
    writeFileSync(
      gen,
      `import { totpToken } from ${JSON.stringify(lib)};\nconsole.log(totpToken(${JSON.stringify(secret)}, Date.now()));\n`,
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
    writeConfig(sb, `totp_command = "${writeTotpGen(FAKE_TOTP_SECRET)}"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
    const tokens = loginTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^\d{6}$/);
  });

  test("totp_secret_command's secret is converted to a login token", async () => {
    kuma.state.twoFA = true;
    const secret = "JBSWY3DPEHPK3PXP";
    kuma.state.twoFASecret = secret;
    writeConfig(sb, `totp_secret_command = "echo ${secret}"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
    const tokens = loginTokens();
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatch(/^\d{6}$/);
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
      `totp_secret_command = "echo 'otpauth://totp/uptime-kuma:admin?secret=${secret}&issuer=uptime-kuma'"`,
    );
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
    expect(loginTokens()).toHaveLength(2);
  });

  test("an otpauth URI secret may be percent-encoded", async () => {
    kuma.state.twoFA = true;
    writeConfig(
      sb,
      `totp_secret_command = "echo 'otpauth://totp/a:b?secret=${FAKE_TOTP_SECRET}%3D%3D'"`,
    );
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(0);
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
        `totp_command = "${writeTotpGen(secret)}"`,
        // a valid base32 secret whose tokens do not match twoFASecret
        `totp_secret_command = "echo CCCCCCCCCCCCCCCC"`,
      ].join("\n"),
    );
    const r = await run(sb, list, creds(kuma.url));
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
    const previous = totpToken(FAKE_TOTP_SECRET, Math.floor(Date.now() / 30_000) * 30_000 - 30_000);
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: previous });
    expect(r.code).toBe(0);
  });

  test("a replayed token is rejected like Kuma's twofa_last_token", async () => {
    kuma.state.twoFA = true;
    const token = totpToken(FAKE_TOTP_SECRET, Date.now());
    const env = { ...creds(kuma.url), UPTIME_KUMA_TOTP: token };
    expect((await run(sb, list, env)).code).toBe(0);
    const second = await run(sb, list, env);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("Invalid Token!");
  });

  test("a secret-derived token is retried once with the next window on Invalid Token!", async () => {
    kuma.state.twoFA = true;
    // valid base32 but not twoFASecret, so the retry fails the same way
    writeConfig(sb, `totp_secret_command = "echo CCCCCCCCCCCCCCCC"`);
    const r = await run(sb, list, creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid Token!");
    const tokens = loginTokens();
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toBe("");
    expect(tokens[1]).toMatch(/^\d{6}$/);
    expect(tokens[2]).toMatch(/^\d{6}$/);
    expect(tokens[1]).not.toBe(tokens[2]);
  });

  test("back-to-back logins through totp_secret_command both succeed", async () => {
    kuma.state.twoFA = true;
    writeConfig(sb, `totp_secret_command = "echo ${FAKE_TOTP_SECRET}"`);
    expect((await run(sb, list, creds(kuma.url))).code).toBe(0);
    expect((await run(sb, list, creds(kuma.url))).code).toBe(0);
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
      `username_command = "if [ -n \\"$UPTIME_KUMA_TOTP\\" ]; then echo saw >> ${log}; fi; echo admin"`,
    );
    const r = await run(sb, list, { ...creds(kuma.url), UPTIME_KUMA_TOTP: "123456" });
    expect(r.code).toBe(0);
    expect(await Bun.file(log).exists()).toBe(false);
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
