#!/usr/bin/env bun
/**
 * Coverage gates for CI.
 *
 *   bun scripts/coverage.ts whole [--lcov coverage/lcov.info]
 *   bun scripts/coverage.ts diff --base <ref> [--lcov coverage/lcov.info]
 *
 * Both measure src/ only — the code the release binary ships; tests, scripts
 * and docs are outside the gates (a diff touching only those has no
 * measurable lines and passes). `whole` fails below 90% line coverage and
 * refuses to run when a src file is missing from the lcov report (the
 * src-files test keeps every module loaded, so a miss means the coverage
 * run is broken). `diff` fails below 90% of the PR's added/changed lines
 * that lcov instruments; a diff with no measurable lines passes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const THRESHOLD_PERCENT = 90;
const SRC_PREFIX = "src/";
const DEFAULT_LCOV = "coverage/lcov.info";

export type LcovData = Map<string, Map<number, number>>;
export type AddedLines = Map<string, Set<number>>;

export type GateResult = {
  measurable: number;
  covered: number;
  files: { file: string; measurable: number; covered: number }[];
};

export function parseLcov(text: string): LcovData {
  const lcov: LcovData = new Map();
  let lines: Map<number, number> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("SF:")) {
      lines = new Map();
      lcov.set(line.slice(3).replace(/^\.\//, ""), lines);
    } else if (line.startsWith("DA:") && lines !== undefined) {
      const [ln, hits] = line.slice(3).split(",");
      lines.set(Number(ln), Number(hits));
    } else if (line === "end_of_record") {
      lines = undefined;
    }
  }
  return lcov;
}

// git C-quotes paths containing control characters (and, with the default
// core.quotePath, every non-ASCII byte) as \NNN octal escapes, which are not
// valid JSON escapes. Decode the quoted body as bytes so multibyte UTF-8
// sequences reassemble correctly.
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const inner = path.slice(1, -1);
  if (!inner.includes("\\")) return inner;
  const SIMPLE: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  const bytes: number[] = [];
  let text = "";
  const flush = () => {
    if (bytes.length === 0) return;
    text += new TextDecoder().decode(new Uint8Array(bytes));
    bytes.length = 0;
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      flush();
      text += c;
      continue;
    }
    const n = inner[i + 1];
    const oct = n !== undefined && n >= "0" && n <= "7" ? inner.slice(i + 1, i + 4) : "";
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    flush();
    if (n === undefined) {
      text += "\\";
    } else {
      text += SIMPLE[n] ?? n;
      i++;
    }
  }
  flush();
  return text;
}

// Added ('+') line numbers on the new side of `git diff --unified=0` output,
// keyed by repo-relative path. Deletions and /dev/null sides contribute
// nothing.
export function parseAddedLines(diff: string): AddedLines {
  const added: AddedLines = new Map();
  let file: string | undefined;
  let newLine = 0;
  let inHunk = false;
  const add = (n: number) => {
    let set = added.get(file!);
    if (set === undefined) {
      set = new Set();
      added.set(file!, set);
    }
    set.add(n);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      // git appends a TAB after the path when the name contains a space
      const path = unquoteGitPath(line.slice(4).replace(/\t$/, ""));
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m === null ? 0 : Number(m[1]);
      inHunk = m !== null;
    } else if (inHunk && file !== undefined) {
      if (line.startsWith("+")) {
        add(newLine);
        newLine++;
      } else if (line.startsWith(" ") || line.startsWith("-")) {
        if (line.startsWith(" ")) newLine++;
      } else if (!line.startsWith("\\")) {
        inHunk = false;
      }
    }
  }
  return added;
}

export function listSrcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) out.push(relative(root, path));
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

function summarize(files: GateResult["files"]): GateResult {
  return {
    measurable: files.reduce((n, f) => n + f.measurable, 0),
    covered: files.reduce((n, f) => n + f.covered, 0),
    files,
  };
}

export function evaluateWhole(lcov: LcovData): GateResult {
  const files: GateResult["files"] = [];
  for (const [file, lines] of lcov) {
    if (!file.startsWith(SRC_PREFIX)) continue;
    let covered = 0;
    for (const hits of lines.values()) if (hits > 0) covered++;
    files.push({ file, measurable: lines.size, covered });
  }
  return summarize(files);
}

export function evaluateDiff(lcov: LcovData, added: AddedLines): GateResult {
  const files: GateResult["files"] = [];
  for (const [file, lines] of added) {
    if (!file.startsWith(SRC_PREFIX)) continue;
    const instrumented = lcov.get(file);
    if (instrumented === undefined) continue;
    let measurable = 0;
    let covered = 0;
    for (const ln of lines) {
      const hits = instrumented.get(ln);
      if (hits === undefined) continue;
      measurable++;
      if (hits > 0) covered++;
    }
    if (measurable > 0) files.push({ file, measurable, covered });
  }
  return summarize(files);
}

// measurable == 0 means the change has no coverable lines (config, docs,
// tests only) and passes by definition.
export function passesGate(result: { measurable: number; covered: number }): boolean {
  return result.measurable === 0 || result.covered * 100 >= result.measurable * THRESHOLD_PERCENT;
}

function percent(result: GateResult): string {
  if (result.measurable === 0) return "n/a";
  return `${((result.covered / result.measurable) * 100).toFixed(2)}%`;
}

function printResult(title: string, result: GateResult): void {
  console.log(
    `${title}: ${result.covered}/${result.measurable} lines covered (${percent(result)})`,
  );
  for (const f of result.files) {
    console.log(`  ${f.file}: ${f.covered}/${f.measurable}`);
  }
}

function loadLcov(path: string): LcovData {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`cannot read lcov report at ${path} (run bun test --coverage first)`);
    process.exit(2);
  }
  const lcov = parseLcov(text);
  if (lcov.size === 0) {
    console.error(`${path} contains no SF records`);
    process.exit(2);
  }
  return lcov;
}

function missingSrcFiles(lcov: LcovData, root: string): string[] {
  return listSrcFiles(root).filter((f) => !lcov.has(f));
}

export function gitAddedLines(base: string, root: string): AddedLines | null {
  const proc = Bun.spawnSync(
    [
      "git",
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      // local git config (color.diff, diff.external, diff.*Prefix) must not
      // change the output shape the parser expects
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${base}...HEAD`,
      "--",
      "src/",
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    console.error(
      `git diff ${base}...HEAD failed: ${new TextDecoder().decode(proc.stderr).trim()}`,
    );
    return null;
  }
  return parseAddedLines(new TextDecoder().decode(proc.stdout));
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const lcovFlag = args.indexOf("--lcov");
  const lcovPath = lcovFlag === -1 ? DEFAULT_LCOV : args[lcovFlag + 1];
  if (lcovPath === undefined) {
    console.error("--lcov requires a path");
    process.exit(2);
  }
  const root = join(import.meta.dir, "..");
  const lcov = loadLcov(resolve(root, lcovPath));

  if (command === "whole") {
    const missing = missingSrcFiles(lcov, root);
    if (missing.length > 0) {
      console.error(
        `coverage report is missing ${missing.length} src file(s): ${missing.join(", ")}`,
      );
      console.error("every src module must be loaded by the test run (tests/src-files.test.ts)");
      process.exit(2);
    }
    const result = evaluateWhole(lcov);
    if (result.measurable === 0) {
      console.error("no coverable src/ lines found in the coverage report");
      process.exit(2);
    }
    printResult("whole-project line coverage (src/)", result);
    process.exit(passesGate(result) ? 0 : 1);
  }

  if (command === "diff") {
    const baseFlag = args.indexOf("--base");
    const base = baseFlag === -1 ? undefined : args[baseFlag + 1];
    if (base === undefined) {
      console.error("diff requires --base <ref>");
      process.exit(2);
    }
    const added = gitAddedLines(base, root);
    if (added === null) process.exit(2);
    // same domain as listSrcFiles: only .ts files are required to appear in
    // the report; other src/ additions have no coverable lines by definition
    const changedSrc = [...added.keys()].filter(
      (f) => f.startsWith(SRC_PREFIX) && f.endsWith(".ts"),
    );
    const unmeasured = changedSrc.filter((f) => !lcov.has(f));
    if (unmeasured.length > 0) {
      console.error(
        `changed src file(s) missing from the coverage report: ${unmeasured.join(", ")}`,
      );
      process.exit(2);
    }
    const result = evaluateDiff(lcov, added);
    printResult(`diff line coverage vs ${base} (src/)`, result);
    process.exit(passesGate(result) ? 0 : 1);
  }

  console.error("usage: bun scripts/coverage.ts <whole|diff> [--lcov path] [--base ref]");
  process.exit(2);
}

if (import.meta.main) main();
