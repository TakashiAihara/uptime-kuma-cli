import { type Command, Option } from "commander";

import { connect } from "../kuma.ts";
import {
  fail,
  firstSecretLine,
  parseId,
  parsePort,
  parseSets,
  printJson,
  readTextFile,
} from "../lib.ts";

const PROTOCOLS = ["http", "https", "socks", "socks5", "socks5h", "socks4"] as const;

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function readPasswordFile(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const password = firstSecretLine(readTextFile(path, "--password-file"));
  if (password === "") fail(2, "--password-file is empty");
  return password;
}

// Kuma 1.23's sendProxyList emits raw bean rows, so the flag columns arrive as 0/1
const toBool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));

export function registerProxies(program: Command): void {
  const proxies = program.command("proxies").description("Manage proxies");

  proxies
    .command("list")
    .description("List proxies")
    .action(async () => {
      const s = await connect();
      printJson(
        s.proxies().map((p) => ({
          id: p.id,
          protocol: p.protocol ?? null,
          host: p.host ?? null,
          port: p.port ?? null,
          auth: toBool(p.auth),
          username: p.username ?? null,
          active: toBool(p.active),
          default: toBool(p.default),
        })),
      );
    });

  proxies
    .command("add")
    .description("Add a proxy")
    .addOption(
      new Option("--protocol <protocol>", "proxy protocol")
        .choices([...PROTOCOLS])
        .makeOptionMandatory(),
    )
    .requiredOption("--host <host>", "proxy host")
    .requiredOption("--port <port>", "proxy port")
    .option("--username <username>", "proxy username")
    .option("--password-file <path>", "file containing the proxy password")
    .option("--default", "use as the default proxy")
    .option("--apply-existing", "apply to existing monitors")
    .action(async (opts) => {
      const port = parsePort(opts.port, "--port");
      const password = readPasswordFile(opts.passwordFile);
      const proxy = {
        protocol: opts.protocol,
        host: opts.host,
        port,
        auth: opts.username !== undefined || password !== undefined,
        username: opts.username ?? null,
        password: password ?? null,
        active: true,
        default: opts.default === true,
        applyExisting: opts.applyExisting === true,
      };
      const s = await connect();
      const res = await s.request("addProxy", [proxy, null]);
      printJson({ id: res?.id ?? null });
    });

  proxies
    .command("edit <id>")
    .description("Edit a proxy")
    .option("--set <key=value>", "set a field (repeatable)", collect, [])
    .option("--password-file <path>", "file containing the new proxy password")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "proxy id");
      const sets = parseSets(opts.set as string[] | undefined);
      const password = readPasswordFile(opts.passwordFile);
      const setValues = (opts.set ?? []) as string[];
      if (setValues.length === 0 && password === undefined) {
        fail(2, "proxies edit requires --set key=value or --password-file");
      }
      const s = await connect();
      const row = s.proxyById(id);
      if (!row) fail(1, `proxy ${id} not found`);
      const merged = { ...row, ...sets };
      // As in add, a password only takes effect with auth on
      if (password !== undefined) Object.assign(merged, { password, auth: true });
      const res = await s.request("addProxy", [merged, id]);
      printJson({ id: res?.id ?? id });
    });

  proxies
    .command("delete <id>")
    .description("Delete a proxy")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "proxy id");
      if (!opts.yes) fail(2, `would delete proxy ${id}; pass --yes to delete`);
      const s = await connect();
      // Kuma 1.23 rejects an unknown id with ok:false, so no pre-check (unlike deleteMonitor)
      await s.request("deleteProxy", [id]);
      printJson({ id, deleted: true });
    });
}
