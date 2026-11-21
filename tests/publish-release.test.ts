import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type Sandbox, sandbox } from "./helpers/run";

const SCRIPT = resolve(import.meta.dir, "../scripts/publish-release.sh");
const TAG = "v0.1.1-rc.2";
const BUILT = "aaa  uptime-kuma-cli-linux-x64\n";
const OTHER = "bbb  uptime-kuma-cli-linux-x64\n";

let sb: Sandbox;
let calls: string;

const git = (...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: sb.dir });

beforeEach(() => {
  sb = sandbox();
  calls = join(sb.dir, "gh-calls");
  mkdirSync(join(sb.dir, "bin"));
  mkdirSync(join(sb.dir, "dist"));
  writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), BUILT);
  writeFileSync(join(sb.dir, "dist", "uptime-kuma-cli-linux-x64"), "binary");
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");

  // A fake gh that records the arguments it was called with and checks the --jq that
  // shapes each answer the script parses: a call without it, or with a different one,
  // fails here instead of letting the script read a shape it does not expect (#4).
  // CREATE / VIEW / PUBLISHED_SUMS / PUBLISHED_ASSETS / IS_DRAFT decide the outcome
  const gh = join(sb.dir, "bin", "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$*" >> "${calls}"
want_jq() {
  want="$1"; label="$2"; shift 2
  prev=""
  for arg in "$@"; do
    if [ "$prev" = --jq ]; then
      [ "$arg" = "$want" ] || { echo "gh: $label --jq is '$arg', want '$want'" >&2; exit 1; }
      return 0
    fi
    prev="$arg"
  done
  echo "gh: $label has no --jq '$want'" >&2
  exit 1
}
if [ "$1" = api ]; then
  case "$*" in
    *"--method POST"*git/refs*)
      if [ -n "\${REF_CREATE_ERROR:-}" ]; then echo "\${REF_CREATE_ERROR}" >&2; exit 1; fi
      if [ -n "\${REF_EXISTING:-}" ]; then echo "gh: Reference already exists (HTTP 422)" >&2; exit 1; fi
      if [ -n "\${REF_422_OTHER:-}" ]; then echo "gh: \${REF_422_OTHER} (HTTP 422)" >&2; exit 1; fi
      exit 0 ;;
    *"--method DELETE"*git/refs/tags/*) exit 0 ;;
    *git/ref/tags/*)
      want_jq '.object.type + " " + .object.sha' 'git/ref/tags' "$@"
      if [ -n "\${REF_READ_ERROR:-}" ]; then echo "\${REF_READ_ERROR}" >&2; exit 1; fi
      echo "\${REF_TYPE:-commit} \${REF_NOW:-\${REF_EXISTING:-}}" ;;
    *git/tags/*)
      want_jq '.object.sha' 'git/tags' "$@"
      if [ -n "\${TAG_READ_ERROR:-}" ]; then echo "\${TAG_READ_ERROR}" >&2; exit 1; fi
      echo "\${TAG_TARGET:-}" ;;
    *) exit 98 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "release create") exit "\${CREATE:-0}" ;;
  "release view")
    case "$*" in
      *"--json isDraft"*)
        want_jq '.isDraft' 'release view --json isDraft' "$@"
        echo "\${IS_DRAFT:-false}" ;;
      *"--json assets"*)
        want_jq '.assets[] | "\\(.name)\\t\\(.digest)"' 'release view --json assets' "$@"
        printf '%s\n' "\${PUBLISHED_ASSETS:-}" ;;
      *)
        if [ -n "\${VIEW_ERROR:-}" ]; then echo "\${VIEW_ERROR}" >&2; exit 1; fi
        if [ "\${VIEW:-0}" != 0 ]; then echo "release not found" >&2; fi
        exit "\${VIEW:-0}" ;;
    esac ;;
  "release list")
    want_jq '.[].tagName' 'release list' "$@"
    if [ -n "\${LIST_ERROR:-}" ]; then echo "\${LIST_ERROR}" >&2; exit 1; fi
    [ -z "\${LIST_WARN:-}" ] || echo "\${LIST_WARN}" >&2
    if [ -n "\${PUBLISHED_TAGS+x}" ]; then printf '%s\n' "\${PUBLISHED_TAGS}"; else git tag --list 'v*'; fi ;;
  "release download")
    [ -n "$PUBLISHED_SUMS" ] || exit 1
    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    cp "$PUBLISHED_SUMS" "$dir/SHA256SUMS" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});
afterEach(() => sb.cleanup());

const head = () =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sb.dir }).stdout.toString().trim();

function publish(env: Record<string, string | undefined> = {}) {
  const published = join(sb.dir, "published");
  return Bun.spawnSync(["/bin/sh", SCRIPT], {
    cwd: sb.dir,
    env: {
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      HOME: sb.home,
      TAG,
      MAIN_SHA: head(),
      RELEASE_TRIGGER: "push",
      PUBLISHED_SUMS: published,
      PUBLISHED_ASSETS: "uptime-kuma-cli-linux-x64\tsha256:aaa",
      ...env,
    },
  });
}

/** The SHA256SUMS of an already-published release */
function published(sums: string): void {
  writeFileSync(join(sb.dir, "published"), sums);
}

