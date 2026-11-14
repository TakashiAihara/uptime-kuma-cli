import { Option, type Command } from "commander";
import {
  fail,
  notificationIdArray,
  notificationIdObject,
  parseId,
  parseNonNegativeInteger,
  parsePort,
  parsePositiveInteger,
  parsePositiveNumber,
  parseSets,
  printJson,
  readJsonFile,
} from "../lib.ts";
import { connect, MONITOR_ADD_FIELDS, type KumaSession, type Monitor } from "../kuma.ts";

// Order follows the type picker of EditMonitor.vue in Kuma 1.23.17; the
// monitor types not listed here come in later parts.
const MONITOR_TYPES = [
  "group",
  "http",
  "port",
  "ping",
  "keyword",
  "json-query",
  "dns",
  "docker",
  "push",
  "steam",
  "gamedig",
  "tailscale-ping",
] as const;

// dnsresolvetypeOptions of EditMonitor.vue
const DNS_RESOLVE_TYPES = [
  "A",
  "AAAA",
  "CAA",
  "CNAME",
  "MX",
  "NS",
  "PTR",
  "SOA",
  "SRV",
  "TXT",
] as const;

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

// Fields Kuma's monitor JSON carries that must never reach stdout.
const SECRET_KEYS = new Set([
  "basic_auth_pass",
  "oauth_client_secret",
  "tlsKey",
  "headers",
  "body",
  "mqttPassword",
  "radiusPassword",
  "radiusSecret",
  "databaseConnectionString",
  "grpcBody",
  "grpcMetadata",
]);

// kafkaProducerSaslOptions is an object holding the SASL password or AWS secret keys;
// only the fields that name the method and the identity stay readable.
const SASL_VISIBLE_KEYS = new Set(["mechanism", "username", "awsRegion", "accessKeyId"]);

// The fields docs/design/cli.md Output redacts. They may only arrive through
// --config-file so the secret stays out of argv.
const HATCH_SECRET_KEYS = new Set([...SECRET_KEYS, "kafkaProducerSaslOptions"]);

// A monitor URL may carry credentials as user:pass@; keep the URL readable and hide the password
function redactUrl(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.password === "") return value;
  parsed.password = "***";
  return parsed.toString();
}

function redactSecrets(monitor: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...monitor, url: redactUrl(monitor.url) };
  for (const key of SECRET_KEYS) {
    const value = out[key];
    if (typeof value === "string" && value !== "") out[key] = "***";
  }
  const sasl = out.kafkaProducerSaslOptions;
  if (sasl !== null && typeof sasl === "object" && !Array.isArray(sasl)) {
    const copy: Record<string, unknown> = { ...(sasl as Record<string, unknown>) };
    for (const [k, v] of Object.entries(copy)) {
      if (!SASL_VISIBLE_KEYS.has(k) && typeof v === "string" && v !== "") copy[k] = "***";
    }
    out.kafkaProducerSaslOptions = copy;
  }
  return out;
}

async function fetchMonitor(s: KumaSession, id: number): Promise<Record<string, unknown>> {
  const res = await s.request("getMonitor", [id]);
  const monitor = res?.monitor;
  if (monitor === null || typeof monitor !== "object") fail(1, `monitor ${id} not found`);
  return monitor;
}

// Every stored id must be a positive integer: each array element, or each
// object key whose value is truthy (the shape Kuma keeps on the wire).
function validateNotificationIdEntries(value: unknown): void {
  const msg = "notificationIDList entries must be positive integer ids";
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(2, msg);
    }
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && (!/^\d+$/.test(key) || Number(key) <= 0)) fail(2, msg);
  }
}

// The merged notificationIDList must keep the array-or-object shape before
// it is normalized to the object Kuma stores.
function checkNotificationIdList(value: unknown): void {
  if (!Array.isArray(value) && (value === null || typeof value !== "object")) {
    fail(2, "notificationIDList must be an array or an object");
  }
  validateNotificationIdEntries(value);
}

