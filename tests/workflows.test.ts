import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import pkg from "../package.json" with { type: "json" };
import { CODERABBIT_CONTEXT } from "../scripts/coderabbit-gate.ts";
import { TEST_LIMIT_MS } from "../scripts/integration-limit.ts";
import { TAG_SHAPE } from "../scripts/next-tag.ts";

const WORKFLOWS = ["ci.yml", "coderabbit-review.yml", "release.yml"];
const dir = resolve(import.meta.dir, "../.github/workflows");
const read = (file: string) => readFileSync(join(dir, file), "utf8");
// Bun handles the YAML parsing, so types are only attached where needed
const release = () =>
  Bun.YAML.parse(read("release.yml")) as {
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
      tag: { steps: { name: string; run?: string }[] };
      build: { steps: { name: string; run?: string; env?: Record<string, string> }[] };
      publish: {
        concurrency: { group: string; queue: string; "cancel-in-progress": boolean };
        permissions?: Record<string, string>;
        steps: { name: string; run?: string; env?: Record<string, string> }[];
      };
    };
  };
type Job = keyof ReturnType<typeof release>["jobs"];
const stepRun = (job: Job, name: string) =>
  release().jobs[job].steps.find((step) => step.name === name)?.run ?? "";
const releaseStep = () =>
  release().jobs.publish.steps.find((step) => step.name === "release")?.run ?? "";

const REPO = "TakashiAihara/uptime-kuma-cli";

// Nothing at hand evaluates GitHub expressions, so only the shape the concurrency
// expression uses (string ==, &&, ||, parentheses) is evaluated naively. The same rules
// as GHA: && returns the left side when it is falsy, || returns the left side when it is
// truthy, and an empty string is falsy. A path that is not found is an empty string.
const evaluate = (tokens: string[], context: Record<string, unknown>): string => {
  let i = 0;
  const peek = () => tokens[i];
  const lookup = (path: string) =>
    String(
      path
        .split(".")
        .reduce<unknown>((v, k) => (v == null ? undefined : (v as never)[k]), context) ?? "",
    );
  const atom = (): string => {
    const token = tokens[i++]!;
    if (token === "(") {
      const value = or();
      i++; // )
      return value;
    }
    return token.startsWith("'") ? token.slice(1, -1) : lookup(token);
  };
  const eq = (): string => {
    const left = atom();
    if (peek() !== "==") return left;
    i++;
    return atom() === left ? "true" : "";
  };
  const and = (): string => {
    let left = eq();
    while (peek() === "&&") {
      i++;
      const right = eq();
      left = left ? right : left;
    }
    return left;
  };
  // A function declaration (hoisted) so it can be referenced from atom first
  function or(): string {
    let left = and();
    while (peek() === "||") {
      i++;
      const right = and();
      left = left || right;
    }
    return left;
  }
  return or();
};

