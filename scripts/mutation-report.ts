#!/usr/bin/env bun
/**
 * Mutation report for CI — informational only, never gates the build.
 *
 *   bun scripts/mutation-report.ts --base <ref> [--out <file>]
 *
 * Finds src/ files changed vs <ref>, generates mewt mutants for them, keeps
 * only high/medium severity mutants whose line range intersects the PR's
 * added lines, runs each file's focused unit tests against them, and writes a
 * markdown report of the survivors (Uncaught) for posting as a PR comment.
 * The mewt database lives in a temp dir so stale mutants from earlier runs
 * can never leak into the report.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAddedLines } from "./coverage.ts";

const ROOT = join(import.meta.dir, "..");
const SEVERITIES = "high,medium";
const DEFAULT_TIMEOUT = 300;

// Focused unit tests per src file: a mutant run costs one test-file pass, so
// mapping each file to the tests that exercise it keeps campaigns at seconds
// per mutant instead of the whole suite. tests/mutation-report.test.ts fails
// when a new src file has no entry here.
export const MUTATION_TESTS: Record<string, { cmd: string; timeout: number }> = {
  "src/commands/beats.ts": { cmd: "bun test tests/beats.test.ts", timeout: 60 },
  "src/commands/maintenance.ts": {
    cmd: "bun test tests/maintenance.test.ts",
    timeout: 120,
  },
  "src/commands/monitors.ts": {
    cmd: "bun test tests/monitors.test.ts tests/monitors-kuma2.test.ts tests/monitors-stats.test.ts",
    timeout: 180,
  },
  "src/commands/notifications.ts": {
    cmd: "bun test tests/notifications.test.ts",
    timeout: 60,
  },
  "src/commands/proxies.ts": { cmd: "bun test tests/proxies.test.ts", timeout: 60 },
  "src/commands/settings.ts": { cmd: "bun test tests/settings.test.ts", timeout: 60 },
  "src/commands/status-pages.ts": {
    cmd: "bun test tests/status-pages.test.ts tests/status-pages-kuma2.test.ts",
    timeout: 120,
  },
  "src/commands/tags.ts": { cmd: "bun test tests/tags.test.ts", timeout: 60 },
  "src/cli.ts": {
    // cli-process.test.ts spawns the real entry point, so it also catches
    // mutants that only break process-level behavior (e.g. disconnect()).
    cmd: "bun test tests/version-flag.test.ts tests/tags.test.ts tests/cli-process.test.ts",
    timeout: 60,
  },
  "src/kuma.ts": {
    cmd: "bun test tests/monitors.test.ts tests/tags.test.ts tests/settings.test.ts",
    timeout: 180,
  },
  "src/lib.ts": { cmd: "bun test tests/config.test.ts tests/tags.test.ts", timeout: 60 },
  "src/timezones.ts": { cmd: "bun test tests/settings.test.ts", timeout: 60 },
  "src/version.ts": { cmd: "bun test tests/version-flag.test.ts", timeout: 60 },
};

const FALLBACK_TEST = { cmd: "bun test tests/", timeout: DEFAULT_TIMEOUT };

export type MutantRow = { id: number; slug: string; startLine: number; endLine: number };

const ROW = /^\s*\[([A-Z]+)\s+(\d+)\]\s+Lines?\s+(\d+)(?:-(\d+))?:/;

export function parseMutantTable(text: string): MutantRow[] {
  const rows: MutantRow[] = [];
  for (const line of text.split("\n")) {
    const m = ROW.exec(line);
    if (m !== null) {
      const start = Number(m[3]);
      rows.push({
        slug: m[1] as string,
        id: Number(m[2]),
        startLine: start,
        endLine: m[4] === undefined ? start : Number(m[4]),
      });
    }
  }
  return rows;
}

export function selectMutants(rows: MutantRow[], changedLines: Set<number>): MutantRow[] {
  return rows.filter((r) => [...changedLines].some((l) => l >= r.startLine && l <= r.endLine));
}

export type Survivor = {
  id: number;
  slug: string;
  line: number;
  oldText: string;
  newText: string;
};

export type FileReport = { file: string; selected: number; survivors: Survivor[] };

function clip(text: string): string {
  const flat = text.replaceAll("`", "'").replaceAll("\n", " ").replaceAll("\r", " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

export function buildReport(input: {
  base: string;
  head: string;
  changedCount: number;
  files: FileReport[];
  counts: { caught: number; uncaught: number; other: number };
  errors: string[];
}): string {
  const out: string[] = ["<!-- mutation-testing -->"];
  if (input.changedCount === 0) {
    out.push(
      "",
      "## Mutation testing",
      "",
      `No src/ changes vs \`${input.base}\` — nothing to mutate.`,
    );
    return `${out.join("\n")}\n`;
  }
  const total = input.counts.caught + input.counts.uncaught + input.counts.other;
  out.push(
    "",
    "## Mutation testing (report-only)",
    "",
    `${input.changedCount} src file(s) changed vs \`${input.base}\` (head \`${input.head}\`). High/medium mutants on the changed lines: **${total} tested — ${input.counts.caught} caught, ${input.counts.uncaught} survived**${input.counts.other > 0 ? `, ${input.counts.other} other (timeout/skipped)` : ""}.`,
    "",
    "Surviving mutants are informational and do not fail CI.",
  );
  if (total === 0) {
    out.push("", "No high/medium mutants on the changed lines.");
    if (input.errors.length > 0) {
      out.push("", "### Errors", "");
      for (const e of input.errors) out.push(`- ${e}`);
    }
    return `${out.join("\n")}\n`;
  }
  const withSurvivors = input.files.filter((f) => f.survivors.length > 0);
  if (withSurvivors.length === 0) {
    out.push("", "No surviving mutants.");
  } else {
    out.push("", "### Surviving mutants", "");
    for (const f of withSurvivors) {
      out.push(`**${f.file}**`);
      for (const s of f.survivors) {
        out.push(
          `- line ${s.line} — \`${s.slug}\` #${s.id}: \`${clip(s.oldText)}\` → \`${clip(s.newText)}\``,
        );
      }
      out.push("");
    }
  }
  if (input.errors.length > 0) {
    out.push("### Errors", "");
    for (const e of input.errors) out.push(`- ${e}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

type MewtResult = {
  results: {
    mutant: {
      id: number;
      mutation_slug: string;
      line_offset: number;
      old_text: string;
      new_text: string;
    };
    target: { path: string };
    outcome: { status: string };
  }[];
};

function mewt(args: string[], capture: boolean): string {
  const proc = Bun.spawnSync(["mewt", ...args], {
    cwd: ROOT,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  if (proc.exitCode !== 0) {
    const detail = capture ? new TextDecoder().decode(proc.stderr).trim() : "";
    throw new Error(`mewt ${args.slice(0, 2).join(" ")} failed (exit ${proc.exitCode}) ${detail}`);
  }
  return capture ? new TextDecoder().decode(proc.stdout) : "";
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function gitHead(root: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "unknown";
}

// Written when the run dies before a real report exists, so the PR comment
// shows the failure instead of keeping a stale result from an earlier push.
function failureReport(base: string, head: string, detail: string): string {
  return `<!-- mutation-testing -->\n\n## Mutation testing (report-only)\n\nThe mutation run failed vs \`${base}\` (head \`${head}\`): ${clip(detail)}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  const baseFlag = args.indexOf("--base");
  const base = baseFlag === -1 ? undefined : args[baseFlag + 1];
  const outFlag = args.indexOf("--out");
  const outPath = outFlag === -1 ? "mutation-report.md" : args[outFlag + 1];
  if (base === undefined || outPath === undefined) {
    console.error("usage: bun scripts/mutation-report.ts --base <ref> [--out <file>]");
    process.exit(2);
  }

  const added = gitAddedLines(base, ROOT);
  if (added === null) process.exit(2);
  const changed = [...added.entries()].filter(
    ([f]) => f.startsWith("src/") && existsSync(join(ROOT, f)),
  );
  const head = gitHead(ROOT);

  const tmp = mkdtempSync(join(tmpdir(), "mewt-"));
  const db = join(tmp, "mewt.sqlite");
  const files: FileReport[] = [];
  const errors: string[] = [];
  let exitCode = 0;
  try {
    for (const [file, lines] of changed) {
      try {
        mewt(["mutate", file, "--db", db], false);
        const table = mewt(
          [
            "print",
            "mutants",
            "--target",
            file,
            "--severity",
            SEVERITIES,
            "--format",
            "table",
            "--untested",
            "--db",
            db,
          ],
          true,
        );
        const picked = selectMutants(parseMutantTable(table), lines);
        if (picked.length === 0) continue;
        files.push({ file, selected: picked.length, survivors: [] });
        const t = MUTATION_TESTS[file] ?? FALLBACK_TEST;
        console.log(`${file}: testing ${picked.length} mutant(s) on changed lines`);
        mewt(
          [
            "test",
            "--ids",
            picked.map((m) => m.id).join(","),
            "--test.cmd",
            // --bail stops a caught mutant's test run at the first failure;
            // uncaught mutants run the whole suite either way.
            `${t.cmd} --bail`,
            "--test.timeout",
            String(t.timeout),
            "--db",
            db,
          ],
          false,
        );
      } catch (err) {
        const msg = errMsg(err);
        errors.push(`${file}: ${clip(msg)}`);
        console.error(`${file}: ${msg}`);
      }
    }

    const counts = { caught: 0, uncaught: 0, other: 0 };
    const byFile = new Map<string, Survivor[]>();
    if (files.length > 0) {
      const json = mewt(["results", "--all", "--format", "json", "--db", db], true);
      const parsed = JSON.parse(json) as MewtResult;
      for (const r of parsed.results ?? []) {
        const status = r.outcome.status;
        if (status === "TestFail") counts.caught++;
        else if (status === "Uncaught") counts.uncaught++;
        else counts.other++;
        if (status !== "Uncaught") continue;
        const list = byFile.get(r.target.path) ?? [];
        list.push({
          id: r.mutant.id,
          slug: r.mutant.mutation_slug,
          line: r.mutant.line_offset + 1,
          oldText: r.mutant.old_text,
          newText: r.mutant.new_text,
        });
        byFile.set(r.target.path, list);
      }
    }
    for (const f of files) f.survivors = byFile.get(f.file) ?? [];

    const report = buildReport({
      base,
      head,
      changedCount: changed.length,
      files,
      counts,
      errors,
    });
    writeFileSync(outPath, report);
    console.log(
      `mutation report: ${counts.caught} caught, ${counts.uncaught} survived -> ${outPath}`,
    );
  } catch (err) {
    console.error(`mutation report failed: ${errMsg(err)}`);
    try {
      writeFileSync(outPath, failureReport(base, head, errMsg(err)));
    } catch (writeErr) {
      console.error(`could not write ${outPath}: ${errMsg(writeErr)}`);
    }
    exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

if (import.meta.main) main();
