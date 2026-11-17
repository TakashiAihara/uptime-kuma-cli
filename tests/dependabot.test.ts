import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const present = (path: string) => existsSync(join(root, path));

// Dependabot fails quietly. A manifest no ecosystem covers, and a lockfile its
// bundled bun cannot read, both look from here exactly like a week with nothing
// to update. The config is read with a regular expression rather than a YAML
// parser; that is safe in the direction that matters — an expression that stops
// matching finds no ecosystems at all, and finding none fails every assertion
// below rather than passing them.
const config = read(".github/dependabot.yml");
const ecosystems = [...config.matchAll(/^\s*-\s*package-ecosystem:\s*"?(\S+)"?\s*$/gm)].map(
  ([, name]) => name,
);

// A file on the left means the ecosystem on the right has to be in
// dependabot.yml. Reaching for a second package manager should fail here until
// the config has heard about it — that is the whole point of the list, so it
// names more than we use.
const NEEDS_ECOSYSTEM = [
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "npm"],
  ["pnpm-lock.yaml", "npm"],
  ["Cargo.toml", "cargo"],
  ["go.mod", "gomod"],
  ["Gemfile", "bundler"],
  ["requirements.txt", "pip"],
] as const;

describe("dependabot.yml", () => {
  test("found the ecosystems in the config", () => {
    expect(ecosystems.length).toBeGreaterThan(0);
  });

  test.each(NEEDS_ECOSYSTEM)(
    "%s, if we have one, is watched by the %s ecosystem",
    (file, ecosystem) => {
      if (!present(file)) return;
      expect(ecosystems).toContain(ecosystem);
    },
  );

  test("the workflows are watched by the github-actions ecosystem", () => {
    // Actions reads both spellings, so a repository that only ever wrote .yaml
    // would look empty here and fail for the wrong reason.
    const workflows = readdirSync(join(root, ".github/workflows")).filter((f) =>
      /\.ya?ml$/.test(f),
    );

    expect(workflows.length).toBeGreaterThan(0);
    expect(ecosystems).toContain("github-actions");
  });

  test("every ecosystem updates weekly", () => {
    // One run a week opens a small number of grouped PRs; a faster cadence is
    // noise and a slower one lets fixes rot.
    const intervals = [...config.matchAll(/interval:\s*(\S+)/g)].map(([, v]) => v);

    expect(intervals.length).toBe(ecosystems.length);
    for (const interval of intervals) expect(interval).toBe("weekly");
  });

  // Dependabot runs a bun of its own, and that bun parses `lockfileVersion` up
  // to MAX_SUPPORTED_LOCKFILE_VERSION — 3 today; bun 1.4 writes 2 by default.
  // The day a bun upgrade writes more, every update job starts failing where we
  // cannot see it.
  // https://github.com/dependabot/dependabot-core/blob/main/bun/lib/dependabot/bun/bun_package_manager.rb
  test("bun.lock stays at a lockfileVersion the Dependabot bun can read", () => {
    const version = Number(/"lockfileVersion"\s*:\s*(\d+)/.exec(read("bun.lock"))?.[1]);

    expect(version).toBeLessThanOrEqual(3);
  });
});
