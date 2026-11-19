import { Option, type Command } from "commander";
import {
  CliError,
  decimalNumber,
  fail,
  isIdLiteral,
  notificationIdArray,
  notificationIdObject,
  parseId,
  parseNonNegativeInteger,
  parsePort,
  parsePositiveNumber,
  parseSets,
  printJson,
  readJsonFile,
  readTextFile,
} from "../lib.ts";
import {
  connect,
  MONITOR_ADD_FIELDS,
  MONITOR_2X_FIELDS,
  type KumaSession,
  type Monitor,
} from "../kuma.ts";

// Order follows the type picker of EditMonitor.vue in Kuma 1.23.17. The picker
// hides tailscale-ping when info.isContainer reports the server runs in its
// container image (it ships no tailscale binary), so that type is refused
// after connect.
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

// evaluateJsonQuery operators of 2.5.11/src/util.ts; jsonPathOperator is a
// 2.x-only monitor field and the 2.x UI defaults it to "==".
const JSON_PATH_OPERATORS = ["==", "!=", "<", "<=", ">", ">=", "contains"] as const;

// monitorTypesWithEncodingAllowed of EditMonitor.vue's submit() (1.23.17 and
// 2.5.11 alike): httpBodyEncoding stays on the monitor only for these types;
// for every other type the UI sends null.
const BODY_ENCODING_TYPES = ["http", "keyword", "json-query"] as const;

// The url field is required for exactly these types (the urlTypes check of
// the add command).
const URL_TYPES = ["http", "keyword", "json-query", "real-browser"] as const;

// Type-specific flags and the types the 1.23.17 picker shows them on; opt is
// commander's camel-case of the flag. A flag given for another type is stored
// ignored — refused below so a mistyped --type does not silently drop it.
const TYPE_FLAGS: { flag: string; opt: string; types: readonly string[] }[] = [
  { flag: "--url", opt: "url", types: URL_TYPES },
  {
    flag: "--hostname",
    opt: "hostname",
    types: ["port", "ping", "dns", "steam", "gamedig", "mqtt", "radius", "tailscale-ping"],
  },
  { flag: "--port", opt: "port", types: ["port", "dns", "steam", "gamedig", "mqtt", "radius"] },
  { flag: "--keyword", opt: "keyword", types: ["keyword", "grpc-keyword"] },
  { flag: "--invert-keyword", opt: "invertKeyword", types: ["keyword", "grpc-keyword"] },
  { flag: "--json-path", opt: "jsonPath", types: ["json-query"] },
  { flag: "--json-path-operator", opt: "jsonPathOperator", types: ["json-query"] },
  { flag: "--expected-value", opt: "expectedValue", types: ["json-query"] },
  { flag: "--packet-size", opt: "packetSize", types: ["ping"] },
  { flag: "--dns-resolve-server", opt: "dnsResolveServer", types: ["dns"] },
  { flag: "--dns-resolve-type", opt: "dnsResolveType", types: ["dns"] },
  { flag: "--docker-container", opt: "dockerContainer", types: ["docker"] },
  { flag: "--docker-host", opt: "dockerHost", types: ["docker"] },
  { flag: "--game", opt: "game", types: ["gamedig"] },
  { flag: "--grpc-url", opt: "grpcUrl", types: ["grpc-keyword"] },
  { flag: "--grpc-service-name", opt: "grpcServiceName", types: ["grpc-keyword"] },
  { flag: "--grpc-method", opt: "grpcMethod", types: ["grpc-keyword"] },
  { flag: "--grpc-protobuf", opt: "grpcProtobuf", types: ["grpc-keyword"] },
  { flag: "--grpc-enable-tls", opt: "grpcEnableTls", types: ["grpc-keyword"] },
  { flag: "--mqtt-topic", opt: "mqttTopic", types: ["mqtt"] },
  { flag: "--mqtt-username", opt: "mqttUsername", types: ["mqtt"] },
  { flag: "--mqtt-success-message", opt: "mqttSuccessMessage", types: ["mqtt"] },
  { flag: "--kafka-producer-broker", opt: "kafkaProducerBroker", types: ["kafka-producer"] },
  { flag: "--kafka-producer-topic", opt: "kafkaProducerTopic", types: ["kafka-producer"] },
  { flag: "--kafka-producer-message", opt: "kafkaProducerMessage", types: ["kafka-producer"] },
  { flag: "--kafka-producer-ssl", opt: "kafkaProducerSsl", types: ["kafka-producer"] },
  {
    flag: "--kafka-producer-allow-auto-topic-creation",
    opt: "kafkaProducerAllowAutoTopicCreation",
    types: ["kafka-producer"],
  },
  { flag: "--radius-username", opt: "radiusUsername", types: ["radius"] },
  { flag: "--radius-called-station-id", opt: "radiusCalledStationId", types: ["radius"] },
  { flag: "--radius-calling-station-id", opt: "radiusCallingStationId", types: ["radius"] },
  { flag: "--database-query", opt: "databaseQuery", types: DATABASE_QUERY_TYPES },
  { flag: "--push-token", opt: "pushToken", types: ["push"] },
];