// `monitors add --set/--config-file`: every key must be a field the `add`
// event accepts; id/type/name are set by the dedicated flags instead.
function checkAddFields(fields: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(fields)) {
    if (key === "id") fail(2, `${source} cannot set "id"; the id is assigned by Kuma`);
    if (key === "type" || key === "name") {
      fail(2, `${source} cannot set "${key}"; use --type/--name instead`);
    }
    if (!MONITOR_ADD_FIELDS.has(key)) {
      fail(2, `${source} key "${key}" is not a monitor field`);
    }
  }
}

// `monitors edit`: same field set; only id is read-only, name/type keep the
// --set behavior they had before the escape hatch existed.
function checkEditFields(fields: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(fields)) {
    if (key === "id") fail(2, `${source} cannot set "id"; the id selects the monitor`);
    if (!MONITOR_ADD_FIELDS.has(key)) {
      fail(2, `${source} key "${key}" is not a monitor field`);
    }
  }
}

// --set lands in argv; the secret fields only go through --config-file.
function refuseSecretSets(sets: Record<string, unknown>): void {
  for (const key of Object.keys(sets)) {
    if (HATCH_SECRET_KEYS.has(key)) {
      fail(2, `--set ${key}=... would put a secret in the command line; use --config-file instead`);
    }
  }
}

// "none" clears the parent; anything else must be a monitor id.
function parseParent(value: string): number | null {
  if (value === "none") return null;
  return parseId(value, "--parent");
}

// parent reaches Kuma as a number or null. A numeric string would slip past
// editMonitor's descendant check, which compares ids with includes().
function normalizeParent(value: unknown): number | null {
  if (value === null) return null;
  if (value === "") fail(2, "parent must not be an empty string");
  let n = NaN;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    n = Number(value);
  }
  if (!Number.isInteger(n) || n <= 0) {
    fail(2, `parent must be a monitor id, got ${JSON.stringify(value)}`);
  }
  return n;
}

// The pushed monitorList is the only source for the parent check: it must be
// an existing monitor of type group. null means "no parent".
function checkParentGroup(s: KumaSession, parent: number | null): void {
  if (parent === null) return;
  const m = s.monitorById(parent);
  if (!m) fail(1, `monitor ${parent} not found`);
  if (m.type !== "group") fail(1, `monitor ${parent} is not a group`);
}

// docker_host must name a host Kuma pushed in dockerHostList, like the ids
// the UI's docker host picker offers. Already normalized to number|null.
function checkDockerHost(s: KumaSession, dockerHost: unknown): void {
  if (typeof dockerHost !== "number") return;
  if (!s.dockerHosts().some((h) => h.id === dockerHost)) {
    fail(1, `docker host ${dockerHost} not found`);
  }
}

// A hatch value for a key that has a typed flag goes through the flag's
// parser; flags take strings, so a string here parses the same way while a
// number is stringified first. The key names the error.
function hatchNumber(
  value: unknown,
  key: string,
  parse: (value: string, flag: string) => number,
): number {
  if (typeof value !== "number" && typeof value !== "string") {
    fail(2, `${key} must be a number`);
  }
  return parse(String(value), key);
}

// Kuma 1.23.17 monitor.js patches a timeout of 0 (or less) to
// interval * 1000 * 0.8 at check time and then multiplies by 1000 for axios,
// so the effective timeout silently becomes interval × 800 seconds.
function parseTimeoutSeconds(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    fail(
      2,
      `${flag} must be a positive number of seconds, got "${value}"; Kuma 1.23 turns 0 into interval × 800 seconds`,
    );
  }
  return n;
}

