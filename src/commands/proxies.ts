import { Option, type Command } from "commander";
import { fail, parseId, parsePort, parseSets, printJson, readTextFile } from "../lib.ts";
import { connect } from "../kuma.ts";

const PROTOCOLS = ["http", "https", "socks", "socks5", "socks5h", "socks4"] as const;

const collect = (value: string, previous: string[]): string[] => [...previous, value];

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
          auth: p.auth ?? null,
          username: p.username ?? null,
          active: p.active ?? null,
          default: p.default ?? null,
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
      const password =
        opts.passwordFile === undefined
          ? undefined
          : (readTextFile(opts.passwordFile, "--password-file").split("\n", 1)[0] ?? "").trim();
      if (password === "") fail(2, "--password-file is empty");
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
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "proxy id");
      const sets = parseSets(opts.set as string[] | undefined);
      if (!opts.set || (opts.set as string[]).length === 0) {
        fail(2, "proxies edit requires at least one --set key=value");
      }
      const s = await connect();
      const row = s.proxyById(id);
      if (!row) fail(1, `proxy ${id} not found`);
      const merged = { ...row, ...sets };
      const res = await s.request("addProxy", [merged, id]);
      printJson({ id: res?.id ?? id });
    });
}