// Returns the group name from evaluating release.yml's concurrency expression with that
// run's event info. run_id is fixed at 1, so every "run_id group" becomes "release-1".
const groupFor = (eventName: string, event?: string, headRepository?: string) => {
  const source = release()
    .concurrency.group.replace(/^release-\$\{\{/, "")
    .replace(/\}\}$/, "");
  const tokens = [...source.matchAll(/\s*('[^']*'|[A-Za-z_][\w.]*|==|&&|\|\||[()])/g)].map(
    (m) => m[1]!,
  );
  return (
    "release-" +
    evaluate(tokens, {
      github: {
        event_name: eventName,
        run_id: 1,
        repository: REPO,
        event: {
          workflow_run: {
            event,
            head_repository: { full_name: headRepository },
          },
        },
      },
    })
  );
};

describe("release.yml concurrency", () => {
  // Whether a run can be cancelled is decided per run, not per job, so a run that skips
  // every job would still cancel a queued main run if it entered the main group. Even
  // with cancel-in-progress false, a later run cancels an earlier pending one.
  // That is why only "the CI run for a push to this repo's main" enters the main group.
  test("only the run for a push to this repo's main enters the main group", () => {
    expect(groupFor("workflow_run", "push", REPO)).toBe("release-main");
  });

  // This repo's PR CI also triggers workflow_run. Its jobs are all skipped because the
  // event is not push, but the run itself enters the queue. It must not share main's group
  test("this repo's PR run enters its own run_id group", () => {
    expect(groupFor("workflow_run", "pull_request", REPO)).toBe("release-1");
  });

  // A push to a branch named main inside a fork is also not a push to this repo's main,
  // so it goes to the run_id side (#3)
  test("a fork's run enters its own run_id group", () => {
    expect(groupFor("workflow_run", "push", "someone/uptime-kuma-cli")).toBe("release-1");
  });

  // Releases of hand-pushed tags and re-dispatches each get their own group, so a later
  // main run cannot cancel them
  test("a tag push and a manual dispatch each enter their own run_id group", () => {
    expect(groupFor("push")).toBe("release-1");
    expect(groupFor("workflow_dispatch")).toBe("release-1");
  });

  test("cancel-in-progress is false", () => {
    expect(release().concurrency["cancel-in-progress"]).toBe(false);
  });
});

// The publish job is where MAIN_SHA is read and the release created, so it is the only
// job that must serialize across triggers — the workflow-level groups above cannot do
// that, since a hand-pushed tag and a dispatch each get their own run_id group. The
// group name is a constant: an expression could split the triggers apart again, which
// is the race this guards (#3).
describe("release.yml publish concurrency", () => {
  test("every trigger's publish shares one fixed group", () => {
    const { group } = release().jobs.publish.concurrency;

    expect(group).toBe("release-publish");
    expect(group).not.toContain("${{");
  });

  // With the default single pending slot a newer publish cancels the one waiting, so a
  // queued hand-cut release would be dropped. queue: max lets up to 100 wait in line
  test("waiting publishes queue instead of being cancelled", () => {
    expect(release().jobs.publish.concurrency.queue).toBe("max");
  });

  // A release cut off mid-upload is worse than a late one
  test("a running publish is never cancelled", () => {
    expect(release().jobs.publish.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("pinning actions", () => {
  // Actions are pinned by commit (docker images by digest), not tag. Under a moved tag a
  // swapped action is used as proof of "what we built" in the signature
  test("pins everything by commit SHA / image digest and leaves the version in a trailing comment", () => {
    const uses: string[] = [];
    for (const file of WORKFLOWS) {
      for (const line of read(file).split("\n")) {
        // a uses key, not any line containing the substring ("statuses: write" does)
        if (!/^\s*-?\s*uses:/.test(line)) continue;
        uses.push(line);
        expect(line).toMatch(/uses:\s*\S+@([0-9a-f]{40}|sha256:[0-9a-f]{64})\s+#\s*v\S*\s*$/);
      }
    }

    expect(uses.length).toBeGreaterThan(0);
  });
});

describe("coderabbit-review.yml gate", () => {
  const gate = () =>
    (
      Bun.YAML.parse(read("coderabbit-review.yml")) as {
        jobs: {
          gate: {
            if?: string;
            concurrency?: { group: string; "cancel-in-progress": boolean };
            steps?: { uses?: string; with?: Record<string, unknown> }[];
          };
        };
      }
    ).jobs.gate;

  // the status-event filter and the script's CODERABBIT_CONTEXT are separate
  // literals; if they drift, CodeRabbit status events stop retriggering the
  // gate and a completed review leaves the required check pending forever
  test("the status-event filter watches the same context the script maps", () => {
    expect(gate().if).toContain(`'${CODERABBIT_CONTEXT}'`);
  });

  // pull_request_target and the status events CodeRabbit triggers can evaluate the
  // same head at once; without per-head serialization a stale run can overwrite a
  // newer gate status and leave the required check pending forever
  test("serializes runs per head SHA and lets the newest evaluation win", () => {
    const concurrency = gate().concurrency;

    expect(concurrency?.["cancel-in-progress"]).toBe(true);
    expect(concurrency?.group).toContain("pull_request.head.sha");
    expect(concurrency?.group).toContain("inputs.sha");
    expect(concurrency?.group).toContain("event.sha");
  });

  // the job runs with statuses: write; if checkout ever resolves a PR ref the
  // PR's own script would execute with that token — the default-branch pin is
  // the invariant the header comment promises
  test("checkout is pinned to the default branch without persisted credentials", () => {
    const checkout = gate().steps?.find((s) => s.uses?.startsWith("actions/checkout@"));

    expect(String(checkout?.with?.ref)).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  // workflow_dispatch executes the workflow file of the ref it was started on;
  // without the default-branch guard a maintainer re-evaluating a PR head could
  // run the PR's own copy of this workflow — and script — with statuses: write
  test("manual dispatch only runs from the default branch", () => {
    const ifCondition = gate().if ?? "";

    expect(ifCondition).toContain("workflow_dispatch");
    expect(ifCondition).toContain("github.event.repository.default_branch");
  });
});

// publish-release.sh compares against main's head and checks who a tag checked out by
// push / dispatch already belongs to. The checkout is shallow, so this only works once
// the release step's fetch takes everything. Version comparison uses gh release list, so
// it does not depend on this tag list.
describe("release.yml publish job", () => {
  test("fetches all tags before running publish-release.sh", () => {
    const run = releaseStep();

    expect(run).toContain("+refs/tags/*:refs/tags/*");
    expect(run).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(run.indexOf("+refs/tags/*")).toBeLessThan(run.indexOf("sh scripts/publish-release.sh"));
  });

  // push / workflow_run / workflow_dispatch differ in how they treat "a tag on a commit
  // that is not main's head". The script cannot tell the path apart from anything but the
  // event name, so if this env is missing the `:?` check stops it and it always fails
  // before creating a release
  test("passes the event name to publish-release.sh", () => {
    const env = release().jobs.publish.steps.find((step) => step.name === "release")?.env ?? {};

    expect(env.RELEASE_TRIGGER).toBe("${{ github.event_name }}");
  });

  // publish-release.sh creates the tag as a ref via the API, so without write permission
  // on this job no tag can be made and every release stops
  test("the job running the release step has contents: write, enough to create refs", () => {
    const publish = release().jobs.publish;

    expect(publish.permissions?.contents).toBe("write");
  });
});

// publish-release.sh strictly requires the tag shape after `:?` (no leading zeros, no
// number wider than 9 digits). A looser shape on the workflow side would run checkout
// and build to the end and only then fail in the script. The literals below are
// derived from TAG_SHAPE.source — next-tag.test.ts pins publish-release.sh's
// version_shape to the same source — so the three cannot drift apart (#4)
const RC_SHAPE = TAG_SHAPE.source.replace(
  "(-rc\\.(0|[1-9][0-9]{0,8}))?",
  "-rc\\.(0|[1-9][0-9]{0,8})",
);
describe("release.yml tag shape", () => {
  test("check the requested tag uses the same shape as publish-release.sh", () => {
    const run = stepRun("tag", "check the requested tag");

    expect(run).toContain(`shape='${TAG_SHAPE.source}'`);
    expect(run).not.toContain("[0-9]+\\.");
  });

  // A re-picked tag must also be releasable later; a loose shape would fail in the script
  test("decide the tag checks the rc tag picked for reuse against the same shape", () => {
    const run = stepRun("tag", "decide the tag");

    expect(run).toContain(`grep -E '${RC_SHAPE}'`);
  });
});

describe("release.yml: run all four on their runners before publishing (#13)", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type AnyJob = {
    needs?: string | string[];
    "runs-on"?: string;
    permissions?: Record<string, string>;
    strategy?: { "fail-fast"?: boolean; matrix?: { include?: Record<string, string>[] } };
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const uses = (job: AnyJob, action: string) =>
    job.steps.some((s) => s.uses?.startsWith(`${action}@`));

  test("the verify job runs each of the four on the runner for its OS / CPU", () => {
    const verify = jobs().verify!;
    const pairs = (verify.strategy?.matrix?.include ?? [])
      .map((m) => `${m.target} ${m.runner}`)
      .sort();

    expect(pairs).toEqual([
      "darwin-arm64 macos-15",
      "darwin-x64 macos-15-intel",
      "linux-arm64 ubuntu-24.04-arm",
      "linux-x64 ubuntu-24.04",
    ]);
    expect(verify["runs-on"]).toBe("${{ matrix.runner }}");
    expect(verify.strategy?.["fail-fast"]).toBe(false);
  });

  test("verify downloads and checks the artifact build uploaded, and does not build itself", () => {
    const { build, verify } = jobs();

    expect(uses(build!, "actions/upload-artifact")).toBe(true);
    expect(needs(verify!)).toContain("build");
    expect(uses(verify!, "actions/download-artifact")).toBe(true);
    expect(runs(verify!)).not.toContain("bun build");
    expect(runs(verify!)).not.toContain("scripts/build.ts");
    expect(runs(verify!)).toContain("scripts/run-binary.sh");
    expect(runs(verify!)).toMatch(/sha256sum|shasum/);
  });

  test("publishing waits for every verify to pass, downloads the same artifact, and checks SHA256SUMS", () => {
    const { publish } = jobs();

    expect(needs(publish!)).toEqual(expect.arrayContaining(["build", "verify"]));
    expect(uses(publish!, "actions/download-artifact")).toBe(true);
    expect(runs(publish!)).toMatch(/sha256sum -c|shasum -a 256 -c/);
    expect(uses(publish!, "actions/attest-build-provenance")).toBe(true);
    expect(runs(publish!)).toContain("sh scripts/publish-release.sh");
  });

  test("only the publish job holds write permissions", () => {
    const { build, verify, publish } = jobs();

    expect(build!.permissions?.contents ?? "read").toBe("read");
    expect(build!.permissions?.["id-token"]).toBeUndefined();
    expect(verify!.permissions?.contents ?? "read").toBe("read");
    expect(publish!.permissions?.contents).toBe("write");
    expect(publish!.permissions?.["id-token"]).toBe("write");
    expect(runs(build!)).not.toContain("publish-release.sh");
    expect(uses(build!, "actions/attest-build-provenance")).toBe(false);
  });
});

// The SHA256SUMS publish checks is the one build produced. If only the binaries or only
// the sums land in the artifact, what is published and what is checked disagree (#13)
describe("release.yml: the artifact build uploads (#13)", () => {
  type Step = {
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  };
  type Job = { steps: Step[] };
  const job = (name: string) =>
    (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, Job> }).jobs[name]!;
  const upload = () =>
    job("build").steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with ?? {};

  test("uploads the four binaries and SHA256SUMS to the same artifact", () => {
    const path = String(upload().path ?? "");

    expect(path).toContain("dist/uptime-kuma-cli-*");
    expect(path).toContain("dist/SHA256SUMS");
  });

  // What runs is the matrix target; what is inside is the tag being published. Missing
  // either means a different binary or a different tag was checked
  test("verify passes the tag and target to the script", () => {
    const step = job("verify").steps.find((s) => s.run?.includes("run-binary.sh"));

    expect(step?.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
    expect(step?.env?.TARGET).toBe("${{ matrix.target }}");
    expect(step?.run).toContain('sh scripts/run-binary.sh "dist/uptime-kuma-cli-$TARGET" "$TAG"');
  });
});

describe("ci.yml dependency audit", () => {
  const ci = () =>
    Bun.YAML.parse(read("ci.yml")) as {
      jobs: {
        check: {
          if?: string;
          "continue-on-error"?: boolean;
          steps: {
            name?: string;
            run?: string;
            if?: string;
            "continue-on-error"?: boolean;
          }[];
        };
      };
    };

  // bun audit is the only vulnerability gate for the transitive tree —
  // Dependabot's alerts read package.json, not bun.lock. Removing the step
  // silently drops that coverage, so pin that the check job still runs it
  // and cannot be told to skip it or swallow its failure. The run line may
  // carry the --ignore flags README documents for accepting a finding; the
  // value takes advisory-ID characters only, so a shell operator like `||`
  // cannot be smuggled in to mask the failure.
  const AUDIT_RUN = /^bun audit(?: --ignore[= ][A-Za-z0-9-]+)*$/;

  test("the check job fails on known vulnerabilities in bun.lock", () => {
    const audit = ci().jobs.check.steps.find((s) => s.name === "dependency audit");

    expect(audit?.run?.trim()).toMatch(AUDIT_RUN);
    expect(audit?.["continue-on-error"]).toBeUndefined();
    expect(audit?.if).toBeUndefined();
  });

  test("the check job cannot skip or ignore the audit step's failure", () => {
    expect(ci().jobs.check["continue-on-error"]).toBeUndefined();
    expect(ci().jobs.check.if).toBeUndefined();
  });

  test("the audit pin rejects run lines that mask a failure", () => {
    expect("bun audit || true").not.toMatch(AUDIT_RUN);
    expect("bun audit --ignore=123||true").not.toMatch(AUDIT_RUN);
  });
});

// The integration job is the only check that runs the suite against real Kuma
// images, and both matrix legs are required checks. Its env wiring is the soft
// spot: if UPTIME_KUMA_IT_IMAGE stopped reaching the step, both legs would run
// the compose default (1.23.17) and still pass — scripts/integration.ts only
// cross-checks the image's major when the variable is set.
describe("ci.yml integration job", () => {
  const job = () =>
    (
      Bun.YAML.parse(read("ci.yml")) as {
        jobs: {
          integration: {
            "timeout-minutes"?: number;
            "continue-on-error"?: boolean;
            if?: string;
            needs?: string | string[];
            permissions?: Record<string, string>;
            strategy?: { "fail-fast"?: boolean; matrix?: { image?: string[]; shard?: number[] } };
            steps: {
              run?: string;
              env?: Record<string, string>;
              "continue-on-error"?: boolean;
              "timeout-minutes"?: number;
              if?: string;
            }[];
          };
        };
      }
    ).jobs.integration;

  // Exactly one step must mention the runner: without this the assertions
  // below on step fields pass vacuously when the step is renamed or dropped
  const testStep = () => {
    const matches = job().steps.filter((s) => s.run?.includes("test:integration"));

    expect(matches.length).toBe(1);
    return matches[0]!;
  };

  // README promises the integration legs and the main ruleset requires a
  // check per image and shard; a matrix change also renames them, so the
  // failure would otherwise surface as stuck merges, not a red test. The
  // whole matrix is pinned — an `exclude`/`include` key could otherwise drop
  // or rename a leg while keeping the image list green
  test("the matrix runs both Kuma images in three shards, and a failing leg cannot cancel the other", () => {
    expect(job().strategy?.matrix).toEqual({
      image: ["louislam/uptime-kuma:1.23.17", "louislam/uptime-kuma:2.5.11"],
      shard: [1, 2, 3],
    });
    expect(job().strategy?.["fail-fast"]).toBe(false);
  });

  test("the matrix image and shard reach the runner through UPTIME_KUMA_IT_*", () => {
    const step = testStep();
    const shardCount = job().strategy?.matrix?.shard?.length;

    expect(step.run?.trim()).toBe("bun run test:integration");
    expect(step.env?.UPTIME_KUMA_IT_IMAGE).toBe("${{ matrix.image }}");
    // the shard spec's denominator is a literal in the env expression; it
    // must match the matrix width or legs would ask for impossible slices
    expect(step.env?.UPTIME_KUMA_IT_SHARD).toBe(`\${{ matrix.shard }}/${shardCount}`);
  });

  // The step above pins the script name, not what it runs. If
  // test:integration stopped pointing at scripts/integration.ts (which sets
  // UPTIME_KUMA_IT_URL), the suite would still run but skip every test, and
  // both legs would pass without ever checking the image
  test("test:integration runs the integration runner, not the test files directly", () => {
    expect(pkg.scripts["test:integration"]).toBe("bun scripts/integration.ts");
  });

  // timeout-minutes must cover the runner's own suite bound
  // (TEST_LIMIT_MS in scripts/integration-limit.ts — every CI leg is
  // sharded) plus image pull, build, setup and teardown — the 24 the job
  // sets is that documented budget, and a smaller value could kill the
  // suite mid-run and lose the runner's own timeout message and the
  // container logs it dumps; the step keeps no timeout of its own for
  // the same reason. The pin against TEST_LIMIT_MS requires at least 5
  // minutes of slack over the bound — a bare `>` would still pass if the
  // bound grew while setup alone pushes the total past 24.
  // permissions is pinned as the whole object: an added
  // pull-requests or id-token write would otherwise pass while widening
  // the token a job that pulls and runs external images gets
  test("the job is time-boxed over the suite's own budget and read-only", () => {
    const step = testStep();

    expect(job()["timeout-minutes"]).toBe(24);
    expect(job()["timeout-minutes"]! * 60_000).toBeGreaterThanOrEqual(TEST_LIMIT_MS + 5 * 60_000);
    expect(step["timeout-minutes"]).toBeUndefined();
    expect(job().permissions).toEqual({ contents: "read" });
  });

  // Both legs are required checks, and a skipped required check counts as
  // passing: a continue-on-error or a false `if` would report green without
  // gating, and a `needs` chain would skip the job when the dependency
  // fails. The `mutation` job's continue-on-error is legitimate because it
  // is report-only
  test("the job and the test step cannot skip or swallow a failure", () => {
    const step = testStep();

    expect(job().needs).toBeUndefined();
    expect(job()["continue-on-error"]).toBeUndefined();
    expect(job().if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.if).toBeUndefined();
  });
});

describe("release.yml: publish the checked commit and artifact as is (second round of #13)", () => {
  type Step = {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  };
  type AnyJob = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: unknown;
    outputs?: Record<string, string>;
    env?: Record<string, string>;
    steps: Step[];
  };
  const jobs = () => (Bun.YAML.parse(read("release.yml")) as { jobs: Record<string, AnyJob> }).jobs;
  const needs = (job: AnyJob) => ([] as string[]).concat(job.needs ?? []);
  const runs = (job: AnyJob) => job.steps.map((s) => s.run ?? "").join("\n");
  const stepsUsing = (job: AnyJob, action: string) =>
    job.steps.filter((s) => s.uses?.startsWith(`${action}@`));

  test("the tag job outputs the SHA of the commit it checked, and build / verify / publish check out that SHA", () => {
    const all = jobs();

    expect(all.tag!.outputs?.sha).toBe("${{ steps.commit.outputs.sha }}");
    const commit = all.tag!.steps.find((s) => s.id === "commit");
    expect(commit?.run).toContain('sha="$(git rev-parse HEAD)"');
    expect(commit?.run).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    for (const name of ["build", "verify", "publish"]) {
      const job = all[name]!;
      expect(needs(job)).toContain("tag");
      const checkouts = stepsUsing(job, "actions/checkout");
      expect(checkouts.length).toBe(1);
      expect(checkouts[0]!.with?.ref).toBe("${{ needs.tag.outputs.sha }}");
    }
  });

  // timeout-minutes counts the wait for a runner too, not just run time: at 15
  // minutes a starved leg was cancelled before its first step and publish was
  // skipped (#98). The smoke run takes well under a minute, so the budget is
  // mostly queue headroom; the pin is exact because 45 is the low end of the
  // range the issue suggests (45-60), the trade-off between surviving
  // starvation and capping a hung binary
  test("verify's time limit leaves room for runner queueing and still caps a hung binary", () => {
    expect(jobs().verify!["timeout-minutes"]).toBe(45);
  });

  test("the artifact states a retention period, and verify and publish download the name build uploaded", () => {
    const { build, verify, publish } = jobs();
    const up = stepsUsing(build!, "actions/upload-artifact");

    expect(up.length).toBe(1);
    const retention = up[0]!.with?.["retention-days"];
    expect(typeof retention).toBe("number");
    expect(retention as number).toBeLessThanOrEqual(30);
    const name = up[0]!.with?.name;
    expect(typeof name).toBe("string");
    for (const job of [verify!, publish!]) {
      const down = stepsUsing(job, "actions/download-artifact");
      expect(down.length).toBe(1);
      expect(down[0]!.with?.name).toBe(name);
    }
  });

  test("verify checks SHA256SUMS on both Linux and macOS and does not swallow run-binary.sh's failure", () => {
    const text = runs(jobs().verify!);

    expect(text).toContain("sha256sum -c");
    expect(text).toContain("shasum -a 256 -c");
    expect(text).toMatch(/^\s*sh scripts\/run-binary\.sh [^\n]*$/m);
    expect(text).not.toMatch(/run-binary\.sh[^\n]*(\|\||;)/);
  });

  test("publish does not pass verify's failure through the status function, checks every file, and receives TAG", () => {
    const publish = jobs().publish!;

    expect(publish.if).toBe("needs.tag.outputs.tag != ''");
    expect(runs(publish)).toMatch(/^\s*sha256sum -c SHA256SUMS\s*$/m);
    expect(publish.env?.TAG).toBe("${{ needs.tag.outputs.tag }}");
  });

  test("permissions are written as an object, and only publish holds the signing permissions", () => {
    const { build, verify, publish } = jobs();

    for (const job of [build!, verify!, publish!]) expect(typeof job.permissions).toBe("object");
    for (const job of [build!, verify!]) {
      const p = job.permissions as Record<string, string>;
      expect(p["id-token"]).toBeUndefined();
      expect(p.attestations).toBeUndefined();
      expect(p.contents).toBe("read");
    }
    const p = publish!.permissions as Record<string, string>;
    expect(p.attestations).toBe("write");
  });
});
