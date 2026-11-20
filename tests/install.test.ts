import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type Sandbox, sandbox } from "./helpers/run";

const INSTALL_SH = resolve(import.meta.dir, "../install.sh");
const REPO_PATH = "/TakashiAihara/uptime-kuma-cli/releases";
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `uptime-kuma-cli-${OS}-${ARCH}`;

const WORKING = "#!/bin/sh\necho working\n";
// The shebang target does not exist, so it cannot be exec'd. Without a shebang sh would
// run it as a script
const BROKEN = "#!/nonexistent/interp\n";
const OLD = "#!/bin/sh\necho old-install\n";

// A PATH holding only the tools install.sh uses. A real gh sneaking in would make
// "no gh" impossible to set up
const TOOLS = ["uname", "mktemp", "rm", "mkdir", "mv", "chmod", "grep", "awk", "sleep"];
// install.sh hashes with sha256sum, or shasum where sha256sum is missing (stock
// macOS has only the latter); linking whichever the host has lets the script
// make the same choice it would on a real machine
const CHECKSUM = ["sha256sum", "shasum"];

type Release = { binary?: string; sums?: string };

let sb: Sandbox;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let latestCalls = 0;
let bin: string;
let installDir: string;

function startServer(releases: Record<string, Release>): void {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === `${REPO_PATH}/latest`) {
        // From the second call on it points at a different release; this shows it is fetched only once
        latestCalls += 1;
        const tags = Object.keys(releases);
        const tag = tags[Math.min(latestCalls - 1, tags.length - 1)];
        return new Response(null, {
          status: 302,
          headers: { location: `${REPO_PATH}/tag/${tag}` },
        });
      }
      if (path.startsWith(`${REPO_PATH}/tag/`)) return new Response("release page");
      const m = new RegExp(`^${REPO_PATH}/download/([^/]+)/(.+)$`).exec(path);
      const release = m?.[1] ? releases[m[1]] : undefined;
      if (!release) return new Response("not found", { status: 404 });
      if (m?.[2] === ASSET && release.binary !== undefined) return new Response(release.binary);
      if (m?.[2] === "SHA256SUMS" && release.sums !== undefined) return new Response(release.sums);
      return new Response("not found", { status: 404 });
    },
  });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const release = (binary: string): Release => ({ binary, sums: `${sha(binary)}  ${ASSET}\n` });

