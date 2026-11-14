import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Sandbox, sandbox } from "./helpers/run";

const SCRIPT = resolve(import.meta.dir, "../scripts/check-binaries.sh");
const TAG = "v0.1.1-rc.2";
const VERSION = "0.1.1-rc.2";
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

// The text `file -b` really outputs. Long parts are cut, keeping only the shape and CPU words
const IMAGES: Record<(typeof TARGETS)[number], string> = {
  "linux-x64": "ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked",
  "linux-arm64": "ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), dynamically linked",
  "darwin-x64": "Mach-O 64-bit x86_64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
  "darwin-arm64": "Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL>",
};

let sb: Sandbox;
// A fake file(1). Each target's description lives in DESCS/<name>.txt, so the test
// shape can be swapped
let descs: string;

beforeEach(() => {
  sb = sandbox();
  descs = join(sb.dir, "descs");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  mkdirSync(descs);

  const file = join(sb.dir, "bin", "file");
  writeFileSync(
    file,
    `#!/bin/sh
for last; do :; done
name="\${last##*/}"
[ -f "${descs}/\${name}.txt" ] || { echo "cannot open \${last}" >&2; exit 1; }
cat "${descs}/\${name}.txt"
`,
  );
  chmodSync(file, 0o755);
});
afterEach(() => sb.cleanup());

/** Swaps the text file(1) returns for this target */
function imageOf(target: (typeof TARGETS)[number], image: string): void {
  writeFileSync(join(descs, `uptime-kuma-cli-${target}.txt`), image);
}

/**
 * A fake binary. Only `site` is shaped like the real define, and this is what gets
 * compared against the tag
 */
type Opts = {
  /**
   * The definition --define emits (default is Bun 1.4.3's shape). The check is the same
   * as the real one unless changed
   */
  site?: string;
  /** What --version answers (default is the embedded version) */
  says?: string;
  /** Extra bytes a real binary has but the define does not. Prefixed with # to become comments */
  extra?: string;
};

/** Extra bytes go in as comments so the fake does not break as /bin/sh */
function asComments(text: string): string {
  return text
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

/**
 * A fake binary carrying the tag in the define's shape, but answering --version with a
 * different value
 */
function writeBinary(target: (typeof TARGETS)[number], embedded: string, opts: Opts = {}): void {
  const path = join(sb.dir, "dist", `uptime-kuma-cli-${target}`);
  writeFileSync(
    path,
    `#!/bin/sh
# ${opts.site ?? `var VERSION = "${embedded}";`}
${opts.extra ? asComments(opts.extra) : ""}
case "$1" in
  --version) echo ${opts.says ?? embedded} ;;
  --help) echo "usage: uptime-kuma-cli" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

/** Prepares a dist where all four claim their own target's shape and carry the tag */
function built(opts: { only?: (typeof TARGETS)[number]; version?: string } = {}): void {
  for (const target of TARGETS) {
    imageOf(target, IMAGES[target]);
    if (opts.only && target !== opts.only) continue;
    writeBinary(target, opts.version ?? VERSION);
  }
}

function check(env: Record<string, string | undefined> = {}, path?: string) {
  const merged = {
    PATH: path ?? `${join(sb.dir, "bin")}:${process.env.PATH ?? ""}`,
    HOME: sb.home,
    TAG,
    ...env,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  return Bun.spawnSync(["/bin/sh", SCRIPT], { cwd: sb.dir, env: clean });
}

describe("check-binaries.sh", () => {
  test("passes when all four claim their own shape and carry the tag", () => {
    built();

    const r = check();

    expect(r.exitCode).toBe(0);
  });

  test("fails when a binary claims another CPU's shape", () => {
    built();
    // When the build left all four as the host's, --version only sees linux-x64
    imageOf("linux-arm64", IMAGES["linux-x64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/uptime-kuma-cli-linux-arm64");
  });

  test("fails even when a Mach-O is misread as ELF", () => {
    built();
    imageOf("darwin-arm64", IMAGES["linux-arm64"]);

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/uptime-kuma-cli-darwin-arm64");
  });

  test("fails on a binary that does not carry the tag (the embedding did not work)", () => {
    built();
    writeBinary("darwin-x64", "0.1.0");

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/uptime-kuma-cli-darwin-x64 does not carry the tag");
  });

  test("fails when a runnable binary names a version other than the tag", () => {
    built();
    // Even if the contents carry the tag, a different syntax makes --version answer a different value
    writeBinary("linux-x64", VERSION, { says: "0.1.0" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`says 0.1.0, tag is ${TAG}`);
  });

  test("fails when the three unrunnable binaries are missing (the build succeeded but there is no content)", () => {
    built({ only: "linux-x64" });

    const r = check();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("dist/uptime-kuma-cli-linux-arm64 was not built");
  });

  test("stops when TAG is missing", () => {
    built();

    const r = check({ TAG: undefined });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("TAG");
  });

  // Without file(1) there is no way to check the three that cannot run, so do not pass silently
  test("stops when file is missing", () => {
    built();

    const r = check({}, "/nonexistent");

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("file(1)");
  });
});

// Part of the `bun create` template Bun bundles into every binary. A real binary really has
// this "version": "0.1.0" in three places. The version is not glued to other version
// characters on either side, so a check that only looks around the version always matches
// it, and an rc.2 binary would pass a v0.1.0 tag. That is why the tag is only counted on
// the line the define emits.
const BUN_TEMPLATE = `{
  "name": "bun-react-template",
  "version": "0.1.0",
  "private": true,
  "type": "module",
}`;

// An embedded version only counts as the tag when it appears as the define's own line
describe("an embedded version only counts as the tag in the define's shape", () => {
  const TAG_010 = "v0.1.0";
  const noTag = "dist/uptime-kuma-cli-darwin-x64 does not carry the tag";

  test("passes when the tag's define is there (all four)", () => {
    built({ version: "0.1.0" });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(0);
  });

  test("does not count the tag when the define says a different version", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0-rc.2");

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });

  // The real collision. An rc.2 binary carries the bundled template's 0.1.0. Without
  // looking at the define it would pass a v0.1.0 tag and ship an rc.2 binary as 0.1.0
  test("an rc.2 binary does not pass a v0.1.0 tag even though the bundled template says 0.1.0", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.1-rc.2", { extra: BUN_TEMPLATE });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
    // The searched line is printed too, so a mismatch shows in the log what was looked
    // for and not found
    expect(r.stderr.toString()).toContain(`no 'var VERSION = "0.1.0";' in it`);
  });

  // Bun is pinned to 1.4.3 via mise. If the emitted shape changes the match is lost. The
  // point of stopping the release instead of staying quietly green is that each shape
  // change only needs a fix here
  test("fails when the define's shape differs from Bun 1.4.3's (closes when the output drifts)", () => {
    built({ version: "0.1.0" });
    writeBinary("darwin-x64", "0.1.0", { site: `var VERSION="0.1.0"` });

    const r = check({ TAG: TAG_010 });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(noTag);
  });
});
