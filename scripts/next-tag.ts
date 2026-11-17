/**
 * The tag the next release gets: one release candidate past the highest `v*` tag.
 *
 *   vX.Y.Z-rc.N  ->  vX.Y.Z-rc.(N+1)
 *   vX.Y.Z       ->  vX.Y.(Z+1)-rc.1
 *
 * Parsed here rather than left to `git tag --sort=v:refname`, which puts `v0.1.0` below its
 * own release candidates: the final version would read as the oldest, and the next tag
 * would reuse a number that already exists.
 *
 * The shape is the one publish-release.sh's version_shape and release.yml's tag checks
 * enforce: no leading zeros, at most 9 digits per number. A looser read here would count
 * a tag the release side refuses — the push trigger takes any `v*`, so a hand-pushed
 * `v0.011.0` fails those checks, is never released, and stays in git — and a wider one
 * could count past what the shape can express. Tags in neither shape are ignored rather
 * than guessed at. With no tag at all, the first release candidate is counted from the
 * version in package.json, which is where a person decides the first version: `0.1.0`
 * gives `v0.1.0-rc.1`. Failing instead would leave every main push without a release
 * until someone cut a tag by hand.
 */
type Version = readonly [major: number, minor: number, patch: number, rc: number];

// The canonical tag shape: next-tag.test.ts pins publish-release.sh's
// version_shape to this source, and workflows.test.ts derives release.yml's
// literals from it, keeping all three equal.
export const TAG_SHAPE =
  /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-rc\.(0|[1-9][0-9]{0,8}))?$/;

/** A final version is above every release candidate of itself, so its rc is Infinity. */
function parse(tag: string): Version | null {
  const m = TAG_SHAPE.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[5] === undefined ? Infinity : Number(m[5])];
}

const compare = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

export function nextTag(tags: readonly string[], firstVersion: string): string {
  const versions = tags.map(parse).filter((v) => v !== null);
  let next: string;
  if (!versions.length) {
    if (!/^\d+\.\d+\.\d+$/.test(firstVersion)) {
      throw new Error(
        `no tag to count from, and package.json version "${firstVersion}" is not X.Y.Z`,
      );
    }
    next = `v${firstVersion}-rc.1`;
  } else {
    const [major, minor, patch, rc] = versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
    next =
      rc === Infinity
        ? `v${major}.${minor}.${patch + 1}-rc.1`
        : `v${major}.${minor}.${patch}-rc.${rc + 1}`;
  }
  // The tag job fails here, before the build: a candidate the release side would refuse
  // anyway (the highest tag's last number already sits at the shape's 9 digits) is not
  // worth building binaries for.
  if (!TAG_SHAPE.test(next)) {
    throw new Error(
      `the next tag ${next} is not vX.Y.Z or vX.Y.Z-rc.N with no leading zeros and 9 digits at most`,
    );
  }
  return next;
}

if (import.meta.main) {
  const git = Bun.spawnSync(["git", "tag", "--list", "v*"]);
  if (git.exitCode !== 0) {
    console.error(git.stderr.toString());
    process.exit(1);
  }
  const { version } = await Bun.file(new URL("../package.json", import.meta.url)).json();
  console.log(nextTag(git.stdout.toString().split("\n"), String(version)));
}
