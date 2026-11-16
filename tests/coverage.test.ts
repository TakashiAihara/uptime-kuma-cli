import { describe, expect, test } from "bun:test";
import {
  evaluateDiff,
  evaluateWhole,
  parseAddedLines,
  parseLcov,
  passesGate,
} from "../scripts/coverage.ts";

const LCOV = `TN:
SF:src/a.ts
DA:1,5
DA:2,0
DA:3,2
DA:4,7
LF:4
LH:3
end_of_record
SF:src/b.ts
DA:10,1
DA:11,0
LF:2
LH:1
end_of_record
SF:tests/helpers/x.ts
DA:1,9
LF:1
LH:1
end_of_record
`;

const lcov = () => parseLcov(LCOV);

describe("parseLcov", () => {
  test("reads per-file line hit counts and ignores non-DA records", () => {
    const l = lcov();
    expect(l.get("src/a.ts")?.get(2)).toBe(0);
    expect(l.get("src/a.ts")?.get(4)).toBe(7);
    expect(l.get("src/b.ts")?.get(11)).toBe(0);
    expect(l.get("tests/helpers/x.ts")?.get(1)).toBe(9);
    expect(l.get("src/a.ts")?.size).toBe(4);
  });
});

describe("parseAddedLines", () => {
  test("collects added line numbers on the new side of each hunk", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +2 @@
+inserted at line 2
@@ -5,2 +7,3 @@
 context would not appear with -U0 but stays counted if it does
-old line
+new line one
+new line two
\\ No newline at end of file
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+first
+second
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-bye2
`;
    const added = parseAddedLines(diff);
    expect(added.get("src/a.ts")).toEqual(new Set([2, 8, 9]));
    expect(added.get("src/new.ts")).toEqual(new Set([1, 2]));
    expect(added.has("src/gone.ts")).toBe(false);
  });
});

describe("evaluateWhole", () => {
  test("counts only src/ files toward whole-project coverage", () => {
    const r = evaluateWhole(lcov());
    // src/a.ts: 4 coverable, 3 covered; src/b.ts: 2 coverable, 1 covered.
    // tests/helpers/x.ts is out of scope.
    expect(r.measurable).toBe(6);
    expect(r.covered).toBe(4);
  });
});

describe("evaluateDiff", () => {
  test("measures only added lines that lcov instruments", () => {
    // src/a.ts DA lines are 1-4; the diff adds lines 2 (hits 0) and 4 (hits 7).
    const added = new Map([["src/a.ts", new Set([2, 4, 99])]]);
    const r = evaluateDiff(lcov(), added);
    expect(r.measurable).toBe(2);
    expect(r.covered).toBe(1);
  });

  test("a diff with no measurable lines passes", () => {
    // comment/blank/doc changes produce added lines that are not DA lines
    const added = new Map([
      ["src/a.ts", new Set([50, 51])],
      ["README.md", new Set([1])],
      ["tests/x.test.ts", new Set([3])],
    ]);
    const r = evaluateDiff(lcov(), added);
    expect(r.measurable).toBe(0);
    expect(passesGate(r)).toBe(true);
  });

  test("all measurable lines covered passes", () => {
    const added = new Map([["src/a.ts", new Set([1, 3, 4])]]);
    const r = evaluateDiff(lcov(), added);
    expect(r.measurable).toBe(3);
    expect(r.covered).toBe(3);
    expect(passesGate(r)).toBe(true);
  });

  test("below 90% fails", () => {
    const added = new Map([["src/b.ts", new Set([10, 11])]]);
    const r = evaluateDiff(lcov(), added);
    expect(r.measurable).toBe(2);
    expect(r.covered).toBe(1);
    expect(passesGate(r)).toBe(false);
  });

  test("exactly 90% passes", () => {
    // 9 covered of 10 measurable
    const l = parseLcov(`SF:src/c.ts
${Array.from({ length: 10 }, (_, i) => `DA:${i + 1},${i < 9 ? 1 : 0}`).join("\n")}
LF:10
LH:9
end_of_record
`);
    const added = new Map([["src/c.ts", new Set(Array.from({ length: 10 }, (_, i) => i + 1))]]);
    const r = evaluateDiff(l, added);
    expect(r.measurable).toBe(10);
    expect(r.covered).toBe(9);
    expect(passesGate(r)).toBe(true);
  });

  test("a changed src file missing from lcov contributes nothing measurable", () => {
    const added = new Map([["src/not-loaded.ts", new Set([1, 2, 3])]]);
    const r = evaluateDiff(lcov(), added);
    expect(r.measurable).toBe(0);
  });
});
