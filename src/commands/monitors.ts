import { Option, type Command } from "commander";
import {
  CliError,
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
  readTextFile,
} from "../lib.ts";
import { connect, MONITOR_ADD_FIELDS, type KumaSession, type Monitor } from "../kuma.ts";

// Order follows the type picker of EditMonitor.vue in Kuma 1.23.17.
const MONITOR_TYPES = [
  "group",
  "http",
  "port",
  "ping",
  "keyword",
  "json-query",
  "grpc-keyword",
  "dns",
  "docker",
  "real-browser",
  "push",
  "steam",
  "gamedig",
  "mqtt",
  "kafka-producer",
  "sqlserver",
  "postgres",
  "mysql",
  "mongodb",
  "radius",
  "redis",
  "tailscale-ping",
] as const;

// The five database types of EditMonitor.vue all show a required
// databaseConnectionString. The UI's type watcher prefills it with a template
// (connectionStringTemplates); the CLI sends no default, so a missing one is
// only caught on the merged monitor in validateFinalMonitor.
const DATABASE_TYPES = ["sqlserver", "postgres", "mysql", "mongodb", "redis"] as const;

// sqlserver / postgres / mysql also show the optional databaseQuery textarea.
const DATABASE_QUERY_TYPES = ["sqlserver", "postgres", "mysql"] as const;

// kafkaSaslMechanismOptions of EditMonitor.vue
const KAFKA_SASL_MECHANISMS = ["None", "plain", "scram-sha-256", "scram-sha-512", "aws"] as const;

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
export function redactUrl(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // unparseable: the userinfo boundary is unknown, so hide the whole value
    return value.includes("@") ? "***" : value;
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

// MIN/MAX_INTERVAL_SECOND of src/util.ts in Kuma 1.23.17; Monitor.validate()
// enforces the same bounds server-side before the monitor is stored.
const MIN_INTERVAL_SECOND = 20;
const MAX_INTERVAL_SECOND = 2073600;

function parseMonitorInterval(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_SECOND || n > MAX_INTERVAL_SECOND) {
    fail(
      2,
      `${flag} must be between ${MIN_INTERVAL_SECOND} and ${MAX_INTERVAL_SECOND} seconds, got "${value}"`,
    );
  }
  return n;
}

