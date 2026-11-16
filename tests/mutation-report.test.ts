import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MUTATION_TESTS,
  buildReport,
  parseMutantTable,
  selectMutants,
} from "../scripts/mutation-report.ts";

const TABLE = ` Target: src/commands/tags.ts (javascript/ts)
   [CR 9] Lines 8-10: 'if (x) {\\n y();\\n }' -> '/* if (x) {\\n y();\\n } */'
   [IF 17] Line 8: 'if (x) {' -> 'if (false) {'
   [IT 27] Line 8: 'if (x) {' -> 'if (true) {''
   [ER 1] Lines 20-24: 'foo();' -> 'throw new Error("mewt");'
   [AWR 163] Line 30: 'await s.tags()' -> 's.tags()'
 not a mutant row
`;

describe("parseMutantTable", () => {
  test("extracts id, slug and line range from each row", () => {
    const rows = parseMutantTable(TABLE);
    expect(rows).toEqual([
      { id: 9, slug: "CR", startLine: 8, endLine: 10 },
      { id: 17, slug: "IF", startLine: 8, endLine: 8 },
      { id: 27, slug: "IT", startLine: 8, endLine: 8 },
      { id: 1, slug: "ER", startLine: 20, endLine: 24 },
      { id: 163, slug: "AWR", startLine: 30, endLine: 30 },
    ]);
  });
});

describe("selectMutants", () => {
  const rows = parseMutantTable(TABLE);

  test("keeps mutants whose line range intersects the changed lines", () => {
    const picked = selectMutants(rows, new Set([8]));
    expect(picked.map((m) => m.id)).toEqual([9, 17, 27]);
    // line 9 only falls inside the multi-line CR mutant
    expect(selectMutants(rows, new Set([9])).map((m) => m.id)).toEqual([9]);
  });

  test("a changed line inside a multi-line mutant counts", () => {
    const picked = selectMutants(rows, new Set([22]));
    expect(picked.map((m) => m.id)).toEqual([1]);
  });

  test("no overlap selects nothing", () => {
    expect(selectMutants(rows, new Set([100]))).toEqual([]);
  });
});

describe("buildReport", () => {
  test("lists surviving mutants under their file with a marker comment", () => {
    const md = buildReport({
      base: "abc1234",
      changedCount: 1,
      files: [
        {
          file: "src/commands/tags.ts",
          selected: 5,
          survivors: [
            {
              id: 9,
              slug: "CR",
              line: 8,
              oldText: "if (x) {",
              newText: "/* if (x) {",
            },
          ],
        },
      ],
      counts: { caught: 4, uncaught: 1, other: 0 },
    });
    expect(md).toContain("<!-- mutation-testing -->");
    expect(md).toContain("src/commands/tags.ts");
    expect(md).toContain("line 8");
    expect(md).toContain("CR");
    expect(md).toContain("4 caught");
    expect(md).toContain("1 survived");
  });

  test("reports an empty result when nothing survived", () => {
    const md = buildReport({
      base: "abc1234",
      changedCount: 2,
      files: [
        { file: "src/a.ts", selected: 3, survivors: [] },
        { file: "src/b.ts", selected: 2, survivors: [] },
      ],
      counts: { caught: 5, uncaught: 0, other: 0 },
    });
    expect(md).toContain("<!-- mutation-testing -->");
    expect(md).toContain("No surviving mutants");
  });

  test("reports no src changes", () => {
    const md = buildReport({
      base: "abc1234",
      changedCount: 0,
      files: [],
      counts: { caught: 0, uncaught: 0, other: 0 },
    });
    expect(md).toContain("<!-- mutation-testing -->");
    expect(md).toContain("No src/ changes");
  });
});

describe("MUTATION_TESTS", () => {
  test("every src file has a focused mutation test command", () => {
    const src = join(import.meta.dir, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) files.push(relative(src, p));
      }
    };
    walk(src);
    for (const f of files) {
      expect(MUTATION_TESTS[`src/${f}`]?.cmd, `missing test cmd for src/${f}`).toBeDefined();
    }
  });
});
