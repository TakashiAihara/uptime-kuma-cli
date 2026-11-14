import { Option, type Command } from "commander";
import {
  fail,
  notificationIdArray,
  notificationIdObject,
  parseId,
  parseNumber,
  parsePort,
  parseSets,
  printJson,
} from "../lib.ts";
import { connect, type Monitor } from "../kuma.ts";

const MONITOR_TYPES = ["http", "keyword", "json-query", "port", "push"] as const;

// monitorDefaults of src/pages/EditMonitor.vue in Kuma 1.23.17, minus the fields the CLI always
// sets. Fields from Kuma 2.x must not be added: 1.23 stores the object as-is and fails on unknown columns.
const MONITOR_DEFAULTS: Record<string, unknown> = {
  parent: null,
  method: "GET",
  ignoreTls: false,
  upsideDown: false,
  packetSize: 56,
  expiryNotification: false,
  maxredirects: 10,
  accepted_statuscodes: ["200-299"],
  dns_resolve_type: "A",
  dns_resolve_server: "1.1.1.1",
  docker_container: "",
  docker_host: null,
  mqttUsername: "",
  mqttPassword: "",
  mqttTopic: "",
  mqttSuccessMessage: "",
  authMethod: null,
  oauth_auth_method: "client_secret_basic",
  httpBodyEncoding: "json",
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  kafkaProducerSsl: false,
  kafkaProducerAllowAutoTopicCreation: false,
  gamedigGivenPortOnly: true,
};

const PUSH_TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generatePushToken(): string {
  let token = "";
  while (token.length < 32) {
    // 62 does not divide 256, so bytes >= 248 are rejected to keep the alphabet uniform
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 248) {
        token += PUSH_TOKEN_CHARS[b % PUSH_TOKEN_CHARS.length];
        if (token.length === 32) break;
      }
    }
  }
  return token;
}

const summarize = (m: Monitor) => ({
  id: m.id,
  name: m.name,
  type: m.type ?? null,
  active: m.active ?? null,
  url: m.url ?? null,
  hostname: m.hostname ?? null,
  port: m.port ?? null,
  interval: m.interval ?? null,
  parent: m.parent ?? null,
  notificationIDList: notificationIdArray(m.notificationIDList),
});