// A kafkaProducerBrokers entry is "host:port"; kafkajs splits the string on
// ":" (connectionPoolBuilder), so a host containing ":" cannot work.
function isKafkaBroker(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  const [host, port] = parts;
  if (!host || !port) return false;
  if (!/^\d+$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

const HATCH_VALUE_CHECKS: Record<string, (value: unknown, key: string) => unknown> = {
  interval: (v, k) => hatchNumber(v, k, parseMonitorInterval),
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
  // edit may switch the type to any the 1.23.17 picker offers; anything else
  // is not a monitor type at all.
  type: (v, k) => {
    if (typeof v !== "string" || !(MONITOR_TYPES as readonly string[]).includes(v)) {
      fail(2, `${k} must be one of ${MONITOR_TYPES.join(", ")}`);
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
    for (const broker of v) {
      if (!isKafkaBroker(broker)) fail(2, `${k} entries must be host:port strings`);
    }
    return v;
  },
  kafkaProducerSaslOptions: (v, k) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      fail(2, `${k} must be an object`);
    }
    const mechanism = (v as Record<string, unknown>).mechanism;
    if (!(KAFKA_SASL_MECHANISMS as readonly string[]).includes(mechanism as string)) {
      fail(2, `${k}.mechanism must be one of ${KAFKA_SASL_MECHANISMS.join(", ")}`);
    }
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
// it, derived from the final interval after the hatch had its say. Explicit
// values are kept; the cap applies to them the same way. On edit the caller
// runs this only when the edit touches interval or timeout — a stored
// timeout of 0 is otherwise sent back untouched, and Kuma 1.23.17 runs it
// as interval × 800 seconds on HTTP checks (the reason parseTimeoutSeconds
// refuses a user-supplied 0).
function deriveMonitorTiming(monitor: Record<string, unknown>): void {
  if (typeof monitor.interval !== "number") return;
  monitor.retryInterval = monitor.retryInterval ?? monitor.interval;
  monitor.timeout = Math.min(
    typeof monitor.timeout === "number" ? monitor.timeout : 48,
    Math.trunc(monitor.interval * 8) / 10,
  );
}

// The merged monitor is validated once on its final values, right before it is
// sent. On add that is the whole monitor; on edit only the fields the edit
// sets, plus every required field when the edit changes the type — a stored
// value the edit does not touch (the UI may save timeout 0, a deleted docker
// host as docker_host null, proxyId 0 or port 0) is sent back unchanged.
function validateFinalMonitor(
  s: KumaSession,
  monitor: Record<string, unknown>,
  edit?: { touched: ReadonlySet<string>; typeChanged: boolean },
): void {
  const type = typeof monitor.type === "string" ? monitor.type : "";
  const inScope = (field: string): boolean =>
    edit === undefined || edit.touched.has(field) || edit.typeChanged;
  const needString = (field: string): void => {
    if (!inScope(field)) return;
    const v = monitor[field];
    if (typeof v !== "string" || v === "") fail(2, `${field} must be a non-empty string`);
  };
  if (type === "http" || type === "keyword" || type === "json-query" || type === "real-browser") {
    needString("url");
  }
  if (type === "keyword" || type === "grpc-keyword") needString("keyword");
  if (type === "grpc-keyword") {
    needString("grpcUrl");
    needString("grpcServiceName");
    needString("grpcMethod");
    needString("grpcProtobuf");
    if (inScope("grpcBody")) {
      // A type change keeps the stored grpcBody; an empty one gets the same
      // "{}" default add uses, and the result must parse as JSON.
      if (
        edit?.typeChanged === true &&
        !edit.touched.has("grpcBody") &&
        (monitor.grpcBody === null || monitor.grpcBody === undefined || monitor.grpcBody === "")
      ) {
        monitor.grpcBody = "{}";
      }
      const body = monitor.grpcBody;
      if (typeof body !== "string") fail(2, "grpcBody must be a string containing JSON");
      try {
        JSON.parse(body);
      } catch {
        fail(2, "grpcBody must be a string containing JSON");
      }
    }
  }
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
    type === "tailscale-ping" ||
    type === "mqtt" ||
    type === "radius"
  ) {
    needString("hostname");
  }
  if (
    (type === "port" ||
      type === "steam" ||
      type === "gamedig" ||
      type === "mqtt" ||
      type === "radius") &&
    inScope("port")
  ) {
    const port = monitor.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail(2, "port must be a port number");
    }
  }
  if (type === "mqtt") needString("mqttTopic");
  if (type === "kafka-producer") {
    needString("kafkaProducerTopic");
    needString("kafkaProducerMessage");
    if (inScope("kafkaProducerBrokers")) {
      const brokers = monitor.kafkaProducerBrokers;
      if (
        !Array.isArray(brokers) ||
        brokers.length === 0 ||
        brokers.some((b) => !isKafkaBroker(b))
      ) {
        fail(2, "kafkaProducerBrokers must be a non-empty array of host:port strings");
      }
    }
  }
  if (type === "radius") {
    needString("radiusUsername");
    needString("radiusPassword");
    needString("radiusSecret");
    needString("radiusCalledStationId");
    needString("radiusCallingStationId");
  }
  // databaseConnectionString is a secret, so it can only arrive through
  // --config-file (--set refuses it) and there is no typed flag to check
  // early: the merged monitor is judged here.
  const isDatabaseType = (DATABASE_TYPES as readonly string[]).includes(type);
  if (isDatabaseType && inScope("databaseConnectionString")) {
    const conn = monitor.databaseConnectionString;
    if (typeof conn !== "string" || conn === "") {
      fail(2, "databaseConnectionString must be a non-empty string; pass it in --config-file");
    }
  }
  if (type === "gamedig") needString("game");
  if (type === "docker") {
    needString("docker_container");
    if (inScope("docker_host") && typeof monitor.docker_host !== "number") {
      fail(2, "docker_host must be a docker host id");
    }
  }
  if (type === "push" && inScope("pushToken")) {
    const token = monitor.pushToken;
    if (typeof token !== "string" || token === "") {
      fail(2, "pushToken must be a non-empty string");
    }
  }
  // dns_resolve_server is required only of a dns monitor; on edit it is
  // judged only when the edit sets it or switches the type to dns.
  if (type === "dns" && inScope("dns_resolve_server")) {
    const server = monitor.dns_resolve_server;
    if (typeof server !== "string" || server === "") {
      fail(2, "dns_resolve_server must be a non-empty string");
    }
  }

  if (edit === undefined || edit.touched.has("parent")) {
    // parent reaches Kuma as a number or null; the sources above already
    // normalized it, so this only re-checks the merged result against the
    // pushed monitorList.
    checkParentGroup(s, normalizeParent(monitor.parent ?? null));
  }
  if (
    edit === undefined ||
    edit.touched.has("docker_host") ||
    (edit.typeChanged && type === "docker")
  ) {
    checkDockerHost(s, monitor.docker_host);
  }
  if (edit === undefined || edit.touched.has("proxyId")) {
    const proxyId = monitor.proxyId;
    if (typeof proxyId === "number" && !s.proxies().some((p) => p.id === proxyId)) {
      fail(1, `proxy ${proxyId} not found`);
    }
  }
}

// monitor.tags rows are the monitor_tag⋈tag join the server sends:
// { id, monitor_id, tag_id, value, name, color }
type MonitorTagRow = {
  tag_id?: unknown;
  value?: unknown;
  name?: unknown;
};

function monitorTags(monitor: Record<string, unknown>): MonitorTagRow[] {
  const tags = monitor.tags;
  return Array.isArray(tags) ? (tags as MonitorTagRow[]) : [];
}

const tagJson = (t: MonitorTagRow) => ({
  tagId: t.tag_id ?? null,
  name: t.name ?? null,
  value: t.value ?? null,
});

// --tag takes <tagId> or <tagId>:<value>; the value may contain colons and
// defaults to "" like monitors tag --value.
function parseMonitorTag(raw: string): { tagId: number; value: string } {
  const colon = raw.indexOf(":");
  const idPart = colon === -1 ? raw : raw.slice(0, colon);
  return { tagId: parseId(idPart, "--tag"), value: colon === -1 ? "" : raw.slice(colon + 1) };
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
  tags: monitorTags(m).map(tagJson),
});

