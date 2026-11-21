import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pkg from "../package.json" with { type: "json" };
import { nextTag, TAG_SHAPE } from "../scripts/next-tag.ts";

/**
 * Every push to main that passes CI releases under the tag this returns, and install.sh
 * hands out whatever is latest. A wrong answer either fails the release on a tag that
 * exists or publishes a version that sorts below the one before it.
 */
// A value different from every tag, so it is also checked that the answer does not fall
// back to package.json's version when tags exist
const FIRST = "7.7.7";

describe("nextTag", () => {
  test("steps the release candidate", () => {
    expect(nextTag(["v0.1.0-rc.1", "v0.1.0-rc.2", "v0.1.0-rc.3"], FIRST)).toBe("v0.1.0-rc.4");
  });

  test("compares rc numbers as numbers, not text", () => {
    expect(nextTag(["v0.1.0-rc.9", "v0.1.0-rc.10", "v0.1.0-rc.2"], FIRST)).toBe("v0.1.0-rc.11");
  });

  test("compares patch numbers as numbers, not text", () => {
    expect(nextTag(["v0.1.9", "v0.1.10"], FIRST)).toBe("v0.1.11-rc.1");
  });

  test("counts rc.0 as a release candidate, not a final version", () => {
    expect(nextTag(["v0.1.0-rc.0"], FIRST)).toBe("v0.1.0-rc.1");
  });

  test("puts a final version above its own release candidates, and starts the next patch", () => {
    expect(nextTag(["v0.1.0-rc.3", "v0.1.0", "v0.1.0-rc.2"], FIRST)).toBe("v0.1.1-rc.1");
  });

  test("takes the highest version, whatever order the tags come in", () => {
    expect(nextTag(["v0.2.0-rc.1", "v0.10.0-rc.1", "v0.9.9"], FIRST)).toBe("v0.10.0-rc.2");
    expect(nextTag(["v1.0.0-rc.1", "v0.9.0"], FIRST)).toBe("v1.0.0-rc.2");
  });

  test("ignores tags in any other shape", () => {
    expect(nextTag(["v0.1.0-rc.3", "v9", "latest", "v2.0.0-beta.1", ""], FIRST)).toBe(
      "v0.1.0-rc.4",
    );
  });

  test("ignores a tag that only ends in a version", () => {
    expect(nextTag(["v0.1.0-rc.3", "release-v9.0.0"], FIRST)).toBe("v0.1.0-rc.4");
  });

  test("reads a tag with a trailing carriage return", () => {
    expect(nextTag(["v0.1.0-rc.3\r"], FIRST)).toBe("v0.1.0-rc.4");
  });

  // The push trigger takes any v*, so a tag the release side refuses (leading zeros,
  // numbers wider than 9 digits) can sit in git forever; it must not move the count (#4)
  test("ignores tags the release shape refuses", () => {
    expect(nextTag(["v0.1.0-rc.3", "v0.011.0", "v0.1.9999999999"], FIRST)).toBe("v0.1.0-rc.4");
    expect(nextTag(["v0.011.0"], FIRST)).toBe("v7.7.7-rc.1");
  });

  // A candidate wider than the shape cannot be released, so the tag job has to stop
  // here rather than build binaries publish-release.sh would refuse (#4)
  test("refuses a next tag the release shape cannot express", () => {
    expect(() => nextTag(["v0.1.999999999"], FIRST)).toThrow("9 digits at most");
    expect(() => nextTag(["v0.1.0-rc.999999999"], FIRST)).toThrow("9 digits at most");
  });

  // One regex source is shared by next-tag.ts, publish-release.sh and release.yml:
  // this pins the shell literal, and workflows.test.ts derives the workflow literals
  // from TAG_SHAPE.source, keeping all three equal (#4)
  test("the tag shape is the one publish-release.sh enforces", () => {
    const shell = readFileSync(
      join(import.meta.dir, "..", "scripts", "publish-release.sh"),
      "utf8",
    );
    const shellShape = /version_shape='([^']+)'/.exec(shell)?.[1];

    expect(TAG_SHAPE.source).toBe(shellShape ?? "<version_shape not found>");
  });

  test("starts the first release candidate from the package.json version when no tag counts", () => {
    expect(nextTag([], "0.1.0")).toBe("v0.1.0-rc.1");
    expect(nextTag(["latest", "", "v2.0.0-beta.1"], "3.4.5")).toBe("v3.4.5-rc.1");
  });

  test("refuses a package.json version it cannot count from", () => {
    expect(() => nextTag([], "0.1")).toThrow("not X.Y.Z");
    expect(() => nextTag([], "1.0.0-rc.1")).toThrow("not X.Y.Z");
  });
});

// The workflow uses stdout as the tag, so in a repo with no tags this must return exit code
// 0 and a tag (failure-swallowing is blocked on the workflow side, but if this fails main
// stays green and nothing is released)
describe("when next-tag.ts runs in a repo with no tags", () => {
  test("prints the tag counted from package.json's version and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "next-tag-"));
    try {
      const git = Bun.spawnSync(["git", "init", "-q", dir]);
      expect(git.exitCode).toBe(0);
      const script = resolve(import.meta.dir, "../scripts/next-tag.ts");
      const run = Bun.spawnSync([process.execPath, script], { cwd: dir });

      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(`v${pkg.version}-rc.1\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
