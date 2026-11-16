import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

// bun's coverage only reports files the test run loads. Importing every src
// module keeps each one in the lcov report, so an untested file counts its
// uncovered lines against the 90% gates instead of being absent.
describe("src modules", () => {
  test("every file under src/ imports cleanly", async () => {
    const files = [...walk(SRC)].map((f) => relative(SRC, f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await import(`../src/${file}`);
    }
  });
});