export function registerMonitors(program: Command): void {
  const monitors = program.command("monitors").description("Manage monitors");

  monitors
    .command("list")
    .description("List monitors")
    .option("--name <substring>", "filter by name (case-insensitive)")
    .option("--tag <name>", "filter by tag name (exact, case-sensitive)")
    .action(async (opts) => {
      const s = await connect();
      const needle = typeof opts.name === "string" ? opts.name.toLowerCase() : undefined;
      const tagName = typeof opts.tag === "string" ? opts.tag : undefined;
      const items = s
        .monitors()
        .filter(
          (m) =>
            (!needle || m.name.toLowerCase().includes(needle)) &&
            (tagName === undefined || monitorTags(m).some((t) => t.name === tagName)),
        );
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
        tags: monitorTags(m).map(tagJson),
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
    .option(
      "--hostname <hostname>",
      "hostname (port, ping, dns, steam, gamedig, mqtt, radius, tailscale-ping)",
    )
    .option("--port <port>", "port (port, dns, steam, gamedig, mqtt, radius)")
    .option("--keyword <keyword>", "keyword (keyword, grpc-keyword types)")
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
    .option("--grpc-url <url>", "gRPC url (grpc-keyword type)")
    .option("--grpc-service-name <name>", "gRPC service name (grpc-keyword type)")
    .option("--grpc-method <method>", "gRPC method (grpc-keyword type)")
    .option("--grpc-protobuf <path>", "proto file path (grpc-keyword type)")
    .option("--grpc-enable-tls", "enable TLS for gRPC (grpc-keyword type)")
    .option("--invert-keyword", "invert the keyword match (keyword, grpc-keyword types)")
    .option("--mqtt-topic <topic>", "MQTT topic (mqtt type)")
    .option("--mqtt-username <username>", "MQTT username (mqtt type)")
    .option("--mqtt-success-message <message>", "MQTT success message (mqtt type)")
    .option(
      "--kafka-producer-broker <host:port>",
      "kafka broker (kafka-producer type, repeatable)",
      collect,
      [],
    )
    .option("--kafka-producer-topic <topic>", "kafka topic (kafka-producer type)")
    .option("--kafka-producer-message <message>", "kafka message (kafka-producer type)")
    .option("--kafka-producer-ssl", "enable SSL for kafka (kafka-producer type)")
    .option(
      "--kafka-producer-allow-auto-topic-creation",
      "allow auto topic creation (kafka-producer type)",
    )
    .option("--radius-username <username>", "radius username (radius type)")
    .option("--radius-called-station-id <id>", "radius called station id (radius type)")
    .option("--radius-calling-station-id <id>", "radius calling station id (radius type)")
    .option("--database-query <sql>", "SQL query (sqlserver, postgres, mysql types)")
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
    .option("--tag <tagId[:value]>", "attach a tag (repeatable)", collect, [])
    .option("--set <key=value>", "set a monitor field (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file of monitor fields")
    .action(async (opts) => {
      const type = opts.type as string;
      const urlTypes =
        type === "http" || type === "keyword" || type === "json-query" || type === "real-browser";
      if (urlTypes && !opts.url) {
        fail(2, `--type ${type} requires --url`);
      }
      if ((type === "keyword" || type === "grpc-keyword") && !opts.keyword) {
        fail(2, `--type ${type} requires --keyword`);
      }
      if (type === "json-query") {
        if (!opts.jsonPath) fail(2, "--type json-query requires --json-path");
        if (opts.expectedValue === undefined) {
          fail(2, "--type json-query requires --expected-value");
        }
        if (opts.expectedValue === "") fail(2, "expectedValue must be a non-empty string");
      }
      if (type === "grpc-keyword") {
        if (!opts.grpcUrl) fail(2, "--type grpc-keyword requires --grpc-url");
        if (!opts.grpcServiceName) {
          fail(2, "--type grpc-keyword requires --grpc-service-name");
        }
        if (!opts.grpcMethod) fail(2, "--type grpc-keyword requires --grpc-method");
        if (!opts.grpcProtobuf) {
          fail(2, "--type grpc-keyword requires --grpc-protobuf");
        }
      }
      if (type === "port" || type === "steam" || type === "gamedig" || type === "mqtt") {
        if (!opts.hostname) fail(2, `--type ${type} requires --hostname`);
        if (opts.port === undefined) fail(2, `--type ${type} requires --port`);
      }
      if (type === "mqtt" && !opts.mqttTopic) fail(2, "--type mqtt requires --mqtt-topic");
      if (type === "kafka-producer") {
        const brokers = (opts.kafkaProducerBroker as string[] | undefined) ?? [];
        if (brokers.length === 0) {
          fail(2, "--type kafka-producer requires --kafka-producer-broker");
        }
        for (const broker of brokers) {
          if (!isKafkaBroker(broker)) {
            fail(2, `--kafka-producer-broker must be host:port, got "${broker}"`);
          }
        }
        if (!opts.kafkaProducerTopic) {
          fail(2, "--type kafka-producer requires --kafka-producer-topic");
        }
        if (!opts.kafkaProducerMessage) {
          fail(2, "--type kafka-producer requires --kafka-producer-message");
        }
      }
      if (type === "ping" || type === "dns" || type === "tailscale-ping" || type === "radius") {
        if (!opts.hostname) fail(2, `--type ${type} requires --hostname`);
      }
      if (type === "radius") {
        if (!opts.radiusUsername) fail(2, "--type radius requires --radius-username");
        if (!opts.radiusCalledStationId) {
          fail(2, "--type radius requires --radius-called-station-id");
        }
        if (!opts.radiusCallingStationId) {
          fail(2, "--type radius requires --radius-calling-station-id");
        }
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

      const interval = parseMonitorInterval(opts.interval ?? "60", "--interval");
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
      // dns and radius get their well-known ports from the UI's type watcher
      // (53 / 1812); the other port types require --port (checked above).
      let port: number | undefined;
      if (type === "dns") {
        port = opts.port === undefined ? 53 : parsePort(opts.port, "--port");
      } else if (type === "radius") {
        port = opts.port === undefined ? 1812 : parsePort(opts.port, "--port");
      } else if (type === "port" || type === "steam" || type === "gamedig" || type === "mqtt") {
        port = parsePort(opts.port, "--port");
      }
      const grpcProtobuf =
        type === "grpc-keyword" && opts.grpcProtobuf !== undefined
          ? readTextFile(opts.grpcProtobuf, "--grpc-protobuf")
          : undefined;
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
      const tagSpecs = ((opts.tag ?? []) as string[]).map(parseMonitorTag);
      const seenTags = new Set<string>();
      for (const spec of tagSpecs) {
        const key = JSON.stringify([spec.tagId, spec.value]);
        if (seenTags.has(key)) fail(2, `duplicate --tag ${spec.tagId}:${spec.value}`);
        seenTags.add(key);
      }

      const s = await connect();
      const name = opts.name as string;
      const existing = s.monitors().find((m) => m.name === name);
      if (existing) {
        printJson({ id: existing.id, name: existing.name, skipped: true });
        fail(3, "");
      }
      const tagNames = new Map<number, string>();
      if (tagSpecs.length > 0) {
        const available = await s.tags();
        for (const spec of tagSpecs) {
          const tag = available.find((t) => t.id === spec.tagId);
          if (!tag) fail(1, `tag ${spec.tagId} not found`);
          tagNames.set(spec.tagId, tag.name);
        }
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
      if (type === "keyword" || type === "grpc-keyword") {
        typed.keyword = opts.keyword;
        if (opts.invertKeyword) typed.invertKeyword = true;
      }
      if (type === "grpc-keyword") {
        typed.grpcUrl = opts.grpcUrl;
        typed.grpcServiceName = opts.grpcServiceName;
        typed.grpcMethod = opts.grpcMethod;
        // grpcBody absent parses to null, which protobufjs rejects as "request
        // must be specified"; "{}" is the empty request message.
        typed.grpcBody = "{}";
        if (grpcProtobuf !== undefined) typed.grpcProtobuf = grpcProtobuf;
        if (opts.grpcEnableTls) typed.grpcEnableTls = true;
      }
      if (type === "mqtt") {
        typed.mqttTopic = opts.mqttTopic;
        if (opts.mqttUsername !== undefined) typed.mqttUsername = opts.mqttUsername;
        if (opts.mqttSuccessMessage !== undefined) {
          typed.mqttSuccessMessage = opts.mqttSuccessMessage;
        }
      }
      if (type === "kafka-producer") {
        typed.kafkaProducerBrokers = opts.kafkaProducerBroker;
        typed.kafkaProducerTopic = opts.kafkaProducerTopic;
        typed.kafkaProducerMessage = opts.kafkaProducerMessage;
        if (opts.kafkaProducerSsl) typed.kafkaProducerSsl = true;
        if (opts.kafkaProducerAllowAutoTopicCreation) {
          typed.kafkaProducerAllowAutoTopicCreation = true;
        }
      }
      if (type === "radius") {
        typed.radiusUsername = opts.radiusUsername;
        typed.radiusCalledStationId = opts.radiusCalledStationId;
        typed.radiusCallingStationId = opts.radiusCallingStationId;
      }
      // Like the other type-specific flags, --database-query is ignored on
      // types that do not read it (redis, mongodb, and everything else).
      if ((DATABASE_QUERY_TYPES as readonly string[]).includes(type)) {
        if (opts.databaseQuery !== undefined) typed.databaseQuery = opts.databaseQuery;
      }
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
      if (tagSpecs.length > 0) {
        const attached: Record<string, unknown>[] = [];
        for (const spec of tagSpecs) {
          try {
            await s.request("addMonitorTag", [spec.tagId, out.id, spec.value]);
          } catch (err) {
            // The monitor exists; report which tags were attached before failing.
            out.tags = attached;
            printJson(out);
            if (err instanceof CliError && err.exitCode === 1) {
              fail(
                1,
                `monitor ${String(out.id)} was created, but attaching tag ${spec.tagId} failed: ${err.message}`,
              );
            }
            throw err;
          }
          attached.push({
            tagId: spec.tagId,
            name: tagNames.get(spec.tagId) ?? null,
            value: spec.value,
          });
        }
        out.tags = attached;
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
      const touched = new Set([...Object.keys(fileConfig), ...Object.keys(sets)]);
      if (parentOpt !== undefined) touched.add("parent");
      const timingTouched =
        sets.interval !== undefined ||
        fileConfig.interval !== undefined ||
        sets.timeout !== undefined ||
        fileConfig.timeout !== undefined;
      if (timingTouched) deriveMonitorTiming(monitor);
      validateFinalMonitor(s, monitor, { touched, typeChanged: monitor.type !== fetched.type });
      await s.request("editMonitor", [monitor]);
      // editMonitor ignores fields like `active`, so print what Kuma saved.
      const saved = await fetchMonitor(s, id);
      printJson({
        ...redactSecrets(saved),
        notificationIDList: notificationIdArray(saved.notificationIDList),
        tags: monitorTags(saved).map(tagJson),
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

  monitors
    .command("tag <id>")
    .description("Attach a tag to a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .option("--value <value>", "tag value")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value ?? "";
      const s = await connect();
      const monitor = s.monitorById(id);
      if (!monitor) fail(1, `monitor ${id} not found`);
      if (!(await s.tags()).some((t) => t.id === tagId)) fail(1, `tag ${tagId} not found`);
      // addMonitorTag has no unique constraint, but the same tag+value twice is meaningless
      if (monitorTags(monitor).some((t) => t.tag_id === tagId && t.value === value)) {
        printJson({ id, tagId, value, skipped: true });
        fail(3, "");
      }
      await s.request("addMonitorTag", [tagId, id, value]);
      printJson({ id, tagId, value });
    });

  monitors
    .command("untag <id>")
    .description("Detach a tag from a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .option("--value <value>", "tag value")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value ?? "";
      const s = await connect();
      const monitor = s.monitorById(id);
      if (!monitor) fail(1, `monitor ${id} not found`);
      const attached = monitorTags(monitor).filter((t) => t.tag_id === tagId);
      if (!attached.some((t) => t.value === value)) {
        // deleteMonitorTag matches with `value = ?`, which never matches a stored
        // NULL; only the default "" request can be aiming at such a row
        if (value === "" && attached.some((t) => t.value === null)) {
          fail(
            1,
            `tag ${tagId} on monitor ${id} has a null value; deleteMonitorTag cannot match it`,
          );
        }
        fail(1, `monitor ${id} does not have tag ${tagId} with value ${JSON.stringify(value)}`);
      }
      await s.request("deleteMonitorTag", [tagId, id, value]);
      printJson({ id, tagId, value, removed: true });
    });

  monitors
    .command("retag <id>")
    .description("Change the value of a tag on a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .requiredOption("--value <value>", "new tag value")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "monitor id");
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value as string;
      const s = await connect();
      const monitor = s.monitorById(id);
      if (!monitor) fail(1, `monitor ${id} not found`);
      const rows = monitorTags(monitor).filter((t) => t.tag_id === tagId);
      if (rows.length === 0) {
        fail(1, `monitor ${id} does not have tag ${tagId}`);
      }
      // editMonitorTag rewrites the value on every row of that tag, so a
      // monitor tagged twice would end up with identical duplicate rows
      if (rows.length > 1) {
        fail(
          1,
          `monitor ${id} has tag ${tagId} attached ${rows.length} times; use untag + tag instead`,
        );
      }
      await s.request("editMonitorTag", [tagId, id, value]);
      printJson({ id, tagId, value });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