const ghCalls = () => readFileSync(calls, "utf8");

describe("publish-release.sh", () => {
  test("creates a release that does not exist yet", () => {
    const r = publish();

    expect(r.exitCode).toBe(0);
    expect(head()).toMatch(/^[0-9a-f]{40}$/);
    expect(ghCalls()).toContain(`release create v0.1.1-rc.2 --target ${head()} --latest=true `);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("does not make a release for a commit that is not main's head Latest", () => {
    const r = publish({ MAIN_SHA: "0123456789abcdef0123456789abcdef01234567" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`--target ${head()} --latest=false `);
  });

  // Even with nothing to compare against, the comparison must not fail looking for a
  // target (#15)
  test("does not stop on the version comparison even in a checkout with no tags", () => {
    const r = publish({ MAIN_SHA: "0123456789abcdef0123456789abcdef01234567", VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} --latest=false `);
  });

  test("stops without creating a release when MAIN_SHA is missing", () => {
    const r = publish({ MAIN_SHA: "" });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("MAIN_SHA");
    expect(existsSync(calls)).toBe(false);
  });

  test("succeeds doing nothing when already published with the same SHA256SUMS", () => {
    published(BUILT);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
    // It reports success only after checking the release's asset list, not just the sums
    expect(ghCalls()).toContain(`release view ${TAG} --json assets`);
  });

  // A draft does not point /releases/latest at itself, so it cannot count as published (#10)
  test("does not succeed while still a draft even if already published", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", IS_DRAFT: "true" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} is a draft`);
    expect(r.stdout.toString()).not.toContain("already published");
  });

  // Even with matching SHA256SUMS, a release missing binaries is a broken distribution (#10)
  test("does not succeed when binaries are missing even if SHA256SUMS match", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_ASSETS: "SHA256SUMS\tsha256:bbb" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`release ${TAG} has no asset uptime-kuma-cli-linux-x64`);
  });

  // Names alone are not enough: an asset under the right name with other bytes is not
  // the published one (#4)
  test("does not succeed when an attached asset's digest differs from SHA256SUMS", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_ASSETS: "uptime-kuma-cli-linux-x64\tsha256:bbb" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("different digest");
  });

  test("does not succeed when an attached asset carries no digest", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_ASSETS: "uptime-kuma-cli-linux-x64" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("reports no digest");
  });

  // jq prints null for a digest field the gh on the runner cannot read; that is a
  // missing digest, not a different one, and must not read as "fix or delete" (#4)
  test("does not succeed when gh reports a null digest for an attached asset", () => {
    published(BUILT);

    const r = publish({ CREATE: "1", PUBLISHED_ASSETS: "uptime-kuma-cli-linux-x64\tnull" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("reports no digest");
  });

  // gh's stderr is not release data: a warning line that happens to look like a tag must
  // not become a version the new tag is compared against (#4)
  test("does not read a tag-shaped warning on stderr as a published release", () => {
    const r = publish({
      MAIN_SHA: "0123456789abcdef0123456789abcdef01234567",
      VIEW: "1",
      PUBLISHED_TAGS: "",
      LIST_WARN: "v0.0.1",
    });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} --latest=false `);
  });

  test("fails rather than treating an empty SHA256SUMS as the same", () => {
    published("");
    writeFileSync(join(sb.dir, "dist", "SHA256SUMS"), "");

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("empty SHA256SUMS");
  });

  test("fails without overwriting when already published with different SHA256SUMS", () => {
    published(OTHER);

    const r = publish({ CREATE: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("not overwriting");
  });

  test("fails with the create failure as the real one when the release cannot be read", () => {
    const r = publish({ CREATE: "1", VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("the failure above is the real one");
  });

  test("fails rather than treating it as the same when published but SHA256SUMS is missing", () => {
    const r = publish({ CREATE: "1", PUBLISHED_SUMS: "" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("without SHA256SUMS");
  });

  test("does not upload or --clobber to an already-published release with different SHA256SUMS", () => {
    published(OTHER);
    publish({ CREATE: "1" });

    expect(ghCalls()).not.toContain("upload");
    expect(ghCalls()).not.toContain("--clobber");
  });

  // gh release create uses --target only when it creates the tag itself. If the tag
  // already exists it stays on another commit, so binaries built from a different commit
  // would be distributed under that tag's name (#9)
  describe("when the tag already points at another commit", () => {
    test("stops without creating a release", () => {
      git("tag", TAG);
      const tagged = head();
      writeFileSync(join(sb.dir, "file"), "x");
      git("add", "-A");
      git("commit", "-q", "-m", "y");
      expect(head()).not.toBe(tagged);

      const r = publish();

      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(`tag ${TAG} already points at ${tagged}`);
      expect(existsSync(calls)).toBe(false);
    });

    // A re-run on the same commit (re-running a failed run, dispatching an existing tag)
    // must pass through
    test("creates the release as is when the tag is on the same commit", () => {
      git("tag", TAG);

      const r = publish();

      expect(r.exitCode).toBe(0);
      expect(ghCalls()).toContain(`release create ${TAG} --target ${head()} `);
    });
  });
});

describe("publish-release.sh: a newer version number on an old commit (#15)", () => {
  // v0.1.0 on old (HEAD), v0.2.0-rc.3 on the main ahead of it. HEAD goes back to old
  let oldSha: string;
  let mainSha: string;
  beforeEach(() => {
    oldSha = head();
    git("tag", "v0.1.0");
    git("commit", "-q", "--allow-empty", "-m", "main");
    mainSha = head();
    git("tag", "v0.2.0-rc.3");
    git("checkout", "-q", oldSha);
  });

  test("does not publish a new tag with a version higher than main's from an old commit", () => {
    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.3");
    expect(r.stderr.toString()).toContain("git push origin :refs/tags/v0.2.0");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("also stops on a new hand-pushed tag already in the checkout, without comparing it to itself", () => {
    git("tag", "v0.2.0");

    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.3");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("publishes a version below the existing maximum even from an old commit, without making it Latest", () => {
    const r = publish({ TAG: "v0.0.9", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.0.9 --target ${oldSha} --latest=false `);
  });

  test("does not stop a re-run of an already-published tag even on an old commit", () => {
    git("tag", "v0.3.0");
    published(BUILT);

    const r = publish({ TAG: "v0.3.0", MAIN_SHA: mainSha, CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  // The rc number is not a string. rc.10 and rc.9 are compared, so sorting as strings
  // would invert the order
  test("compares rc numbers as numbers", () => {
    git("tag", "v0.2.0-rc.9");

    const r = publish({ TAG: "v0.2.0-rc.10", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.2.0-rc.9");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("makes a normal final version on main's head Latest", () => {
    git("checkout", "-q", mainSha);

    const r = publish({ TAG: "v0.2.0", MAIN_SHA: mainSha, VIEW: "1" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.2.0 --target ${mainSha} --latest=true `);
  });
});

describe("publish-release.sh: version ordering and paths (second round of #15)", () => {
  // In lexicographic order v0.1.0 < v0.10.0-rc.1 < v0.2.0 < v0.9.0. The semver maximum
  // v0.10.0-rc.1 comes neither first nor last
  let oldSha: string;
  let mainSha: string;
  beforeEach(() => {
    oldSha = head();
    git("tag", "v0.1.0");
    git("tag", "v0.2.0");
    git("tag", "v0.9.0");
    git("commit", "-q", "--allow-empty", "-m", "main");
    mainSha = head();
    git("tag", "v0.10.0-rc.1");
    git("checkout", "-q", oldSha);
  });
  const old = (env: Record<string, string | undefined>) =>
    publish({ MAIN_SHA: mainSha, VIEW: "1", ...env });

  test("compares minor as a number: publishes v0.9.5 because it is below v0.10.0-rc.1", () => {
    const r = old({ TAG: "v0.9.5" });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.9.5 --target ${oldSha} --latest=false `);
  });

  test("a final version sits above its rc: stops v0.10.0", () => {
    const r = old({ TAG: "v0.10.0" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("decided by major: stops v1.0.0", () => {
    const r = old({ TAG: "v1.0.0" });

    expect(r.exitCode).toBe(1);
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("decided by patch: with v0.10.2 on main, stops v0.10.3 and lets v0.10.1 through", () => {
    git("tag", "v0.10.2", mainSha);

    const high = old({ TAG: "v0.10.3" });
    expect(high.exitCode).toBe(1);
    expect(high.stderr.toString()).toContain("v0.10.2");

    const low = old({ TAG: "v0.10.1" });
    expect(low.exitCode).toBe(0);
    expect(ghCalls()).toContain(`release create v0.10.1 --target ${oldSha} --latest=false `);
  });

  test("for an automatic rc, if main moved on, exits green without publishing and leaves a notice", () => {
    const r = old({ TAG: "v0.10.0-rc.2", RELEASE_TRIGGER: "workflow_run" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("::notice::");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("git/refs");
  });

  test("workflow_dispatch also stops a higher version number with no release (closes the way around a tag refused on push)", () => {
    const r = old({ TAG: "v0.10.0", RELEASE_TRIGGER: "workflow_dispatch" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(ghCalls()).not.toContain("release create");
  });

  test("a workflow_dispatch re-release is not stopped by the version number when a release exists", () => {
    published(BUILT);

    const r = old({ TAG: "v0.10.0", RELEASE_TRIGGER: "workflow_dispatch", VIEW: "0", CREATE: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("already published");
  });

  test("an automatic rc on main's head is published as is and made Latest", () => {
    git("checkout", "-q", mainSha);

    const r = old({ TAG: "v0.10.0-rc.2", RELEASE_TRIGGER: "workflow_run" });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).not.toContain("::notice::");
    expect(ghCalls()).toContain(`release create v0.10.0-rc.2 --target ${mainSha} --latest=true `);
  });

  test("only published releases are compared: a leftover higher tag with no release does not set the ceiling", () => {
    git("tag", "v1.0.0", oldSha);

    const r = old({
      TAG: "v0.11.0",
      PUBLISHED_TAGS: "v0.1.0\nv0.2.0\nv0.10.0-rc.1\nv0.9.0",
    });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release list --exclude-drafts --limit 1000 ");
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(r.stderr.toString()).not.toContain("v1.0.0");
    expect(ghCalls()).not.toContain("release create");
  });

  test("stops with the reason when the release list cannot be read", () => {
    const r = old({ TAG: "v0.9.5", LIST_ERROR: "HTTP 503: Service Unavailable" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 503: Service Unavailable");
    expect(ghCalls()).not.toContain("release create");
  });

  test("the refusal message also shows the way to release a legitimate tag later via dispatch", () => {
    const r = old({ TAG: "v0.10.0" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("workflow_dispatch");
  });

  test("stops without creating a release when RELEASE_TRIGGER is missing", () => {
    const r = old({ TAG: "v0.9.5", RELEASE_TRIGGER: undefined });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("RELEASE_TRIGGER");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("stops with the reason when it cannot tell whether a release exists (a failure other than not found)", () => {
    const r = old({ TAG: "v0.9.5", VIEW_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 502: Bad Gateway");
    expect(ghCalls()).not.toContain("release create");
  });

  test("stops on a version number wider than the release shape allows", () => {
    const r = old({ TAG: "v99999999999999999999.0.0" });

    expect(r.exitCode).toBe(1);
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });

  test("does not count a tag with a leading zero among the comparison partners", () => {
    git("tag", "v0.011.0", mainSha);

    const r = old({ TAG: "v0.10.0-rc.2" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.10.0-rc.1");
    expect(r.stderr.toString()).not.toContain("v0.011.0");
  });
});

describe("publish-release.sh: create the tag first to close the race (#14)", () => {
  const other = "0123456789abcdef0123456789abcdef01234567";

  test("creates the tag via the API on the built commit first, and attaches the release only to an existing tag", () => {
    const r = publish({ VIEW: "1" });

    expect(r.exitCode).toBe(0);
    const calls = ghCalls();
    expect(calls).toContain(
      `api --method POST repos/{owner}/{repo}/git/refs -f ref=refs/tags/${TAG} -f sha=${head()}`,
    );
    expect(calls).toMatch(new RegExp(`release create ${TAG} .*--verify-tag`));
    expect(calls.indexOf("git/refs")).toBeLessThan(calls.indexOf("release create"));
  });

  test("stops without creating a release if a same-named tag appears on another commit after the check", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: other });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(other);
    expect(r.stderr.toString()).toContain(head());
    expect(ghCalls()).not.toContain("release create");
  });

  test("attaches the release as is when an existing tag points at the same commit (a re-run)", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: head() });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toMatch(new RegExp(`release create ${TAG} .*--verify-tag`));
  });

  test("compares an annotated tag by the commit it points at", () => {
    const tagObject = "fedcba9876543210fedcba9876543210fedcba98";

    const same = publish({
      VIEW: "1",
      REF_EXISTING: tagObject,
      REF_TYPE: "tag",
      TAG_TARGET: head(),
    });
    expect(same.exitCode).toBe(0);
    expect(ghCalls()).toContain(`git/tags/${tagObject}`);

    const diff = publish({
      VIEW: "1",
      REF_EXISTING: tagObject,
      REF_TYPE: "tag",
      TAG_TARGET: other,
    });
    expect(diff.exitCode).toBe(1);
    expect(diff.stderr.toString()).toContain(other);
  });

  test("stops with the reason when the failure to create the tag is something other than 'already exists'", () => {
    const r = publish({
      VIEW: "1",
      REF_CREATE_ERROR: "HTTP 403: Resource not accessible by integration",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 403: Resource not accessible by integration");
    expect(ghCalls()).not.toContain("release create");
  });

  test("reads an existing tag at the ref its name says, and an annotated one at its tag object", () => {
    const tagObject = "fedcba9876543210fedcba9876543210fedcba98";

    const r = publish({ VIEW: "1", REF_EXISTING: tagObject, REF_TYPE: "tag", TAG_TARGET: head() });

    expect(r.exitCode).toBe(0);
    const calls = ghCalls();
    expect(calls).toContain(`api repos/{owner}/{repo}/git/ref/tags/${TAG} `);
    expect(calls).toContain(`api repos/{owner}/{repo}/git/tags/${tagObject} `);
  });

  test("stops with the reason when the existing tag cannot be read", () => {
    const r = publish({ VIEW: "1", REF_EXISTING: head(), REF_READ_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 502: Bad Gateway");
    expect(ghCalls()).not.toContain("release create");
  });

  test("stops without reading an existing tag on a 422 other than 'already exists'", () => {
    const r = publish({ VIEW: "1", REF_422_OTHER: "Repository rule violations found" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Repository rule violations found");
    expect(ghCalls()).not.toContain("git/ref/tags/");
    expect(ghCalls()).not.toContain("release create");
  });

  test("deletes a tag it made itself when the release cannot be created and no release exists", () => {
    const r = publish({ VIEW: "1", CREATE: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain(`api --method DELETE repos/{owner}/{repo}/git/refs/tags/${TAG}`);
  });

  test("keeps the tag when a release remains even if this run could not create one (the release is not detached)", () => {
    const r = publish({ CREATE: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
    expect(r.stderr.toString()).toContain("is kept: a release exists for it");
  });

  test("a run that created the release does not delete the tag even if the view right after returns not found", () => {
    const r = publish({ VIEW: "1", REF_NOW: head() });

    expect(r.exitCode).toBe(0);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("does not delete the tag when it cannot tell whether a release exists", () => {
    const r = publish({ CREATE: "1", REF_NOW: head(), VIEW_ERROR: "HTTP 502: Bad Gateway" });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).toContain("release create");
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("does not delete the tag if it moved to another commit just before deletion", () => {
    const r = publish({
      VIEW: "1",
      CREATE: "1",
      REF_NOW: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  test("stops with the reason when an annotated tag's object cannot be read", () => {
    const r = publish({
      VIEW: "1",
      REF_EXISTING: "fedcba9876543210fedcba9876543210fedcba98",
      REF_TYPE: "tag",
      TAG_READ_ERROR: "HTTP 500: Internal Server Error",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("HTTP 500: Internal Server Error");
    expect(ghCalls()).not.toContain("release create");
  });

  test("does not delete a tag that existed before even when the release cannot be created", () => {
    const r = publish({ VIEW: "1", CREATE: "1", REF_EXISTING: head() });

    expect(r.exitCode).toBe(1);
    expect(ghCalls()).not.toContain("--method DELETE");
  });

  // A leftover tag looks like a same-named tag to the next run and pushes the next tag's
  // number above it, so a run that decided to stop must not create a tag afterwards
  test("a run stopped by the version number creates no tag either", () => {
    git("tag", "v0.1.0");

    const r = publish({
      TAG: "v9.9.9-rc.1",
      MAIN_SHA: "0123456789abcdef0123456789abcdef01234567",
      VIEW: "1",
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("v0.1.0");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("git/refs");
    expect(existsSync(calls) ? ghCalls() : "").not.toContain("release create");
  });
});