const HATCH_VALUE_CHECKS: Record<string, (value: unknown, key: string) => unknown> = {
  interval: (v, k) => hatchNumber(v, k, parsePositiveNumber),
  retryInterval: (v, k) => hatchNumber(v, k, parsePositiveNumber),
  resendInterval: (v, k) => hatchNumber(v, k, parseNonNegativeInteger),
  maxretries: (v, k) => hatchNumber(v, k, parseNonNegativeInteger),
  timeout: (v, k) => hatchNumber(v, k, parseTimeoutSeconds),
  port: (v, k) => hatchNumber(v, k, parsePort),
  packetSize: (v, k) => hatchNumber(v, k, parsePositiveInteger),
  proxyId: (v, k) => (v === null ? null : hatchNumber(v, k, parseId)),
  parent: (v) => normalizeParent(v),
  docker_host: (v, k) => (v === null ? null : hatchNumber(v, k, parseId)),
  dns_resolve_type: (v, k) => {
    if (typeof v !== "string" || !(DNS_RESOLVE_TYPES as readonly string[]).includes(v)) {
      fail(2, `${k} must be one of ${DNS_RESOLVE_TYPES.join(", ")}`);
    }
    return v;
  },
  accepted_statuscodes: (v, k) => {
    if (!Array.isArray(v) || v.some((c) => typeof c !== "string")) {
      fail(2, `${k} must be an array of strings`);
    }
    return v;
  },
  kafkaProducerBrokers: (v, k) => {
    if (!Array.isArray(v)) fail(2, `${k} must be an array`);
    return v;
  },
};

// Runs before connecting so a bad hatch value exits 2 with nothing sent.
// The coerced result is written back: the payload then carries the same type
// the typed flag would have produced.
function validateHatchValues(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    const check = HATCH_VALUE_CHECKS[key];
    if (check !== undefined) fields[key] = check(value, key);
  }
}

// retryInterval follows the interval and the timeout stays within 80% of
// it; both derive from the final interval after the hatch had its say.
// Explicit values from any source are kept; the cap applies to them exactly
// like it did to the typed flags. validateFinalMonitor refuses the inputs
// that could derive a timeout of 0.
function deriveMonitorTiming(monitor: Record<string, unknown>): void {
  if (typeof monitor.interval !== "number") return;
  monitor.retryInterval = monitor.retryInterval ?? monitor.interval;
  monitor.timeout = Math.min(
    typeof monitor.timeout === "number" ? monitor.timeout : 48,
    Math.trunc(monitor.interval * 8) / 10,
  );
}

// The merged monitor is validated once on its final values, right before it is
// sent: per-type required fields, parent / docker_host / proxyId against the
// pushed lists, and the timing fields. Typed flags, --config-file and --set
// all feed the same monitor, so a hatch can override a flag's value — this is
// the backstop that makes the per-source checks above only early exits.
function validateFinalMonitor(s: KumaSession, monitor: Record<string, unknown>): void {
  const type = typeof monitor.type === "string" ? monitor.type : "";
  const needString = (field: string) => {
    const v = monitor[field];
    if (typeof v !== "string" || v === "") fail(2, `${field} must be a non-empty string`);
  };
  if (type === "http" || type === "keyword" || type === "json-query") needString("url");
  if (type === "keyword") needString("keyword");
  if (type === "json-query") {
    needString("jsonPath");
    needString("expectedValue");
  }
  if (
    type === "port" ||
    type === "steam" ||
    type === "gamedig" ||
    type === "ping" ||
    type === "dns" ||
    type === "tailscale-ping"
  ) {
    needString("hostname");
  }
  if (type === "port" || type === "steam" || type === "gamedig") {
    const port = monitor.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail(2, "port must be a port number");
    }
  }
  if (type === "gamedig") needString("game");
  if (type === "docker") {
    needString("docker_container");
    if (typeof monitor.docker_host !== "number") {
      fail(2, "docker_host must be a docker host id");
    }
  }
  if (type === "push") {
    const token = monitor.pushToken;
    if (typeof token !== "string" || token === "") {
      fail(2, "pushToken must be a non-empty string");
    }
  }

  // parent reaches Kuma as a number or null; the final value is normalized
  // here so a numeric string can never slip past the descendant check.
  const parent = normalizeParent(monitor.parent ?? null);
  monitor.parent = parent;
  checkParentGroup(s, parent);
  checkDockerHost(s, monitor.docker_host);
  const proxyId = monitor.proxyId;
  if (proxyId !== null && proxyId !== undefined) {
    if (typeof proxyId !== "number" || !s.proxies().some((p) => p.id === proxyId)) {
      fail(1, `proxy ${proxyId} not found`);
    }
  }

  const interval = monitor.interval;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
    fail(2, "interval must be a positive number");
  }
  // The timeout cap is 80% of the interval truncated to a tenth of a second;
  // below 0.125 it becomes 0, which Kuma 1.23 turns into interval × 800 seconds.
  if (interval < 0.125) {
    fail(2, `interval ${interval} is too small: 80% of it truncates to a timeout of 0`);
  }
  const timeout = monitor.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    fail(2, "timeout must be a positive number");
  }
}