// monitorDefaults of src/pages/EditMonitor.vue in Kuma 1.23.17, minus the fields the CLI always
// sets. Fields from Kuma 2.x must not be added: 1.23 stores the object as-is and fails on unknown
// columns; the 2.x-only add defaults live in MONITOR_2X_DEFAULTS below.
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

// The defaults a 2.x `add` needs on top of MONITOR_DEFAULTS: 2.5.11's add
// handler JSON.stringifies both unconditionally and monitor.conditions is
// NOT NULL, while 1.23 has no such columns. They sit at the defaults layer
// so --config-file / --set still win, and they are never sent to 1.23.
const MONITOR_2X_DEFAULTS: Record<string, unknown> = {
  conditions: [],
  rabbitmqNodes: [],
  // the 2.x UI sends it for every type, so a monitor later turned into
  // json-query still has an operator (null fails every beat)
  jsonPathOperator: "==",
};

// The timeout default the 2.x UI picks per type (2.5.11 EditMonitor.vue);
// every other type the CLI can add, and every type on 1.23, defaults to 48
// (the 2.x UI's snmp default of 5 does not apply: the picker has no snmp).
const KUMA2_TIMEOUT_DEFAULTS: Record<string, number> = { ping: 10, "kafka-producer": 1 };

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
  // Kuma 2.x fields; 1.23 never sends them
  "bearer_token",
  "gamedigToken",
  "rabbitmqPassword",
  "sshPassword",
  "sshPrivateKey",
  "sshPassphrase",
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
  if (parsed.password === "") {
    // an opaque-path parse like "u:p@host:port" has no host, so the userinfo
    // boundary is unknowable — hide the whole value like the catch branch
    return parsed.host === "" && value.includes("@") ? "***" : value;
  }
  parsed.password = "***";
  return parsed.toString();
}

function redactSecrets(monitor: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...monitor, url: redactUrl(monitor.url) };
  for (const key of SECRET_KEYS) {
    const value = out[key];
    // a --config-file value may be any JSON type, so redact by presence, not type
    if (value !== undefined && value !== null && value !== "") out[key] = "***";
  }
  const sasl = out.kafkaProducerSaslOptions;
  if (sasl !== null && typeof sasl === "object" && !Array.isArray(sasl)) {
    const copy: Record<string, unknown> = { ...(sasl as Record<string, unknown>) };
    for (const [k, v] of Object.entries(copy)) {
      if (!SASL_VISIBLE_KEYS.has(k) && v !== undefined && v !== null && v !== "") copy[k] = "***";
    }
    out.kafkaProducerSaslOptions = copy;
  }
  return out;
}

async function fetchMonitor(s: KumaSession, id: number): Promise<Record<string, unknown>> {
  const res = await s.request("getMonitor", [id]);
  const monitor = res?.monitor;
  // a missing monitor answers ok:false before this; a non-object monitor is
  // an unexpected shape, not "not found"
  if (monitor === null || typeof monitor !== "object" || Array.isArray(monitor)) {
    fail(70, "unexpected getMonitor response");
  }
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

// The allowlist is the union of both versions: the 2.x-only keys pass this
// pre-connect check and are refused after connect() on a 1.x server.
const isMonitorField = (key: string): boolean =>
  MONITOR_ADD_FIELDS.has(key) || MONITOR_2X_FIELDS.has(key);

// `monitors add --set/--config-file`: every key must be a field the `add`
// event accepts; id/type/name are set by the dedicated flags instead.
function checkAddFields(fields: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(fields)) {
    if (key === "id") fail(2, `${source} cannot set "id"; the id is assigned by Kuma`);
    if (key === "type" || key === "name") {
      fail(2, `${source} cannot set "${key}"; use --type/--name instead`);
    }
    if (!isMonitorField(key)) {
      fail(2, `${source} key "${key}" is not a monitor field`);
    }
  }
}

// `monitors edit`: same field set; only id is read-only, name/type keep the
// --set behavior they had before the escape hatch existed. `active` is a
// monitor field but editMonitor does not copy it onto the bean — a set
// active= would silently do nothing, so it is refused up front.
function checkEditFields(fields: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(fields)) {
    if (key === "id") fail(2, `${source} cannot set "id"; the id selects the monitor`);
    if (key === "active") {
      fail(2, `${source} cannot set "active"; use monitors pause / resume instead`);
    }
    if (!isMonitorField(key)) {
      fail(2, `${source} key "${key}" is not a monitor field`);
    }
  }
}

// A 2.x-only field can only be refused once the version is known: on 1.23
// `add` would fail on the unknown column and `editMonitor` would silently
// drop the value while answering ok.
function checkKuma2xFields(s: KumaSession, keys: Iterable<string>): void {
  if (s.majorVersion >= 2) return;
  for (const key of keys) {
    if (MONITOR_2X_FIELDS.has(key)) {
      fail(
        2,
        s.serverVersion === undefined
          ? `"${key}" needs Uptime Kuma 2.x; the server sent no version, so 1.x was assumed`
          : `"${key}" needs Uptime Kuma 2.x; the server reports ${s.serverVersion}`,
      );
    }
  }
}

type TimingField = { name: string; value: number };
type MonitorTiming = { interval?: TimingField; timeout?: TimingField; retryInterval?: TimingField };

