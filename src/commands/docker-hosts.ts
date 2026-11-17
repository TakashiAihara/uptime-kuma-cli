import { Option, type Command } from "commander";
import { CliError, fail, parseId, printJson } from "../lib.ts";
import { connect, type KumaSession } from "../kuma.ts";
import { redactUrl } from "./monitors.ts";

const TYPES = ["socket", "tcp"] as const;

// docker_host.docker_daemon / docker_type / name are nullable columns; a
// stored null passes through an edit unchanged like the UI's own save would.
function parseNonEmpty(value: string, flag: string): string {
  if (value === "") fail(2, `${flag} must not be empty`);
  return value;
}

// The three fields DockerHost.save / testDockerHost read off the object.
function hostPayload(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: row.name ?? null,
    dockerType: row.dockerType ?? null,
    dockerDaemon: row.dockerDaemon ?? null,
  };
}

// A daemon address may carry credentials as user:pass@ like a monitor url.
function hostView(row: {
  id: number | null;
  name?: unknown;
  dockerType?: unknown;
  dockerDaemon?: unknown;
}): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name ?? null,
    dockerType: row.dockerType ?? null,
    dockerDaemon: redactUrl(row.dockerDaemon ?? null),
  };
}

// Kuma's testDockerHost failure msg can echo the daemon — a socket connect
// error carries socketPath verbatim and an axios error can carry the baseURL
// after Kuma's tcp:// -> http:// patch — so credential-bearing forms are
// masked before the message reaches stderr.
function scrubDaemon(msg: string, daemon: unknown): string {
  if (typeof daemon !== "string" || daemon === "") return msg;
  let out = msg;
  for (const candidate of new Set([daemon, daemon.replace(/tcp:\/\//g, "http://")])) {
    const masked = redactUrl(candidate);
    if (typeof masked === "string" && masked !== candidate) {
      out = out.split(candidate).join(masked);
    }
  }
  return out;
}

async function testDaemon(s: KumaSession, host: Record<string, unknown>): Promise<any> {
  try {
    return await s.request("testDockerHost", [host]);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    fail(err.exitCode, scrubDaemon(err.message, host.dockerDaemon));
  }
}

export function registerDockerHosts(program: Command): void {
  const dockerHosts = program.command("docker-hosts").description("Manage docker hosts");

  dockerHosts
    .command("list")
    .description("List docker hosts")
    .action(async () => {
      const s = await connect();
      printJson(s.dockerHosts().map(hostView));
    });

  dockerHosts
    .command("add")
    .description("Add a docker host")
    .requiredOption("--name <name>", "friendly name")
    .addOption(
      new Option("--type <type>", "connection type").choices([...TYPES]).makeOptionMandatory(),
    )
    .requiredOption("--daemon <daemon>", "docker daemon address")
    .action(async (opts) => {
      const name = parseNonEmpty(opts.name as string, "--name");
      const daemon = parseNonEmpty(opts.daemon as string, "--daemon");
      const host = { name, dockerType: opts.type as string, dockerDaemon: daemon };
      const s = await connect();
      const res = await s.request("addDockerHost", [host, null]);
      printJson(hostView({ id: res?.id ?? null, ...host }));
    });

  dockerHosts
    .command("edit <id>")
    .description("Edit a docker host")
    .option("--name <name>", "new friendly name")
    .addOption(new Option("--type <type>", "connection type").choices([...TYPES]))
    .option("--daemon <daemon>", "new docker daemon address")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "docker host id");
      if (opts.name === undefined && opts.type === undefined && opts.daemon === undefined) {
        fail(2, "docker-hosts edit requires --name, --type or --daemon");
      }
      const name =
        opts.name === undefined ? undefined : parseNonEmpty(opts.name as string, "--name");
      const daemon =
        opts.daemon === undefined ? undefined : parseNonEmpty(opts.daemon as string, "--daemon");
      const s = await connect();
      const row = s.dockerHostById(id);
      if (!row) fail(1, `docker host ${id} not found`);
      // addDockerHost overwrites every field it reads, so the flag not given
      // keeps the stored value
      const merged = {
        name: name === undefined ? row.name : name,
        dockerType: opts.type ?? row.dockerType,
        dockerDaemon: daemon === undefined ? row.dockerDaemon : daemon,
      };
      const res = await s.request("addDockerHost", [merged, id]);
      printJson(hostView({ id: res?.id ?? id, ...merged }));
    });

  dockerHosts
    .command("test [id]")
    .description("Test a docker host connection")
    .option("--name <name>", "friendly name (with --type/--daemon)")
    .addOption(new Option("--type <type>", "connection type").choices([...TYPES]))
    .option("--daemon <daemon>", "docker daemon address")
    .action(async (rawId, opts) => {
      const flagMode =
        opts.type !== undefined || opts.daemon !== undefined || opts.name !== undefined;
      if (rawId !== undefined && flagMode) {
        fail(2, "docker-hosts test takes either a host id or --name/--type/--daemon, not both");
      }
      if (rawId !== undefined) {
        const id = parseId(rawId, "docker host id");
        const s = await connect();
        const row = s.dockerHostById(id);
        if (!row) fail(1, `docker host ${id} not found`);
        const res = await testDaemon(s, hostPayload(row));
        printJson({ id, ok: true, msg: res?.msg ?? null });
        return;
      }
      if (opts.type === undefined || opts.daemon === undefined) {
        fail(2, "docker-hosts test requires --type and --daemon (or a docker host id)");
      }
      const host = {
        name: opts.name === undefined ? "" : parseNonEmpty(opts.name as string, "--name"),
        dockerType: opts.type as string,
        dockerDaemon: parseNonEmpty(opts.daemon as string, "--daemon"),
      };
      const s = await connect();
      const res = await testDaemon(s, host);
      printJson({ ok: true, msg: res?.msg ?? null });
    });

  dockerHosts
    .command("delete <id>")
    .description("Delete a docker host")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "docker host id");
      if (!opts.yes) fail(2, `would delete docker host ${id}; pass --yes to delete`);
      const s = await connect();
      // Kuma 1.23 answers ok:false "docker host not found" for an unknown id
      await s.request("deleteDockerHost", [id]);
      printJson({ id, deleted: true });
    });
}
