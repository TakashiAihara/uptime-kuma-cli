import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
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
    writeConfig(sb, `password_command = "sleep 30"`);
    const t = Date.now();
    const r = await run(sb, list, {
      ...creds(kuma.url),
      UPTIME_KUMA_PASSWORD: undefined,
      UPTIME_KUMA_COMMAND_TIMEOUT: "1",
    });
    expect(r.code).toBe(2);
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
    for (const word of ["monitors", "beats", "events", "notifications", "proxies"])
      expect(r.stdout).toContain(word);
  });

  test("an unknown command exits 2", async () => {
    const r = await run(sb, ["nope"], creds(kuma.url));
    expect(r.code).toBe(2);
  });
});