// interval / timeout / retryInterval resolve like the payload merge —
// --set beats --config-file beats the typed flag — and a hatch value is
// already a number because validateHatchValues ran. Errors name the bare
// key for a hatch source, like the pre-connect checks report it, or the
// flag for a typed value; edit has no timing flags, so it passes {}.
function timingFields(
  sets: Record<string, unknown>,
  fileConfig: Record<string, unknown>,
  flags: Partial<Record<"interval" | "timeout" | "retryInterval", TimingField>>,
): MonitorTiming {
  const pick = (key: "interval" | "timeout" | "retryInterval"): TimingField | undefined => {
    const hatch = sets[key] !== undefined ? sets[key] : fileConfig[key];
    if (hatch !== undefined) return { name: key, value: hatch as number };
    return flags[key];
  };
  return {
    interval: pick("interval"),
    timeout: pick("timeout"),
    retryInterval: pick("retryInterval"),
  };
}

// The timing bounds that differ between Kuma versions, checked after
// connect() on the values the command sets. Both pickers use step=1 for
// interval and retryInterval, so non-integers are refused on either version.
// 1.23's Monitor.validate wants interval within 20..2073600 and its retry
// input is min=20 with no upper bound; its check code turns a timeout of 0
// into interval × 800 seconds. On 2.x every source was already held to the
// pre-connect union (interval/retryInterval > 0, timeout >= 0), so only the
// integer checks above apply. On edit only the values the edit sets are
// passed, so a stored timeout of 0 goes back untouched like before.
function checkMonitorTiming(s: KumaSession, timing: MonitorTiming): void {
  const interval = timing.interval;
  if (interval !== undefined && !Number.isInteger(interval.value)) {
    fail(2, `${interval.name} must be an integer number of seconds, got "${interval.value}"`);
  }
  const retryInterval = timing.retryInterval;
  if (retryInterval !== undefined && !Number.isInteger(retryInterval.value)) {
    fail(
      2,
      `${retryInterval.name} must be an integer number of seconds, got "${retryInterval.value}"`,
    );
  }
  if (s.majorVersion < 2) {
    if (
      interval !== undefined &&
      (interval.value < MIN_INTERVAL_SECOND || interval.value > MAX_INTERVAL_SECOND)
    ) {
      fail(
        2,
        `${interval.name} must be between ${MIN_INTERVAL_SECOND} and ${MAX_INTERVAL_SECOND} seconds, got "${interval.value}"`,
      );
    }
    if (retryInterval !== undefined && retryInterval.value < MIN_INTERVAL_SECOND) {
      fail(
        2,
        `${retryInterval.name} must be at least ${MIN_INTERVAL_SECOND} seconds on Uptime Kuma 1.x, got "${retryInterval.value}"`,
      );
    }
    const timeout = timing.timeout;
    if (timeout !== undefined && timeout.value <= 0) {
      fail(
        2,
        `${timeout.name} must be a positive number of seconds, got "${timeout.value}"; Kuma 1.23 turns 0 into interval × 800 seconds`,
      );
    }
  }
}

// A URL carries credentials as user:pass@host; redactUrl hides one the same
// way: when the URL does not parse, "@" marks a credential boundary the
// parser could not find, so the value counts as holding a secret.
function urlCarriesCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.password !== "" || (parsed.host === "" && value.includes("@"));
  } catch {
    return value.includes("@");
  }
}

// --set lands in argv; the secret fields only go through --config-file, and
// so does a url carrying credentials.
function refuseSecretSets(sets: Record<string, unknown>): void {
  for (const key of Object.keys(sets)) {
    if (HATCH_SECRET_KEYS.has(key)) {
      fail(2, `--set ${key}=... would put a secret in the command line; use --config-file instead`);
    }
    if (key === "url" && typeof sets[key] === "string" && urlCarriesCredentials(sets[key])) {
      fail(2, `--set url=... would put credentials in the command line; use --config-file instead`);
    }
  }
}