function writeTool(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// Asserts the arguments gh attestation verify needs to mean anything: the downloaded
// binary (which must exist), --repo, and --signer-workflow pinned to release.yml
const GH_ASSERT = `case "$1 $2" in
  "attestation verify") ;;
  *) echo "gh: unexpected args: $*" >&2; exit 1 ;;
esac
bin="$3"
case "$bin" in
  "\${UPTIME_KUMA_CLI_INSTALL_DIR}/.uptime-kuma-cli."*"/uptime-kuma-cli") ;;
  *) echo "gh: $3 is not the downloaded binary" >&2; exit 1 ;;
esac
[ -f "$bin" ] || { echo "gh: $bin is not a file" >&2; exit 1; }
[ "$4" = --repo ] && [ "$5" = TakashiAihara/uptime-kuma-cli ] || { echo "gh: missing --repo" >&2; exit 1; }
[ "$6" = --signer-workflow ] && [ "$7" = TakashiAihara/uptime-kuma-cli/.github/workflows/release.yml ] || { echo "gh: missing --signer-workflow" >&2; exit 1; }`;

beforeEach(() => {
  sb = sandbox();
  requests = [];
  latestCalls = 0;
  bin = join(sb.dir, "bin");
  installDir = join(sb.dir, "install");
  mkdirSync(bin);
  const checksums = CHECKSUM.filter((t) => Bun.which(t));
  if (checksums.length === 0) throw new Error("sha256sum or shasum is needed to run install.sh");
  for (const t of [...TOOLS, ...checksums]) {
    const real = Bun.which(t);
    if (!real) throw new Error(`${t} is needed to run install.sh`);
    symlinkSync(real, join(bin, t));
  }
});

afterEach(() => {
  server.stop(true);
  sb.cleanup();
});

// Points curl at github.com to the local server. install.sh's URL is not rewritten
function shimCurl(): void {
  const real = Bun.which("curl");
  if (!real) throw new Error("curl is needed to run install.sh");
  writeTool(
    "curl",
    `for a; do shift; case "$a" in https://github.com/*) a="http://127.0.0.1:${server.port}/\${a#https://github.com/}";; esac; set -- "$@" "$a"; done
exec ${real} "$@"`,
  );
}

async function install(env: Record<string, string> = {}) {
  shimCurl();
  const proc = Bun.spawn(["/bin/sh", INSTALL_SH], {
    cwd: sb.dir,
    env: { PATH: bin, HOME: sb.home, UPTIME_KUMA_CLI_INSTALL_DIR: installDir, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const installed = () => join(installDir, "uptime-kuma-cli");
const leftovers = () =>
  existsSync(installDir) ? readdirSync(installDir).filter((f) => f.startsWith(".")) : [];

function placeOldInstall(): void {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(installed(), OLD);
  chmodSync(installed(), 0o755);
}

describe("install.sh", () => {
  test("latest is fetched once, and both the binary and SHA256SUMS come from that tag", async () => {
    startServer({ "v1.0.0-rc.3": release(WORKING), "v1.0.0-rc.4": release(WORKING) });

    const r = await install();

    expect(r.code).toBe(0);
    expect(r.out).toContain("(v1.0.0-rc.3)");
    expect(latestCalls).toBe(1);
    expect(requests.filter((p) => p.includes("/download/"))).toEqual([
      `${REPO_PATH}/download/v1.0.0-rc.3/${ASSET}`,
      `${REPO_PATH}/download/v1.0.0-rc.3/SHA256SUMS`,
    ]);
    expect(readFileSync(installed(), "utf8")).toBe(WORKING);
    expect(leftovers()).toEqual([]);
  });

  test("does not fetch latest when a tag is given", async () => {
    startServer({ "v0.5.0": release(WORKING) });

    const r = await install({ UPTIME_KUMA_CLI_VERSION: "v0.5.0" });

    expect(r.code).toBe(0);
    expect(latestCalls).toBe(0);
  });

  test("does not install when the checksum does not match", async () => {
    startServer({ "v1.0.0": { binary: WORKING, sums: `${sha("other")}  ${ASSET}\n` } });
    placeOldInstall();

    const r = await install();

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("checksum mismatch");
    expect(readFileSync(installed(), "utf8")).toBe(OLD);
  });

  test.skipIf(!Bun.which("dash"))(
    "under dash, a TERM mid-run leaves no work dir in the install dir",
    async () => {
      const dash = Bun.which("dash");
      if (!dash) throw new Error("dash is needed for this test");
      const realMktemp = Bun.which("mktemp");
      if (!realMktemp) throw new Error("mktemp is needed for this test");
      startServer({ "v1.0.0": release(WORKING) });
      shimCurl();
      // A mktemp that exits only when the test releases it keeps the shell inside
      // tmp=$(...) with the dir already visible, so the TERM lands in the window that
      // used to need scheduler luck. dash defers the trap to the end of the command,
      // so the fixed script still exits 143 and cleans up. The hold loop is bounded:
      // on a regression the parent dies at once and the orphaned shim must still
      // exit on its own after sb.cleanup() removes the sandbox
      const hold = join(sb.dir, "hold-mktemp");
      rmSync(join(bin, "mktemp"));
      writeTool(
        "mktemp",
        `${realMktemp} "$@" || exit\ni=0\nwhile [ ! -f "${hold}" ] && [ "$i" -lt 400 ]; do\n  i=$((i + 1))\n  sleep 0.05\ndone`,
      );

      const proc = Bun.spawn([dash, INSTALL_SH], {
        cwd: sb.dir,
        env: { PATH: bin, HOME: sb.home, UPTIME_KUMA_CLI_INSTALL_DIR: installDir },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      for (let i = 0; i < 100 && leftovers().length === 0; i++) await Bun.sleep(20);
      expect(leftovers().length).toBe(1);

      proc.kill("SIGTERM");
      // The shim still holds the substitution open, so the signal provably arrived
      // while the dir existed
      expect(leftovers().length).toBe(1);
      writeFileSync(hold, "");

      expect(await proc.exited).toBe(143);
      expect(leftovers()).toEqual([]);
    },
    15_000,
  );

  test("a binary that does not run stops without replacing the installed version", async () => {
    startServer({ "v1.0.0": release(BROKEN) });
    placeOldInstall();

    const r = await install();

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not run");
    expect(readFileSync(installed(), "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  describe("UPTIME_KUMA_CLI_VERIFY_ATTESTATION=1", () => {
    const verify = { UPTIME_KUMA_CLI_VERIFY_ATTESTATION: "1" };

    test("stops without installing when gh is missing and verification cannot happen", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      placeOldInstall();

      const r = await install(verify);

      expect(r.code).not.toBe(0);
      expect(r.err).toContain("needs gh");
      expect(readFileSync(installed(), "utf8")).toBe(OLD);
    });

    test("stops with gh's reason attached when verification fails", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      writeTool("gh", `${GH_ASSERT}\necho "HTTP 401: bad credentials" >&2\nexit 1`);
      placeOldInstall();

      const r = await install(verify);

      expect(r.code).not.toBe(0);
      expect(r.err).toContain("attestation verification failed: HTTP 401: bad credentials");
      expect(readFileSync(installed(), "utf8")).toBe(OLD);
    });

    test("installs when verification passes", async () => {
      startServer({ "v1.0.0": release(WORKING) });
      writeTool("gh", `${GH_ASSERT}\nexit 0`);

      const r = await install(verify);

      expect(r.code).toBe(0);
      expect(r.out).toContain("attestation ok");
      expect(readFileSync(installed(), "utf8")).toBe(WORKING);
    });
  });
});
