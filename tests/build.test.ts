import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Sandbox, sandbox } from "./helpers/run";

const REPO = resolve(import.meta.dir, "..");
const BUILD = join(REPO, "scripts/build.ts");
const PKG_VERSION = "7.7.7";
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const TARGET = `${OS}-${ARCH}`;
const BINARY = `uptime-kuma-cli-${TARGET}`;

/**
 * scripts/build.ts is the only place RELEASE_TAG turns into a --define, and release.yml only
 * looks at the result after four binaries are built (a build that dropped the define would
 * ship four binaries naming package.json's version). Compiling here proves the tag reaches a
 * binary at all, and that a build without a tag still reads package.json.
 *
 * Only the host target is compiled: the other three cannot be run on this machine, and their
 * shape and embedded tag are scripts/check-binaries.sh's job.
 */
let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  // src is copied. With a symlink, ../package.json would resolve to the real package.json
  cpSync(join(REPO, "src"), join(sb.dir, "src"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(sb.dir, "node_modules"));
  writeFileSync(
    join(sb.dir, "package.json"),
    JSON.stringify({ name: "x", type: "module", version: PKG_VERSION }),
  );
});
afterEach(() => sb.cleanup());

function build(env: Record<string, string>): void {
  const run = Bun.spawnSync([process.execPath, BUILD, TARGET], {
    cwd: sb.dir,
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...env },
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
}

function version(env: Record<string, string> = {}): string {
  const run = Bun.spawnSync([join(sb.dir, "dist", BINARY), "--version"], {
    env: { PATH: process.env.PATH ?? "", HOME: sb.home, ...env },
  });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().trim();
}

describe("scripts/build.ts", () => {
  test("a binary with RELEASE_TAG embedded names that version (in the form without the v)", () => {
    build({ RELEASE_TAG: "v3.2.1-rc.4" });

    expect(version()).toBe("3.2.1-rc.4");
  });

  test("names package.json's version when RELEASE_TAG is missing, and cannot be faked via env", () => {
    build({});

    expect(version({ __BUILD_VERSION__: "0.0.1" })).toBe(PKG_VERSION);
  });

  test("builds only that target when one is named", () => {
    build({ RELEASE_TAG: "v3.2.1-rc.4" });

    expect(readdirSync(join(sb.dir, "dist"))).toEqual([BINARY]);
  });
});