// "none" clears the parent; a positive integer is a group monitor id; any
// other value is an exact monitor name resolved against monitorList after
// connect.
function parseParent(value: string): number | null | string {
  if (value === "none") return null;
  return isIdLiteral(value) ? Number(value) : value;
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

// The --parent flag may carry a monitor name, which only resolves once the
// pushed monitorList is here; hatch parents were already normalized to
// number|null by validateHatchValues.
function resolveParent(s: KumaSession, value: unknown): number | null {
  if (typeof value === "string") return s.resolveMonitorId(value);
  return normalizeParent(value);
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

// Every notification id sent must name a row Kuma pushed in notificationList:
// 1.23's add stores the monitor first, and its updateMonitorNotification only
// inserts into monitor_notification afterwards — a foreign-key failure there
// leaves a half-created monitor (editMonitor likewise stores, wipes the old
// links, then fails). Checking before the call keeps the mutation atomic.
function checkNotificationIds(s: KumaSession, value: unknown): void {
  for (const id of notificationIdArray(value)) {
    if (!s.notificationById(id)) fail(1, `notification ${id} not found`);
  }
}

// The official image ships no tailscale binary, so the picker hides
// tailscale-ping when info.isContainer is set. Checked on the type the merged
// monitor ends up with — on add always, on edit only when the type changes.
function checkTailscalePing(s: KumaSession, type: unknown): void {
  if (type === "tailscale-ping" && s.isContainer === true) {
    fail(
      2,
      "tailscale-ping is not available: the server reports it runs in a container, which has no tailscale binary",
    );
  }
}

// The gamedig picker offers getGameList's entries; a game outside the list
// creates a monitor that goes down at its first check. Each entry's keys are
// the codes the lookup accepts (the UI stores keys[0], aliases resolve too).
async function checkGameId(s: KumaSession, monitor: Record<string, unknown>): Promise<void> {
  const game = monitor.game;
  if (typeof game !== "string" || game === "") return; // needString reports an empty one
  const res = await s.request("getGameList");
  const list = res?.gameList;
  if (!Array.isArray(list)) fail(70, "unexpected getGameList response");
  const known = list.some(
    (entry) =>
      Array.isArray((entry as { keys?: unknown }).keys) &&
      ((entry as { keys: unknown[] }).keys as unknown[]).includes(game),
  );
  if (!known) fail(1, `game "${game}" is not in the server's game list`);
}

// A hatch value for a key that has a typed flag goes through the flag's
// parser; flags take strings, so a string here parses the same way while a
// number is written out in plain decimal first (String() would give "1e-7",
// which the decimal-literal check refuses). The key names the error.
function hatchNumber(
  value: unknown,
  key: string,
  parse: (value: string, flag: string) => number,
): number {
  if (typeof value !== "number" && typeof value !== "string") {
    fail(2, `${key} must be a number`);
  }
  const text =
    typeof value === "number"
      ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 100 })
      : value;
  // Intl stops at 100 fraction digits, so 1e-101 would become "0"; refuse a
  // number that does not survive the round trip rather than send another value
  if (typeof value === "number" && Number(text) !== value) {
    fail(2, `${key} has more than 100 decimal places, got ${value}`);
  }
  return parse(text, key);
}

// timeout may be 0 on 2.x (it becomes interval * 0.8 seconds there); 1.23
// turns it into interval × 800 seconds, so the zero case is refused after
// connect() on a 1.x server. Negative, empty and non-numeric values are
// refused before connecting on both versions.
function parseTimeoutSeconds(value: string, flag: string): number {
  const n = decimalNumber(value);
  if (!Number.isFinite(n) || n < 0) {
    fail(2, `${flag} must be a non-negative number of seconds, got "${value}"`);
  }
  return n;
}

// The UI's packet-size input is min=1 max=65500 step=1 (EditMonitor.vue,
// PING_PACKET_SIZE_MAX of src/util.ts on 2.x).
function parsePacketSize(value: string, flag: string): number {
  const n = decimalNumber(value);
  if (!Number.isInteger(n) || n < 1 || n > 65500) {
    fail(2, `${flag} must be an integer between 1 and 65500, got "${value}"`);
  }
  return n;
}

// MIN/MAX_INTERVAL_SECOND of src/util.ts in Kuma 1.23.17; Monitor.validate()
// enforces the same bounds server-side before the monitor is stored. 2.x
// lowered the minimum to 1 and dropped the maximum, so only the union —
// finite and >= 1 — is checked before connect(); the 1.x bounds are
// re-checked after connect() on a 1.x server.
const MIN_INTERVAL_SECOND = 20;
const MAX_INTERVAL_SECOND = 2073600;