export function registerMonitors(program: Command): void {
  const monitors = program.command("monitors").description("Manage monitors");

  monitors
    .command("list")
    .description("List monitors")
    .option("--name <substring>", "filter by name (case-insensitive)")
    .action(async (opts) => {
      const s = await connect();
      const needle = typeof opts.name === "string" ? opts.name.toLowerCase() : undefined;
      const items = s.monitors().filter((m) => !needle || m.name.toLowerCase().includes(needle));
      printJson(items.map(summarize));
    });

  monitors
    .command("get <id>")
    .description("Show one monitor")
    .action(async (rawId) => {
      const id = parseId(rawId, "monitor id");
      const s = await connect();
      const m = s.monitorById(id);
      if (!m) fail(1, `monitor ${id} not found`);
      printJson({ ...m, notificationIDList: notificationIdArray(m.notificationIDList) });
    });

  monitors
    .command("add")
    .description("Add a monitor")
    .addOption(
      new Option("--type <type>", "monitor type").choices([...MONITOR_TYPES]).makeOptionMandatory(),
    )
    .requiredOption("--name <name>", "monitor name")
    .option("--url <url>", "monitor url")
    .option("--hostname <hostname>", "hostname (port type)")
    .option("--port <port>", "port (port type)")
    .option("--keyword <keyword>", "keyword (keyword type)")
    .option("--json-path <path>", "json path (json-query type)")
    .option("--expected-value <value>", "expected value (json-query type)")
    .option("--interval <seconds>", "heartbeat interval")
    .option("--retry-interval <seconds>", "retry interval")
    .option("--max-retries <n>", "maximum retries")
    .option("--resend-interval <n>", "resend interval")
    .option("--timeout <seconds>", "request timeout")
    .option("--proxy-id <id>", "proxy id")
    .option("--notification-id <id>", "notification id (repeatable)", collect, [])
    .option("--notifications-from <monitorId>", "copy notifications from a monitor")
    .option("--paused", "create the monitor paused")
    .option("--push-token <token>", "push token (push type)")
    .action(async (opts) => {
      const type = opts.type as string;
      if (type !== "port" && type !== "push" && !opts.url) {
        fail(2, `--type ${type} requires --url`);
      }
      if (type === "keyword" && !opts.keyword) fail(2, "--type keyword requires --keyword");
      if (type === "json-query") {
        if (!opts.jsonPath) fail(2, "--type json-query requires --json-path");
        if (opts.expectedValue === undefined) {
          fail(2, "--type json-query requires --expected-value");
        }
      }
      if (type === "port") {
        if (!opts.hostname) fail(2, "--type port requires --hostname");
        if (opts.port === undefined) fail(2, "--type port requires --port");
      }
      const interval = parseNumber(opts.interval ?? "60", "--interval");
      const retryInterval = parseNumber(opts.retryInterval ?? "60", "--retry-interval");
      const maxRetries = parseNumber(opts.maxRetries ?? "0", "--max-retries");
      const resendInterval = parseNumber(opts.resendInterval ?? "0", "--resend-interval");
      const timeout = parseNumber(opts.timeout ?? "48", "--timeout");
      const proxyId = opts.proxyId === undefined ? null : parseId(opts.proxyId, "--proxy-id");
      const port = type === "port" ? parsePort(opts.port, "--port") : undefined;
      const notificationIds = ((opts.notificationId ?? []) as string[]).map((v) =>
        parseId(v, "--notification-id"),
      );
      const notificationsFrom =
        opts.notificationsFrom === undefined
          ? undefined
          : parseId(opts.notificationsFrom, "--notifications-from");

      const s = await connect();
      const name = opts.name as string;
      const existing = s.monitors().find((m) => m.name === name);
      if (existing) {
        printJson({ id: existing.id, name: existing.name, skipped: true });
        fail(3, "");
      }

      let ids: number[] = [];
      if (notificationsFrom !== undefined) {
        const src = s.monitorById(notificationsFrom);
        if (!src) fail(1, `monitor ${notificationsFrom} not found`);
        ids = notificationIdArray(src.notificationIDList);
      }
      ids.push(...notificationIds);

      const active = !opts.paused;
      const monitor: Record<string, unknown> = {
        ...MONITOR_DEFAULTS,
        type,
        name,
        url: null,
        interval,
        retryInterval,
        resendInterval,
        maxretries: maxRetries,
        timeout,
        notificationIDList: notificationIdObject(ids),
        proxyId,
        active,
      };
      if (type === "http" || type === "keyword" || type === "json-query") {
        monitor.url = opts.url;
      }
      if (type === "keyword") monitor.keyword = opts.keyword;
      if (type === "json-query") {
        monitor.jsonPath = opts.jsonPath;
        monitor.expectedValue = opts.expectedValue;
      }
      if (type === "port") {
        monitor.hostname = opts.hostname;
        monitor.port = port;
      }
      let pushToken: string | undefined;
      if (type === "push") {
        pushToken = (opts.pushToken as string | undefined) ?? generatePushToken();
        monitor.pushToken = pushToken;
      }

      const res = await s.request("add", [monitor]);
      const out: Record<string, unknown> = {
        id: res?.monitorID ?? null,
        name,
        type,
        active,
      };
      if (pushToken !== undefined) {
        out.pushToken = pushToken;
        out.pushUrl = `${s.url}/api/push/${pushToken}?status=up&msg=OK&ping=`;
      }
      printJson(out);
    });

  monitors
    .command("edit <id>")
    .description("Edit a monitor")
    .option("--set <key=value>", "set a field (repeatable)", collect, [])
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      const sets = parseSets(opts.set as string[] | undefined);
      if (!opts.set || (opts.set as string[]).length === 0) {
        fail(2, "monitors edit requires at least one --set key=value");
      }
      const notifValue = sets.notificationIDList;
      if (
        notifValue !== undefined &&
        !Array.isArray(notifValue) &&
        (notifValue === null || typeof notifValue !== "object")
      ) {
        fail(2, "notificationIDList must be an array or an object");
      }
      const s = await connect();
      const res = await s.request("getMonitor", [id]);
      const fetched = res?.monitor;
      if (fetched === null || typeof fetched !== "object") fail(1, `monitor ${id} not found`);
      const monitor: Record<string, unknown> = { ...fetched };
      for (const [k, v] of Object.entries(sets)) monitor[k] = v;
      // Kuma rejects an array-shaped notificationIDList on editMonitor
      monitor.notificationIDList = notificationIdObject(monitor.notificationIDList);
      await s.request("editMonitor", [monitor]);
      printJson({
        ...monitor,
        notificationIDList: notificationIdArray(monitor.notificationIDList),
      });
    });

  for (const [name, event, active] of [
    ["pause", "pauseMonitor", false],
    ["resume", "resumeMonitor", true],
  ] as const) {
    monitors
      .command(`${name} <id>`)
      .description(`${name} a monitor`)
      .action(async (rawId) => {
        const id = parseId(rawId, "monitor id");
        const s = await connect();
        await s.request(event, [id]);
        printJson({ id, active });
      });
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