const summarize = (m: Monitor) => ({
  id: m.id,
  name: m.name,
  type: m.type ?? null,
  active: m.active ?? null,
  url: redactUrl(m.url ?? null),
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
      printJson({
        ...redactSecrets(m),
        notificationIDList: notificationIdArray(m.notificationIDList),
      });
    });

  monitors
    .command("add")
    .description("Add a monitor")
    .addOption(
      new Option("--type <type>", "monitor type").choices([...MONITOR_TYPES]).makeOptionMandatory(),
    )
    .requiredOption("--name <name>", "monitor name")
    .option("--url <url>", "monitor url")
    .option("--hostname <hostname>", "hostname (port, ping, dns, steam, gamedig, tailscale-ping)")
    .option("--port <port>", "port (port, dns, steam, gamedig)")
    .option("--keyword <keyword>", "keyword (keyword type)")
    .option("--json-path <path>", "json path (json-query type)")
    .option("--expected-value <value>", "expected value (json-query type)")
    .option("--packet-size <bytes>", "ping packet size")
    .option("--dns-resolve-server <server>", "DNS resolver server")
    .addOption(
      new Option("--dns-resolve-type <type>", "DNS resource record type").choices([
        ...DNS_RESOLVE_TYPES,
      ]),
    )
    .option("--docker-container <name>", "docker container name or id")
    .option("--docker-host <id>", "docker host id")
    .option("--game <game>", "game (gamedig type)")
    .option("--interval <seconds>", "heartbeat interval")
    .option("--retry-interval <seconds>", "retry interval")
    .option("--max-retries <n>", "maximum retries")
    .option("--resend-interval <n>", "resend interval")
    .option("--timeout <seconds>", "request timeout")
    .option("--proxy-id <id>", "proxy id")
    .option("--notification-id <id>", "notification id (repeatable)", collect, [])
    .option("--notifications-from <monitorId>", "copy notifications from a monitor")
    .option("--parent <groupId>", "parent group monitor id")
    .option("--paused", "create the monitor paused")
    .option("--push-token <token>", "push token (push type)")
    .option("--set <key=value>", "set a monitor field (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file of monitor fields")
    .action(async (opts) => {
      const type = opts.type as string;
      const urlTypes = type === "http" || type === "keyword" || type === "json-query";
      if (urlTypes && !opts.url) {
        fail(2, `--type ${type} requires --url`);
      }
      if (type === "keyword" && !opts.keyword) fail(2, "--type keyword requires --keyword");
      if (type === "json-query") {
        if (!opts.jsonPath) fail(2, "--type json-query requires --json-path");
        if (opts.expectedValue === undefined) {
          fail(2, "--type json-query requires --expected-value");
        }
      }
      if (type === "port" || type === "steam" || type === "gamedig") {
        if (!opts.hostname) fail(2, `--type ${type} requires --hostname`);
        if (opts.port === undefined) fail(2, `--type ${type} requires --port`);
      }
      if (type === "ping" || type === "dns" || type === "tailscale-ping") {
        if (!opts.hostname) fail(2, `--type ${type} requires --hostname`);
      }
      if (type === "docker") {
        if (!opts.dockerContainer) fail(2, "--type docker requires --docker-container");
        if (opts.dockerHost === undefined) fail(2, "--type docker requires --docker-host");
      }
      if (type === "gamedig" && !opts.game) fail(2, "--type gamedig requires --game");
      if (opts.pushToken === "") fail(2, "--push-token must not be empty");

      const sets = parseSets(opts.set as string[] | undefined);
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      checkAddFields(sets, "--set");
      checkAddFields(fileConfig, "--config-file");
      refuseSecretSets(sets);
      validateHatchValues(sets);
      validateHatchValues(fileConfig);
      if (sets.notificationIDList !== undefined) {
        checkNotificationIdList(sets.notificationIDList);
      }
      if (fileConfig.notificationIDList !== undefined) {
        checkNotificationIdList(fileConfig.notificationIDList);
      }
      const parentOpt = opts.parent === undefined ? undefined : parseParent(opts.parent);
      if (
        parentOpt !== undefined &&
        (sets.parent !== undefined || fileConfig.parent !== undefined)
      ) {
        fail(2, "use either --parent or a parent key in --set/--config-file, not both");
      }
      // --parent and a hatch parent key are mutually exclusive (checked
      // above); between the hatch sources --set beats --config-file.
      let parentInput: unknown;
      if (sets.parent !== undefined) {
        parentInput = sets.parent;
      } else if (fileConfig.parent !== undefined) {
        parentInput = fileConfig.parent;
      } else {
        parentInput = parentOpt;
      }
      const normalizedParent = parentInput === undefined ? undefined : normalizeParent(parentInput);

      // The merged pushToken must be a non-empty string; the token printed and
      // built into pushUrl is always the one sent to Kuma.
      let pushToken: string | undefined;
      if (type === "push") {
        let source = "--push-token";
        let merged: unknown = (opts.pushToken as string | undefined) ?? generatePushToken();
        if (fileConfig.pushToken !== undefined) {
          source = "--config-file";
          merged = fileConfig.pushToken;
        }
        if (sets.pushToken !== undefined) {
          source = "--set";
          merged = sets.pushToken;
        }
        if (typeof merged !== "string" || merged === "") {
          fail(2, `${source} pushToken must be a non-empty string`);
        }
        pushToken = merged;
      }

      const interval = parsePositiveNumber(opts.interval ?? "60", "--interval");
      const retryInterval =
        opts.retryInterval === undefined
          ? undefined
          : parsePositiveNumber(opts.retryInterval, "--retry-interval");
      const maxRetries = parseNonNegativeInteger(opts.maxRetries ?? "0", "--max-retries");
      const resendInterval = parseNonNegativeInteger(
        opts.resendInterval ?? "0",
        "--resend-interval",
      );
      const timeout =
        opts.timeout === undefined ? undefined : parseTimeoutSeconds(opts.timeout, "--timeout");
      const proxyIdOption =
        opts.proxyId === undefined ? undefined : parseId(opts.proxyId, "--proxy-id");
      // dns defaults to resolver port 53 like the UI's type watcher; the other
      // port types require --port (checked above).
      let port: number | undefined;
      if (type === "dns") {
        port = opts.port === undefined ? 53 : parsePort(opts.port, "--port");
      } else if (type === "port" || type === "steam" || type === "gamedig") {
        port = parsePort(opts.port, "--port");
      }
      const packetSize =
        type === "ping" && opts.packetSize !== undefined
          ? parsePositiveInteger(opts.packetSize, "--packet-size")
          : undefined;
      const dockerHost = type === "docker" ? parseId(opts.dockerHost, "--docker-host") : undefined;
      // A hatch can null out the host the flag supplied; docker still needs one.
      // Precedence matches the merge below: --set beats --config-file beats the flag.
      let mergedDockerHost: unknown = dockerHost;
      let dockerHostSource = "--docker-host";
      if (fileConfig.docker_host !== undefined) {
        mergedDockerHost = fileConfig.docker_host;
        dockerHostSource = "--config-file";
      }
      if (sets.docker_host !== undefined) {
        mergedDockerHost = sets.docker_host;
        dockerHostSource = "--set";
      }
      if (type === "docker" && typeof mergedDockerHost !== "number") {
        fail(2, `${dockerHostSource} docker_host must be a docker host id`);
      }
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

      const ids: number[] = s
        .notifications()
        .filter((n) => n.isDefault === true)
        .map((n) => n.id);
      if (notificationsFrom !== undefined) {
        const src = s.monitorById(notificationsFrom);
        if (!src) fail(1, `monitor ${notificationsFrom} not found`);
        ids.push(...notificationIdArray(src.notificationIDList));
      }
      ids.push(...notificationIds);

      let proxyId: number | null;
      if (proxyIdOption !== undefined) {
        proxyId = proxyIdOption;
      } else if (type !== "port" && type !== "push") {
        // The UI assigns the default proxy on add for every type; only the
        // picker is limited to http / keyword / json-query. port and push keep
        // the CLI's existing null.
        proxyId = s.proxies().find((p) => p.default)?.id ?? null;
      } else {
        proxyId = null;
      }

      const active = !opts.paused;
      // Precedence: UI defaults < typed flags < --config-file < --set.
      const typed: Record<string, unknown> = {
        type,
        name,
        url: null,
        interval,
        resendInterval,
        maxretries: maxRetries,
        notificationIDList: notificationIdObject(ids),
        proxyId,
        active,
      };
      // retryInterval and timeout are only sent when explicit; their defaults
      // derive from the final interval after the merge below.
      if (retryInterval !== undefined) typed.retryInterval = retryInterval;
      if (timeout !== undefined) typed.timeout = timeout;
      if (normalizedParent !== undefined) typed.parent = normalizedParent;
      if (urlTypes) typed.url = opts.url;
      if (type === "keyword") typed.keyword = opts.keyword;
      if (type === "json-query") {
        typed.jsonPath = opts.jsonPath;
        typed.expectedValue = opts.expectedValue;
      }
      if (port !== undefined) {
        typed.hostname = opts.hostname;
        typed.port = port;
      }
      if (type === "ping" || type === "tailscale-ping") typed.hostname = opts.hostname;
      if (packetSize !== undefined) typed.packetSize = packetSize;
      if (type === "dns") {
        if (opts.dnsResolveServer !== undefined) {
          typed.dns_resolve_server = opts.dnsResolveServer;
        }
        if (opts.dnsResolveType !== undefined) typed.dns_resolve_type = opts.dnsResolveType;
      }
      if (type === "docker") {
        typed.docker_container = opts.dockerContainer;
        typed.docker_host = dockerHost;
      }
      if (type === "gamedig") typed.game = opts.game;
      if (type === "push") typed.pushToken = pushToken;

      let pushBase = s.url;
      if (pushToken !== undefined) {
        const settings = await s.request("getSettings");
        const data = settings?.data as Record<string, unknown> | undefined;
        const primary = data?.primaryBaseURL;
        if (typeof primary === "string" && primary !== "") {
          pushBase = primary.replace(/\/+$/, "");
        }
      }

      const monitor: Record<string, unknown> = {
        ...MONITOR_DEFAULTS,
        ...typed,
        ...fileConfig,
        ...sets,
      };
      if (normalizedParent !== undefined) monitor.parent = normalizedParent;
      monitor.notificationIDList = notificationIdObject(monitor.notificationIDList);
      deriveMonitorTiming(monitor);
      validateFinalMonitor(s, monitor);

      const res = await s.request("add", [monitor]);
      const out: Record<string, unknown> = {
        id: res?.monitorID ?? null,
        name,
        type,
        active: monitor.active !== false,
      };
      if (pushToken !== undefined) {
        out.pushToken = pushToken;
        out.pushUrl = `${pushBase}/api/push/${encodeURIComponent(pushToken)}?status=up&msg=OK&ping=`;
      }
      printJson(out);
    });

  monitors
    .command("edit <id>")
    .description("Edit a monitor")
    .option("--set <key=value>", "set a field (repeatable)", collect, [])
    .option("--parent <groupId>", "parent group monitor id ('none' clears it)")
    .option("--config-file <path>", "JSON file of monitor fields")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      const sets = parseSets(opts.set as string[] | undefined);
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      const parentOpt = opts.parent === undefined ? undefined : parseParent(opts.parent);
      if (
        parentOpt !== undefined &&
        (sets.parent !== undefined || fileConfig.parent !== undefined)
      ) {
        fail(2, "use either --parent or a parent key in --set/--config-file, not both");
      }
      if (
        (opts.set as string[]).length === 0 &&
        Object.keys(fileConfig).length === 0 &&
        parentOpt === undefined
      ) {
        fail(2, "monitors edit requires at least one --set key=value, --config-file or --parent");
      }
      checkEditFields(sets, "--set");
      checkEditFields(fileConfig, "--config-file");
      refuseSecretSets(sets);
      validateHatchValues(sets);
      validateHatchValues(fileConfig);
      // The parent checks run on the final merged value, whichever source set
      // it: --parent and a hatch parent key are mutually exclusive (checked
      // above); between the hatch sources --set beats --config-file.
      let parentInput: unknown;
      if (parentOpt !== undefined) {
        parentInput = parentOpt;
      } else if (sets.parent !== undefined) {
        parentInput = sets.parent;
      } else {
        parentInput = fileConfig.parent;
      }
      const normalizedParent = parentInput === undefined ? undefined : normalizeParent(parentInput);
      // Kuma 1.23 only rejects descendants as parent, not the monitor itself, and a self-parent
      // makes its parent walk loop forever
      if (normalizedParent === id) fail(2, "parent cannot be the monitor itself");
      if (sets.notificationIDList !== undefined) {
        checkNotificationIdList(sets.notificationIDList);
      }
      if (fileConfig.notificationIDList !== undefined) {
        checkNotificationIdList(fileConfig.notificationIDList);
      }
      const s = await connect();
      const fetched = await fetchMonitor(s, id);
      const monitor: Record<string, unknown> = { ...fetched };
      for (const [k, v] of Object.entries(fileConfig)) monitor[k] = v;
      for (const [k, v] of Object.entries(sets)) monitor[k] = v;
      if (normalizedParent !== undefined) monitor.parent = normalizedParent;
      // Kuma iterates notificationIDList with for...in, so an array would be
      // stored under its indexes; always send the object shape.
      monitor.notificationIDList = notificationIdObject(monitor.notificationIDList);
      deriveMonitorTiming(monitor);
      validateFinalMonitor(s, monitor);
      await s.request("editMonitor", [monitor]);
      // editMonitor ignores fields like `active`, so print what Kuma saved.
      const saved = await fetchMonitor(s, id);
      printJson({
        ...redactSecrets(saved),
        notificationIDList: notificationIdArray(saved.notificationIDList),
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

  monitors
    .command("delete <id>")
    .description("Delete a monitor")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      if (!opts.yes) fail(2, `would delete monitor ${id}; pass --yes to delete`);
      const s = await connect();
      // Kuma 1.23 answers ok even for an unknown id, so the pushed list is the only check
      if (!s.monitorById(id)) fail(1, `monitor ${id} not found`);
      await s.request("deleteMonitor", [id]);
      printJson({ id, deleted: true });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