function parseMonitorInterval(value: string, flag: string): number {
  const n = decimalNumber(value);
  if (!Number.isFinite(n) || n < 1) {
    fail(2, `${flag} must be at least 1 second, got "${value}"`);
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
  packetSize: (v, k) => hatchNumber(v, k, parsePacketSize),
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
  conditions: (v, k) => {
    if (!Array.isArray(v)) fail(2, `${k} must be an array`);
    return v;
  },
  rabbitmqNodes: (v, k) => {
    if (!Array.isArray(v)) fail(2, `${k} must be an array`);
    return v;
  },
  jsonPathOperator: (v, k) => {
    if (typeof v !== "string" || !(JSON_PATH_OPERATORS as readonly string[]).includes(v)) {
      fail(2, `${k} must be one of ${JSON_PATH_OPERATORS.join(", ")}`);
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

// The timeout an unset one derives to: the 2.x UI picks it per type, 1.23
// uses 48 for every type.
function defaultTimeoutSeconds(s: KumaSession, type: string): number {
  if (s.majorVersion < 2) return 48;
  return KUMA2_TIMEOUT_DEFAULTS[type] ?? 48;
}

// retryInterval follows the interval and the timeout stays within 80% of
// it (unless capTimeout is false: a 2.x ping), derived from the final
// interval after the hatch had its say. Explicit values are kept; the cap
// applies to them the same way, and an unset
// timeout takes the caller's default — the 2.x UI picks it per type, 1.23's
// is 48 for every type. On edit the caller runs this only when the edit
// touches interval or timeout — a stored timeout of 0 is otherwise sent
// back untouched, and Kuma 1.23.17 runs it as interval × 800 seconds on
// HTTP checks.
function deriveMonitorTiming(
  monitor: Record<string, unknown>,
  defaultTimeout: number,
  capTimeout: boolean,
): void {
  if (typeof monitor.interval !== "number") return;
  monitor.retryInterval = monitor.retryInterval ?? monitor.interval;
  const timeout = typeof monitor.timeout === "number" ? monitor.timeout : defaultTimeout;
  monitor.timeout = capTimeout ? Math.min(timeout, Math.trunc(monitor.interval * 8) / 10) : timeout;
}

// The 2.x UI leaves a ping's timeout out of the 80% cap (EditMonitor.vue
// "monitor.timeout" watcher) and the 2.x server refuses a ping timeout below
// ping_per_request_timeout, so a capped ping timeout would fail to save.
const capsTimeout = (s: KumaSession, type: unknown): boolean =>
  !(s.majorVersion >= 2 && type === "ping");

// The merged monitor is validated once on its final values, right before it is
// sent. On add that is the whole monitor; on edit only the fields the edit
// sets, plus every required field when the edit changes the type — a stored
// value the edit does not touch (the UI may save timeout 0, a deleted docker
// host as docker_host null, proxyId 0 or port 0) is sent back unchanged.
// 2.5.11's Monitor.validate rounds a ping's timeout and refuses it outside
// 1..300 or below ping_per_request_timeout, which the DB defaults to 2 when
// the add leaves it unset. Checking the final values here turns that into an
// exit 2 before sending, and keeps the CLI from storing a ping that every
// later save would fail on.
function checkKuma2Ping(s: KumaSession, monitor: Record<string, unknown>): void {
  // 2.x's Monitor.validate runs on every save, and only on a truthy timeout:
  // a 0 stays stored untouched, so it is skipped here the same way.
  if (s.majorVersion < 2 || monitor.type !== "ping" || !monitor.timeout) return;
  const timeout = Math.round(Number(monitor.timeout));
  // Kuma's validate compares the value as JavaScript does (a numeric string
  // as a number); only a key the add leaves out gets the DB default 2.
  const raw = monitor.ping_per_request_timeout;
  const perRequest = raw === undefined ? 2 : Number(raw);
  if (timeout < 1 || timeout > 300 || timeout < perRequest) {
    fail(
      2,
      `a ping monitor's timeout must be between 1 and 300 seconds and at least ping_per_request_timeout (${perRequest}) on Uptime Kuma 2.x, got ${String(monitor.timeout)}`,
    );
  }
}

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
      fail(
        2,
        "pushToken must be a non-empty string; a monitor that has none needs one passed with --set pushToken=<token>",
      );
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

// monitor_tls_info.info_json is the JSON.stringify of checkCertificate's
// result: { valid, certInfo }, where certInfo.validTo is the leaf
// certificate's notAfter (a Date on the wire, ISO 8601) and daysRemaining
// the rounded days left. A missing or malformed payload gives nulls.
function certInfoFields(infoJson: string | undefined): {
  certExpiresAt: string | null;
  certDaysRemaining: number | null;
} {
  const none = { certExpiresAt: null, certDaysRemaining: null };
  if (infoJson === undefined) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(infoJson);
  } catch {
    return none;
  }
  const certInfo = (parsed as { certInfo?: unknown } | null)?.certInfo;
  if (certInfo === null || typeof certInfo !== "object") return none;
  const { validTo, daysRemaining } = certInfo as Record<string, unknown>;
  let certExpiresAt: string | null = null;
  if (typeof validTo === "string") {
    const date = new Date(validTo);
    if (!Number.isNaN(date.getTime())) certExpiresAt = date.toISOString();
  }
  return {
    certExpiresAt,
    certDaysRemaining:
      typeof daysRemaining === "number" && Number.isFinite(daysRemaining) ? daysRemaining : null,
  };
}

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
    .command("get <id|name>")
    .description("Show one monitor")
    .action(async (rawId) => {
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
      const m = s.monitorById(id);
      if (!m) fail(1, `monitor ${id} not found`);
      printJson({
        ...redactSecrets(m),
        notificationIDList: notificationIdArray(m.notificationIDList),
        tags: monitorTags(m).map(tagJson),
      });
    });

  monitors
    .command("stats [id|name]")
    .description("Uptime, ping and certificate stats of monitors")
    .action(async (rawId) => {
      const s = await connect();
      const id = rawId === undefined ? undefined : s.resolveMonitorId(rawId);
      const all = s.monitors();
      const targets = id === undefined ? all : all.filter((m) => m.id === id);
      if (id !== undefined && targets.length === 0) fail(1, `monitor ${id} not found`);
      const names = new Map(all.map((m) => [m.id, m.name] as [number, string]));
      const stats = await s.monitorStats(
        targets.map((m) => m.id),
        names,
      );
      const rows = targets.map((m) => {
        // monitorStats returns every requested id or fails itself
        const st = stats.get(m.id)!;
        const cert = certInfoFields(st.certInfo);
        return {
          id: m.id,
          name: m.name,
          uptime24h: st.uptime24h,
          uptime30d: st.uptime30d,
          avgPing: st.avgPing,
          certExpiresAt: cert.certExpiresAt,
          certDaysRemaining: cert.certDaysRemaining,
        };
      });
      printJson(id === undefined ? rows : rows[0]);
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
    .addOption(
      new Option("--json-path-operator <op>", "json query operator (json-query type)").choices([
        ...JSON_PATH_OPERATORS,
      ]),
    )
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
    .option("--notification-id <id|name>", "notification id or name (repeatable)", collect, [])
    .option("--notifications-from <monitorId|name>", "copy notifications from a monitor")
    .option("--parent <groupId|name>", "parent group monitor id or name")
    .option("--paused", "create the monitor paused")
    .option("--push-token <token>", "push token (push type)")
    .option("--tag <tagId[:value]>", "attach a tag (repeatable)", collect, [])
    .option("--set <key=value>", "set a monitor field (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file of monitor fields")
    .action(async (opts) => {
      const type = opts.type as string;
      // A type-specific flag on another type would be stored ignored.
      for (const { flag, opt, types } of TYPE_FLAGS) {
        const v = opts[opt] as unknown;
        const supplied = Array.isArray(v) ? v.length > 0 : v !== undefined;
        if (supplied && !types.includes(type)) {
          fail(2, `${flag} only applies to --type ${types.join(", ")}`);
        }
      }
      const urlTypes = (URL_TYPES as readonly string[]).includes(type);
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
      // A --parent name resolves only after connect; other values keep the
      // pre-connect shape check.
      const normalizedParent =
        parentInput === undefined || typeof parentInput === "string"
          ? parentInput
          : normalizeParent(parentInput);

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

      // A hatch key beats the flag in the merge below, so a flag value it
      // overrides is never parsed: `--interval 0 --set interval=30` sends 30.
      const interval =
        sets.interval !== undefined || fileConfig.interval !== undefined
          ? undefined
          : parseMonitorInterval(opts.interval ?? "60", "--interval");
      const retryInterval =
        opts.retryInterval === undefined ||
        sets.retryInterval !== undefined ||
        fileConfig.retryInterval !== undefined
          ? undefined
          : parsePositiveNumber(opts.retryInterval, "--retry-interval");
      const maxRetries = parseNonNegativeInteger(opts.maxRetries ?? "0", "--max-retries");
      const resendInterval = parseNonNegativeInteger(
        opts.resendInterval ?? "0",
        "--resend-interval",
      );
      const timeout =
        opts.timeout === undefined || sets.timeout !== undefined || fileConfig.timeout !== undefined
          ? undefined
          : parseTimeoutSeconds(opts.timeout, "--timeout");
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
          ? parsePacketSize(opts.packetSize, "--packet-size")
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
      // Notification ids and the --notifications-from monitor may be names;
      // both resolve against the pushed lists after connect.
      const notificationIdArgs = (opts.notificationId ?? []) as string[];
      const notificationsFromArg = opts.notificationsFrom as string | undefined;
      const tagSpecs = ((opts.tag ?? []) as string[]).map(parseMonitorTag);
      const seenTags = new Set<string>();
      for (const spec of tagSpecs) {
        const key = JSON.stringify([spec.tagId, spec.value]);
        if (seenTags.has(key)) fail(2, `duplicate --tag ${spec.tagId}:${spec.value}`);
        seenTags.add(key);
      }

      const s = await connect();
      const twoXFieldCandidates = [...Object.keys(sets), ...Object.keys(fileConfig)];
      // add ignores the flag on other types, so only json-query counts here
      if (opts.jsonPathOperator !== undefined && type === "json-query") {
        twoXFieldCandidates.push("jsonPathOperator");
      }
      checkKuma2xFields(s, twoXFieldCandidates);
      checkTailscalePing(s, type);
      checkMonitorTiming(
        s,
        timingFields(sets, fileConfig, {
          interval: interval === undefined ? undefined : { name: "--interval", value: interval },
          timeout: timeout === undefined ? undefined : { name: "--timeout", value: timeout },
          retryInterval:
            retryInterval === undefined
              ? undefined
              : { name: "--retry-interval", value: retryInterval },
        }),
      );
      const name = opts.name as string;
      const existing = s.monitors().find((m) => m.name === name);
      if (existing) {
        printJson({ id: existing.id, name: existing.name, skipped: true });
        fail(3, "");
      }
      // Name resolution waits for the skip check like the other post-connect
      // resolutions below: a same-name add exits 3 whatever --parent says.
      const parentId =
        normalizedParent === undefined ? undefined : resolveParent(s, normalizedParent);
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
      if (notificationsFromArg !== undefined) {
        const srcId = s.resolveMonitorId(notificationsFromArg);
        const src = s.monitorById(srcId);
        if (!src) fail(1, `monitor ${srcId} not found`);
        ids.push(...notificationIdArray(src.notificationIDList));
      }
      for (const raw of notificationIdArgs) {
        ids.push(s.resolveNotificationId(raw));
      }

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
        resendInterval,
        maxretries: maxRetries,
        notificationIDList: notificationIdObject(ids),
        proxyId,
        active,
      };
      if (interval !== undefined) typed.interval = interval;
      // retryInterval and timeout are only sent when explicit; their defaults
      // derive from the final interval after the merge below.
      if (retryInterval !== undefined) typed.retryInterval = retryInterval;
      if (timeout !== undefined) typed.timeout = timeout;
      if (parentId !== undefined) typed.parent = parentId;
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
        // 2.x's evaluateJsonQuery needs an operator and the column has no
        // default; the UI sends "==". 1.23 never receives the field — the
        // flag and the hatch keys were refused after connect().
        if (s.majorVersion >= 2) typed.jsonPathOperator = opts.jsonPathOperator ?? "==";
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
      // The UI's submit() sends httpBodyEncoding null outside http, keyword
      // and json-query; the MONITOR_DEFAULTS "json" only reaches those types.
      if (!(BODY_ENCODING_TYPES as readonly string[]).includes(type)) {
        typed.httpBodyEncoding = null;
      }

      let pushBase = s.url;
      if (pushToken !== undefined) {
        const primary = s.primaryBaseURL;
        if (primary !== undefined && primary !== "") {
          pushBase = primary.replace(/\/+$/, "");
        }
      }

      const monitor: Record<string, unknown> = {
        ...MONITOR_DEFAULTS,
        ...(s.majorVersion >= 2 ? MONITOR_2X_DEFAULTS : {}),
        ...typed,
        ...fileConfig,
        ...sets,
      };
      if (parentId !== undefined) monitor.parent = parentId;
      monitor.notificationIDList = notificationIdObject(monitor.notificationIDList);
      checkNotificationIds(s, monitor.notificationIDList);
      deriveMonitorTiming(monitor, defaultTimeoutSeconds(s, type), capsTimeout(s, type));
      validateFinalMonitor(s, monitor);
      checkKuma2Ping(s, monitor);
      if (type === "gamedig") await checkGameId(s, monitor);

      const res = await s.request("add", [monitor]);
      const out: Record<string, unknown> = {
        id: res?.monitorID ?? null,
        name,
        type,
        active: monitor.active !== false,
      };
      if (pushToken !== undefined) {
        out.pushToken = pushToken;
        // a password in primaryBaseURL (or the CLI url) prints as *** like settings get does;
        // only the base is parsed, so a token like ".." is not resolved away as a dot segment
        const shownBase = String(redactUrl(pushBase)).replace(/\/+$/, "");
        out.pushUrl = `${shownBase}/api/push/${encodeURIComponent(pushToken)}?status=up&msg=OK&ping=`;
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
    .command("edit <id|name>")
    .description("Edit a monitor")
    .option("--set <key=value>", "set a field (repeatable)", collect, [])
    .addOption(
      new Option("--json-path-operator <op>", "json query operator (json-query type)").choices([
        ...JSON_PATH_OPERATORS,
      ]),
    )
    .option("--parent <groupId|name>", "parent group monitor id or name ('none' clears it)")
    .option("--config-file <path>", "JSON file of monitor fields")
    .action(async (rawId, opts) => {
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
        parentOpt === undefined &&
        opts.jsonPathOperator === undefined
      ) {
        fail(
          2,
          "monitors edit requires at least one --set key=value, --config-file, --parent or --json-path-operator",
        );
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
      // A --parent name or a monitor named by <id> resolves only after
      // connect; other parent values keep the pre-connect shape check.
      const normalizedParent =
        parentInput === undefined || typeof parentInput === "string"
          ? parentInput
          : normalizeParent(parentInput);
      if (sets.notificationIDList !== undefined) {
        checkNotificationIdList(sets.notificationIDList);
      }
      if (fileConfig.notificationIDList !== undefined) {
        checkNotificationIdList(fileConfig.notificationIDList);
      }
      // Two literal ids need no pushed list, so the self-parent check still
      // runs before connecting; a name on either side resolves after it.
      if (
        isIdLiteral(rawId) &&
        typeof normalizedParent === "number" &&
        normalizedParent === Number(rawId)
      ) {
        fail(2, "parent cannot be the monitor itself");
      }
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
      const parentId =
        normalizedParent === undefined ? undefined : resolveParent(s, normalizedParent);
      // Kuma 1.23 only rejects descendants as parent, not the monitor itself, and a self-parent
      // makes its parent walk loop forever
      if (parentId === id) fail(2, "parent cannot be the monitor itself");
      const twoXFieldCandidates = [...Object.keys(sets), ...Object.keys(fileConfig)];
      if (opts.jsonPathOperator !== undefined) twoXFieldCandidates.push("jsonPathOperator");
      checkKuma2xFields(s, twoXFieldCandidates);
      checkMonitorTiming(s, timingFields(sets, fileConfig, {}));
      const fetched = await fetchMonitor(s, id);
      const monitor: Record<string, unknown> = { ...fetched };
      for (const [k, v] of Object.entries(fileConfig)) monitor[k] = v;
      for (const [k, v] of Object.entries(sets)) monitor[k] = v;
      const typeChanged = monitor.type !== fetched.type;
      if (opts.jsonPathOperator !== undefined && monitor.type !== "json-query") {
        fail(2, "--json-path-operator only applies to --type json-query");
      }
      if (monitor.type === "json-query" && s.majorVersion >= 2) {
        // Like add's typed flags, the flag sits below --config-file and --set;
        // a monitor turned into json-query needs an operator like a new one.
        if (
          opts.jsonPathOperator !== undefined &&
          !("jsonPathOperator" in fileConfig) &&
          !("jsonPathOperator" in sets)
        ) {
          monitor.jsonPathOperator = opts.jsonPathOperator;
        }
        monitor.jsonPathOperator ??= "==";
      }
      if (parentId !== undefined) monitor.parent = parentId;
      // Kuma iterates notificationIDList with for...in, so an array would be
      // stored under its indexes; always send the object shape.
      monitor.notificationIDList = notificationIdObject(monitor.notificationIDList);
      const touched = new Set([...Object.keys(fileConfig), ...Object.keys(sets)]);
      if (parentOpt !== undefined) touched.add("parent");
      // Stored ids a deleted notification left behind are Kuma-side state, so
      // the check only covers a list this edit supplies.
      if (touched.has("notificationIDList")) {
        checkNotificationIds(s, monitor.notificationIDList);
      }
      const timingTouched =
        sets.interval !== undefined ||
        fileConfig.interval !== undefined ||
        sets.timeout !== undefined ||
        fileConfig.timeout !== undefined;
      const type = typeof monitor.type === "string" ? monitor.type : "";
      // A type change that keeps a nonpositive stored timeout would send it
      // back to a check that reads 0 as interval × 800 seconds on 1.23, so it
      // is normalized like an unset one.
      const timeoutUnset =
        typeChanged && !(typeof monitor.timeout === "number" && monitor.timeout > 0);
      if (timeoutUnset) {
        monitor.timeout = defaultTimeoutSeconds(s, type);
      }
      // The UI's interval watcher moves retryInterval only while the two
      // stored values were equal; a retryInterval the edit sets wins.
      if (
        monitor.interval !== fetched.interval &&
        sets.retryInterval === undefined &&
        fileConfig.retryInterval === undefined &&
        fetched.retryInterval === fetched.interval
      ) {
        monitor.retryInterval = monitor.interval;
      }
      if (timingTouched || timeoutUnset) {
        deriveMonitorTiming(monitor, defaultTimeoutSeconds(s, type), capsTimeout(s, type));
      }
      validateFinalMonitor(s, monitor, { touched, typeChanged });
      checkKuma2Ping(s, monitor);
      if (typeChanged) checkTailscalePing(s, monitor.type);
      if (monitor.type === "gamedig" && (typeChanged || touched.has("game"))) {
        await checkGameId(s, monitor);
      }
      await s.request("editMonitor", [monitor]);
      // editMonitor ignores fields like `active`, so print what Kuma saved.
      // The save already happened, so a failed re-read degrades to the sent
      // object plus a warning on stderr rather than a nonzero exit; exit 70
      // is an unexpected response shape, not a failed read, and stays loud —
      // same contract as `settings set`.
      try {
        const saved = await fetchMonitor(s, id);
        printJson({
          ...redactSecrets(saved),
          notificationIDList: notificationIdArray(saved.notificationIDList),
          tags: monitorTags(saved).map(tagJson),
        });
      } catch (e) {
        if (!(e instanceof CliError) || e.exitCode === 70) throw e;
        printJson({
          ...redactSecrets(monitor),
          notificationIDList: notificationIdArray(monitor.notificationIDList),
          tags: monitorTags(monitor).map(tagJson),
        });
        console.error(`warning: monitor ${id} was saved, but reading it back failed: ${e.message}`);
      }
    });

  for (const [name, event, active] of [
    ["pause", "pauseMonitor", false],
    ["resume", "resumeMonitor", true],
  ] as const) {
    monitors
      .command(`${name} <id|name>`)
      .description(`${name} a monitor`)
      .action(async (rawId) => {
        const s = await connect();
        const id = s.resolveMonitorId(rawId);
        await s.request(event, [id]);
        printJson({ id, active });
      });
  }

  monitors
    .command("delete <id|name>")
    .description("Delete a monitor")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      if (!opts.yes) fail(2, `would delete monitor ${rawId}; pass --yes to delete`);
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
      // Kuma 1.23 answers ok even for an unknown id, so the pushed list is the only check
      if (!s.monitorById(id)) fail(1, `monitor ${id} not found`);
      await s.request("deleteMonitor", [id]);
      printJson({ id, deleted: true });
    });

  for (const [name, event, what] of [
    ["clear-beats", "clearHeartbeats", "beats"],
    ["clear-events", "clearEvents", "events"],
  ] as const) {
    monitors
      .command(`${name} <id|name>`)
      .description(`Clear a monitor's ${what}`)
      .option("--yes", "confirm clearing")
      .action(async (rawId, opts) => {
        if (!opts.yes) fail(2, `would clear ${what} of monitor ${rawId}; pass --yes to clear`);
        const s = await connect();
        const id = s.resolveMonitorId(rawId);
        // Kuma 1.23 answers ok even for an unknown id, so the pushed list is the only check
        if (!s.monitorById(id)) fail(1, `monitor ${id} not found`);
        await s.request(event, [id]);
        printJson({ id, cleared: what });
      });
  }

  monitors
    .command("tag <id|name>")
    .description("Attach a tag to a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .option("--value <value>", "tag value")
    .action(async (rawId, opts) => {
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value ?? "";
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
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
    .command("untag <id|name>")
    .description("Detach a tag from a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .option("--value <value>", "tag value")
    .action(async (rawId, opts) => {
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value ?? "";
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
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
    .command("retag <id|name>")
    .description("Change the value of a tag on a monitor")
    .requiredOption("--tag <tagId>", "tag id")
    .requiredOption("--value <value>", "new tag value")
    .action(async (rawId, opts) => {
      const tagId = parseId(opts.tag, "--tag");
      const value = opts.value as string;
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
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
