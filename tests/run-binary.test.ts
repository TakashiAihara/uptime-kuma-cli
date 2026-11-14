import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Sandbox, sandbox } from "./helpers/run";

const SCRIPT = resolve(import.meta.dir, "../scripts/run-binary.sh");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// In place of a real binary, an sh that answers --help and --version differently
function fakeBinary(body: string): string {
  const file = join(sb.dir, "uptime-kuma-cli-linux-x64");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o644);
  return file;
}

const run = (file: string, tag: string) =>
  Bun.spawnSync(["/bin/sh", SCRIPT, file, tag], { cwd: sb.dir, env: { PATH: process.env.PATH } });

describe("scripts/run-binary.sh (#13)", () => {
  const good = `case "$1" in --help) echo usage ;; --version) echo 0.4.2-rc.7 ;; *) exit 9 ;; esac`;

  test("exits 0 when --help passes and --version matches the tag without the v, adding exec permission and running anyway", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("0.4.2-rc.7");
  });

  test("exits 1 and prints both values when --version differs from the tag", () => {
    const r = run(fakeBinary(good), "v0.4.2-rc.8");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("0.4.2-rc.7");
    expect(r.stderr.toString()).toContain("0.4.2-rc.8");
  });

  test("exits 1 without asking --version when --help fails", () => {
    const r = run(
      fakeBinary(
        `case "$1" in --help) echo broken >&2; exit 3 ;; --version) touch "${sb.dir}/version-was-run"; echo 0.4.2-rc.7 ;; esac`,
      ),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--help");
    expect(existsSync(join(sb.dir, "version-was-run"))).toBe(false);
  });

  test("exits 1 when --version fails", () => {
    const r = run(
      fakeBinary(`case "$1" in --help) echo usage ;; --version) exit 4 ;; esac`),
      "v0.4.2-rc.7",
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--version");
  });

  test("exits 1 when the file does not exist", () => {
    const r = run(join(sb.dir, "uptime-kuma-cli-darwin-arm64"), "v0.4.2-rc.7");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("uptime-kuma-cli-darwin-arm64 does not exist");
  });

  test("exits 2 when arguments are missing", () => {
    const r = Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: { PATH: process.env.PATH } });

    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage:");
  });
});
