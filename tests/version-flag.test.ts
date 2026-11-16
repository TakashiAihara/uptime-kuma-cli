import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { run, type Sandbox, sandbox } from "./helpers/run";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("--version", () => {
  // The version is baked in at compile time, so a user's env cannot fake it in dev runs either
  test("a dev run reports package.json's version even when the build identifier is in env", async () => {
    const r = await run(sb, ["--version"], { __BUILD_VERSION__: "0.0.1" });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${pkg.version}\n`);
  });

  test("a build with an injected version reports that version", async () => {
    const out = join(sb.dir, "cli.js");
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      CLI,
      "--target=bun",
      "--define",
      '__BUILD_VERSION__="9.8.7-rc.6"',
      "--outfile",
      out,
    ]);
    expect(build.exitCode).toBe(0);

    const r = Bun.spawnSync([process.execPath, out, "--version"], {
      env: { PATH: process.env.PATH, HOME: sb.home, __BUILD_VERSION__: "0.0.1" },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("9.8.7-rc.6\n");
  });
});

describe("--help", () => {
  // Every register* call in cli.ts is otherwise only exercised by that
  // command's own tests; a dropped registration would pass the whole suite.
  test("lists every command group", async () => {
    const r = await run(sb, ["--help"]);

    expect(r.code).toBe(0);
    for (const cmd of [
      "monitors",
      "beats",
      "events",
      "notifications",
      "proxies",
      "tags",
      "maintenance",
      "status-pages",
      "settings",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });
});
