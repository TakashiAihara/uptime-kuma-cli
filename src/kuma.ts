import { io, type Socket } from "socket.io-client";

import {
  CliError,
  fail,
  isIdLiteral,
  redactUrl,
  resolveCredentials,
  resolveTotp,
  sleep,
  socketTimeoutMs,
} from "./lib.ts";

export interface Monitor extends Record<string, unknown> {
  id: number;
  name: string;
}

// Fields the Kuma 1.23.17 `add` event accepts: monitorDefaults of
// src/pages/EditMonitor.vue plus the fields the form edits, in the wire
// spelling. `add` runs bean.import + store on a redbean frozen bean, so any
// other key fails the store. tests/helpers/fake-kuma.ts keeps its own literal
// copy of the same columns so it keeps checking this list.
export const MONITOR_ADD_FIELDS = new Set([
  "type",
  "name",
  "parent",
  "url",
  "method",
  "interval",
  "retryInterval",
  "resendInterval",
  "maxretries",
  "timeout",
  "notificationIDList",
  "ignoreTls",
  "upsideDown",
  "packetSize",
  "expiryNotification",
  "maxredirects",
  "accepted_statuscodes",
  "dns_resolve_type",
  "dns_resolve_server",
  "docker_container",
  "docker_host",
  "proxyId",
  "mqttUsername",
  "mqttPassword",
  "mqttTopic",
  "mqttSuccessMessage",
  "authMethod",
  "oauth_auth_method",
  "httpBodyEncoding",
  "kafkaProducerBrokers",
  "kafkaProducerSaslOptions",
  "kafkaProducerSsl",
  "kafkaProducerAllowAutoTopicCreation",
  "gamedigGivenPortOnly",
  "active",
  "keyword",
  "invertKeyword",
  "jsonPath",
  "expectedValue",
  "hostname",
  "port",
  "pushToken",
  "description",
  "game",
  "grpcUrl",
  "grpcProtobuf",
  "grpcMethod",
  "grpcServiceName",
  "grpcEnableTls",
  "grpcBody",
  "grpcMetadata",
  "radiusUsername",
  "radiusPassword",
  "radiusCalledStationId",
  "radiusCallingStationId",
  "radiusSecret",
  "databaseConnectionString",
  "databaseQuery",
  "kafkaProducerTopic",
  "kafkaProducerMessage",
  "body",
  "headers",
  "tlsCa",
  "tlsCert",
  "tlsKey",
  "oauth_token_url",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_scopes",
  "basic_auth_user",
  "basic_auth_pass",
  "authDomain",
  "authWorkstation",
]);

// The monitor fields a 2.x `add` persists or 2.5.11's editMonitor reads
// (2.5.11/server/server.js add + editMonitor) that MONITOR_ADD_FIELDS
// lacks. 1.23's `add` stores the object as-is and fails on an unknown
// column, and its editMonitor copies a fixed list and silently drops the
// rest, so the CLI accepts these only after connect() on a >= 2 server.
// snmpV3Username is add-only: editMonitor never reads it on any version —
// checkEditFields refuses it outright.
export const MONITOR_2X_FIELDS = new Set([
  "bearer_token",
  "cacheBust",
  "conditions",
  "domainExpiryNotification",
  "gamedigToken",
  "ipFamily",
  "jsonPathOperator",
  "location",
  "manual_status",
  "mqttCheckType",
  "mqttWebsocketPath",
  "ntpRootDispersionThreshold",
  "ntpStratumThreshold",
  "ntpTimeOffsetThreshold",
  "oauth_audience",
  "ping_count",
  "ping_numeric",
  "ping_per_request_timeout",
  "protocol",
  "rabbitmqNodes",
  "rabbitmqPassword",
  "rabbitmqUsername",
  "remote_browser",
  "responseMaxLength",
  "retryOnlyOnStatusCodeFailure",
  "saveErrorResponse",
  "saveResponse",
  "screenshot_delay",
  "sftpPath",
  "smtpSecurity",
  "snmpOid",
  "snmpV3Username",
  "snmpVersion",
  "sshAuthMethod",
  "sshPassphrase",
  "sshPassword",
  "sshPrivateKey",
  "sshUsername",
  "subtype",
  "system_service_name",
  "wsIgnoreSecWebsocketAcceptHeader",
  "wsSubprotocol",
]);

export interface NotificationRow extends Record<string, unknown> {
  id: number;
  name: string;
  active: boolean;
  isDefault: boolean;
  config: string;
}

export interface ProxyRow extends Record<string, unknown> {
  id: number;
}

export interface DockerHostRow extends Record<string, unknown> {
  id: number;
}

export interface TagRow extends Record<string, unknown> {
  id: number;
  name: string;
  color: string;
}

// The statusPageList push carries StatusPage.toJSON(): id, slug, title and
// the page config; the CLI only needs id and title.
export type StatusPageRow = Record<string, unknown> & { id: number; title: string };

// The maintenanceList push and getMaintenance carry Maintenance.toJSON(): the
// public shape (dateRange, timeRange, status, ...), not bean columns.
export type MaintenanceRow = Record<string, unknown> & { id: number };

// The apiKeyList push carries APIKey.toPublicJSON(): id, name, userID,
// createdDate, active (the BOOLEAN column's 0/1), expires and the computed
// status — the stored secret `key` is never sent.
export type ApiKeyRow = Record<string, unknown> & { id: number };

// The resolved stats of one monitor as `monitors stats` reports them: the
// uptime values are Kuma's 0..1 ratios over its 24h and 30d windows,
// avgPing is null when the monitor has no beats with a ping in 24h, and
// certInfo is the raw monitor_tls_info info_json (undefined when the
// monitor has no such row). uptime1y and domainInfo are 2.x-only pushes —
// left absent when the server never sent them (1.x sends neither; 2.x sends
// uptime "1y" since 2.0.0 and domainInfo since 2.1.0 only when the monitor's
// domain has a resolved expiry).
export type MonitorStats = {
  avgPing: number | null;
  uptime24h: number;
  uptime30d: number;
  certInfo: string | undefined;
  uptime1y?: number;
  domainInfo?: { daysRemaining: number | null; expiryDate: string };
};

type BeatRow = Record<string, unknown>;

// First-value-wins record of the stats pushes, kept event by event; sendStats
// re-emits them on every heartbeat. uptime1y (the string period "1y") and
// domainInfo exist on 2.x only.
type MonitorStatEvents = {
  avgPing?: { value: number | null };
  uptime: Map<number, { at: number; value: number }>;
  certInfo?: { at: number; json: string };
  uptime1y?: { at: number; value: number };
  domainInfo?: { at: number; daysRemaining: number | null; expiryDate: string };
};

// Grace after the pushed lists for the versioned `info` (connect() below).
const INFO_GRACE_MS = 500;

// 2.x answers login failures with i18n keys (msgi18n: true) where 1.x sent
// English; the known keys map back to the 1.x texts so the printed failure
// reads the same on both versions.
const LOGIN_MSG_I18N: Record<string, string> = {
  authIncorrectCreds: "Incorrect username or password.",
  authInvalidToken: "Invalid Token!",
};

let currentSocket: Socket | undefined;

// The socket would otherwise keep the process alive after the command finished.
export function disconnect(): void {
  currentSocket?.disconnect();
  currentSocket = undefined;
}

function emitAck(
  socket: Socket,
  event: string,
  args: any[],
  timeoutMs: number,
  disconnected: Promise<never>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CliError(2, `timed out during ${event}`));
    }, timeoutMs);
    void disconnected.catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.emit(event, ...args, (res: any) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export class KumaSession {
  constructor(
    private readonly socket: Socket,
    readonly url: string,
    private readonly timeoutMs: number,
    readonly monitorList: Record<string, Monitor>,
    readonly maintenanceList: Record<string, MaintenanceRow> | undefined,
    readonly notificationList: NotificationRow[],
    readonly proxyList: ProxyRow[],
    readonly dockerHostList: DockerHostRow[],
    readonly apiKeyList: ApiKeyRow[] | undefined,
    readonly statusPageList: Record<string, StatusPageRow> | undefined,
    readonly heartbeats: Map<number, BeatRow[]>,
    private readonly statsEvents: Map<number, MonitorStatEvents>,
    readonly serverVersion: string | undefined,
    // 2.x's post-login info carries dbType (the backend name, e.g. "sqlite");
    // 1.23's info has no such field, so it stays undefined there.
    readonly dbType: string | undefined,
    // The post-login info reports whether Kuma runs in its container image;
    // the type picker hides tailscale-ping there because the image ships no
    // tailscale binary. Undefined when the info never carried the field.
    readonly isContainer: boolean | undefined,
    // info carries the Primary Base URL setting on both Kuma versions, so
    // `monitors add --type push` builds pushUrl from it without a getSettings
    // round trip; undefined when the server never sent a string one.
    readonly primaryBaseURL: string | undefined,
    // setSettings takes the login password again as currentPassword when the
    // request would disable auth; it is the same secret resolveCredentials
    // already produced for the login, kept here so no command re-resolves it.
    readonly loginPassword: string,
    private readonly disconnected: Promise<never>,
  ) {}

  get majorVersion(): number {
    return parseMajorVersion(this.serverVersion);
  }

  get minorVersion(): number {
    return parseMinorVersion(this.serverVersion);
  }

  get patchVersion(): number {
    return parsePatchVersion(this.serverVersion);
  }

  // ok:false is Kuma answering no (exit 1); a missing callback is a timeout (exit 2).
  // timeoutMs overrides the session default for requests like shrinkDatabase
  // whose server-side work can outlast it.
  async request(event: string, args: any[] = [], timeoutMs = this.timeoutMs): Promise<any> {
    const res = await emitAck(this.socket, event, args, timeoutMs, this.disconnected);
    if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
      fail(1, String((res as { msg?: unknown }).msg ?? `${event} failed`));
    }
    return res;
  }

  monitors(): Monitor[] {
    return Object.values(this.monitorList).sort((a, b) => a.id - b.id);
  }

  monitorById(id: number): Monitor | undefined {
    return this.monitors().find((m) => m.id === id);
  }

  // A command-line reference is an id when it is a positive integer — a
  // resource may be named "123" but the number always wins — and an exact
  // name match against the pushed list otherwise. A missing or ambiguous
  // name is a usage error (exit 2); an unknown numeric id stays exit 1.
  resolveMonitorId(raw: string): number {
    if (isIdLiteral(raw)) return Number(raw);
    return namedRowId(this.monitors(), raw, "monitor");
  }

  maintenances(): MaintenanceRow[] {
    const list = this.maintenanceList;
    if (list === undefined) fail(70, "maintenanceList was not awaited");
    return Object.values(list).sort((a, b) => a.id - b.id);
  }

  maintenanceById(id: number): MaintenanceRow | undefined {
    return this.maintenances().find((m) => m.id === id);
  }

  notifications(): NotificationRow[] {
    return [...this.notificationList].sort((a, b) => a.id - b.id);
  }

  notificationById(id: number): NotificationRow | undefined {
    return this.notifications().find((n) => n.id === id);
  }

  resolveNotificationId(raw: string): number {
    if (isIdLiteral(raw)) return Number(raw);
    return namedRowId(this.notifications(), raw, "notification");
  }

  proxies(): ProxyRow[] {
    return [...this.proxyList].sort((a, b) => a.id - b.id);
  }

  proxyById(id: number): ProxyRow | undefined {
    return this.proxies().find((p) => p.id === id);
  }

  dockerHosts(): DockerHostRow[] {
    return [...this.dockerHostList].sort((a, b) => a.id - b.id);
  }

  dockerHostById(id: number): DockerHostRow | undefined {
    return this.dockerHosts().find((h) => h.id === id);
  }

  apiKeys(): ApiKeyRow[] {
    const list = this.apiKeyList;
    if (list === undefined) fail(70, "apiKeyList was not awaited");
    return [...list].sort((a, b) => a.id - b.id);
  }

  apiKeyById(id: number): ApiKeyRow | undefined {
    return this.apiKeys().find((k) => k.id === id);
  }

  statusPages(): StatusPageRow[] {
    const list = this.statusPageList;
    if (list === undefined) fail(70, "statusPageList was not awaited");
    return Object.values(list).sort((a, b) => a.id - b.id);
  }

  statusPageById(id: number): StatusPageRow | undefined {
    return this.statusPages().find((p) => p.id === id);
  }

  // getTags is a request event: Kuma 1.23 does not push a tag list after login.
  async tags(): Promise<TagRow[]> {
    const res = await this.request("getTags");
    const tags = res?.tags;
    if (!Array.isArray(tags)) fail(70, "unexpected getTags response");
    return tags as TagRow[];
  }

  heartbeat(id: number): BeatRow[] | undefined {
    return this.heartbeats.get(id);
  }

  async waitHeartbeats(ids: number[], names: ReadonlyMap<number, string>): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const missing = ids.filter((id) => !this.heartbeats.has(id));
      if (missing.length === 0) return;
      if (Date.now() >= deadline) {
        const what = missing.map((id) => `${id} (${names.get(id) ?? "unknown"})`).join(", ");
        fail(2, `timed out waiting for heartbeatList of monitor(s) ${what}`);
      }
      await Promise.race([sleep(10), this.disconnected]);
    }
  }

  // The stats pushes of Kuma 1.23.17: sendStats emits, per monitor, avgPing,
  // uptime 24h, uptime 30d and — only when a monitor_tls_info row exists —
  // certInfo right after the uptime 30d. 2.x adds uptime "1y" between the 30d
  // and the certInfo, and domainInfo after the certInfo (2.1.0+, only when
  // the monitor's domain has a resolved expiry). Besides the post-login walk
  // it runs on every heartbeat of any monitor, outside that walk, so another
  // monitor's pushes can interleave; each monitor's certInfo wait therefore
  // ends 500 ms after its own uptime 30d (a certInfo that has arrived is used
  // either way) and never makes the command fail. The listeners in connect()
  // keep the first value of each kind, event by event.
  async monitorStats(
    ids: number[],
    names: ReadonlyMap<number, string>,
  ): Promise<Map<number, MonitorStats>> {
    const deadline = Date.now() + this.timeoutMs;

    const complete = (id: number): boolean => {
      const rec = this.statsEvents.get(id);
      return rec?.avgPing !== undefined && rec.uptime.has(24) && rec.uptime.has(720);
    };

    // a monitor's own bound: a stats value counts only when it came within
    // 500 ms of that monitor's uptime 30d, whatever else the command still
    // waits for. certInfo, uptime "1y" and domainInfo ride the same burst on
    // 2.x — "1y" and domainInfo only bound the wait through the certInfo
    // grace (they land between/after the same emits), so a server that never
    // sends them does not make the command wait
    const inBurst = (uptime30d: { at: number } | undefined, at: number): boolean =>
      uptime30d !== undefined && at <= uptime30d.at + 500;
    const certInTime = (id: number): string | undefined => {
      const rec = this.statsEvents.get(id);
      const cert = rec?.certInfo;
      return cert !== undefined && inBurst(rec?.uptime.get(720), cert.at) ? cert.json : undefined;
    };
    // On 2.1+ the certInfo→domainInfo gap is two awaited reads — a few ms —
    // so a landed certInfo still holds the wait this tail grace for the
    // trailing emit, but no longer: a monitor without a resolvable domain
    // expiry never emits domainInfo and must not pay the whole bound for an
    // event that cannot come
    const DOMAIN_TAIL_MS = 200;
    const certDone = (id: number): boolean => {
      const rec = this.statsEvents.get(id);
      const uptime30d = rec?.uptime.get(720);
      if (uptime30d === undefined) return false;
      if (Date.now() >= uptime30d.at + 500) return true;
      // sendStats ends with sendDomainInfo, so on 2.1+ the wait ends on the
      // burst's last event — a landed domainInfo — or the certInfo's tail
      // grace, not on the certInfo itself. Before 2.1 certInfo is the last
      // emit and breaks early.
      if (meetsMinVersion(this, [2, 1, 0])) {
        const dom = rec?.domainInfo;
        if (dom !== undefined) return inBurst(uptime30d, dom.at);
        const cert = rec?.certInfo;
        return (
          cert !== undefined &&
          inBurst(uptime30d, cert.at) &&
          Date.now() >= cert.at + DOMAIN_TAIL_MS
        );
      }
      return certInTime(id) !== undefined;
    };

    for (;;) {
      const missing = ids.filter((id) => !complete(id));
      if (missing.length === 0 && ids.every(certDone)) break;
      if (Date.now() >= deadline) {
        if (missing.length > 0) {
          const what = missing.map((id) => `${id} (${names.get(id) ?? "unknown"})`).join(", ");
          fail(2, `timed out waiting for stats of monitor(s) ${what}`);
        }
        // only a certInfo grace is still running at the deadline: no cert
        break;
      }
      await Promise.race([sleep(10), this.disconnected]);
    }

    const out = new Map<number, MonitorStats>();
    for (const id of ids) {
      const rec = this.statsEvents.get(id);
      const avgPing = rec?.avgPing;
      const uptime24h = rec?.uptime.get(24);
      const uptime30d = rec?.uptime.get(720);
      if (avgPing === undefined || uptime24h === undefined || uptime30d === undefined) {
        fail(70, `stats of monitor ${id} missing after the wait`);
      }
      const st: MonitorStats = {
        avgPing: avgPing.value,
        uptime24h: uptime24h.value,
        uptime30d: uptime30d.value,
        certInfo: certInTime(id),
      };
      const u1y = rec?.uptime1y;
      if (u1y !== undefined && inBurst(rec?.uptime.get(720), u1y.at)) st.uptime1y = u1y.value;
      const dom = rec?.domainInfo;
      if (dom !== undefined && inBurst(rec?.uptime.get(720), dom.at)) {
        st.domainInfo = { daysRemaining: dom.daysRemaining, expiryDate: dom.expiryDate };
      }
      out.set(id, st);
    }
    return out;
  }
}

// Exact name match against a pushed list; the candidates of an ambiguous
// name are its ids since the names are identical.
function namedRowId(rows: { id: number; name: string }[], raw: string, noun: string): number {
  const matches = rows.filter((row) => row.name === raw);
  if (matches.length === 0) fail(2, `no ${noun} named "${raw}"`);
  if (matches.length > 1) {
    fail(2, `${noun} name "${raw}" is ambiguous: ids ${matches.map((m) => m.id).join(", ")}`);
  }
  return matches[0]!.id;
}

// info.version is package.json's semver on both Kuma versions; a missing or
// unparsable value keeps major 1 so 1.23 stays the default target. Nightly
// builds already report 3.x, so callers branch on `>= 2`, not `=== 2`.
export function parseMajorVersion(version: string | undefined): number {
  const match = version === undefined ? null : /^(\d+)\.\d+\.\d+/.exec(version);
  return match === null ? 1 : Number(match[1]);
}

// Same shape as the major: the minor only reaches a comparison after a major
// >= the gate's minimum, which means the version parsed — an unparseable or
// missing value can fall back to 0 because the major check refuses first.
export function parseMinorVersion(version: string | undefined): number {
  const match = version === undefined ? null : /^\d+\.(\d+)\.\d+/.exec(version);
  return match === null ? 0 : Number(match[1]);
}

// Same shape as the minor: the patch only reaches a comparison after the
// major.minor already matched the gate's minimum, which means the version
// parsed — an unparseable or missing value can fall back to 0 because the
// earlier checks refuse first.
export function parsePatchVersion(version: string | undefined): number {
  const match = version === undefined ? null : /^\d+\.\d+\.(\d+)/.exec(version);
  return match === null ? 0 : Number(match[1]);
}

// The first release a 2.x-only capability appears in as [major, minor,
// patch] — a capability can postdate 2.0.0 (incident events, deleteChildren
// and domainInfo first ship in 2.1.0, oracledb in 2.3.0, ntp in 2.5.0), so
// the minor matters and, since a capability can first ship in a patch
// release (2.5.4), so does the patch.
export type MinVersion = readonly [number, number, number];

export function meetsMinVersion(s: KumaSession, [maj, min, pat]: MinVersion): boolean {
  return (
    s.majorVersion > maj ||
    (s.majorVersion === maj &&
      (s.minorVersion > min || (s.minorVersion === min && s.patchVersion >= pat)))
  );
}

export function refuseKumaVersion(
  s: KumaSession,
  what: string,
  [maj, min, pat]: MinVersion,
): never {
  const needs =
    maj === 2 && min === 0 && pat === 0 ? "Uptime Kuma 2.x" : `Uptime Kuma >= ${maj}.${min}.${pat}`;
  return fail(
    2,
    s.serverVersion === undefined
      ? `${what} needs ${needs}; the server sent no version, so 1.x was assumed`
      : `${what} needs ${needs}; the server reports ${s.serverVersion}`,
  );
}

// monitorList, notificationList, proxyList and dockerHostList are pushed in
// the same tick right after login, so every command waits for them. Commands
// name the further pushed lists they read through extraLists:
// maintenanceList for the maintenance commands, statusPageList for
// `maintenance status-pages`, every `status-pages` command and `settings set`
// when its `entryPage` override names a status page — on 1.x statusPageList
// arrives ~500ms later (afterLogin sleeps first; on 2.x it is pushed before
// the login ack with the rest), so waiting for it unconditionally would add
// that latency to every command — and apiKeyList for the api-keys commands
// that check or print it.
export async function connect(
  extraLists: readonly ("maintenanceList" | "statusPageList" | "apiKeyList")[] = [],
): Promise<KumaSession> {
  const timeoutMs = socketTimeoutMs();
  const { url, username, password } = await resolveCredentials();
  const shownUrl = String(redactUrl(url));
  const socket = io(url, {
    transports: ["websocket"],
    reconnection: false,
    timeout: timeoutMs,
  });
  currentSocket = socket;

  // Every wait below races this promise so a dropped socket fails fast instead
  // of sitting out the whole timeout. The extra catch keeps the rejection
  // handled during the phases where nothing is racing it yet.
  let rejectDisconnected: (err: CliError) => void = () => {};
  const disconnected = new Promise<never>((_, reject) => {
    rejectDisconnected = reject;
  });
  void disconnected.catch(() => {});
  socket.on("disconnect", () => {
    rejectDisconnected(new CliError(2, `socket disconnected from ${shownUrl}`));
  });

  const pushed: {
    monitorList?: Record<string, Monitor>;
    maintenanceList?: Record<string, MaintenanceRow>;
    notificationList?: NotificationRow[];
    proxyList?: ProxyRow[];
    dockerHostList?: DockerHostRow[];
    apiKeyList?: ApiKeyRow[];
    statusPageList?: Record<string, StatusPageRow>;
  } = {};
  const heartbeats = new Map<number, BeatRow[]>();
  const statsEvents = new Map<number, MonitorStatEvents>();
  // afterLogin's `for (let monitorID in monitorList)` hands sendStats string
  // keys while the heartbeat and REST paths pass numbers; both normalize to
  // the monitor id (the heartbeatList listener does the same Number(id)).
  const statId = (id: unknown): number => {
    if (typeof id !== "number" && typeof id !== "string") return NaN;
    const n = Number(id);
    return Number.isFinite(n) ? n : NaN;
  };
  const statRecord = (id: number): MonitorStatEvents => {
    let rec = statsEvents.get(id);
    if (rec === undefined) {
      rec = { uptime: new Map() };
      statsEvents.set(id, rec);
    }
    return rec;
  };
  // 2.x sends the versioned `info` before the login answer and 1.23 between
  // the pushed lists, so the listener goes in before login is emitted.
  let serverVersion: string | undefined;
  let serverDbType: string | undefined;
  let primaryBaseURL: string | undefined;
  let isContainer: boolean | undefined;
  let infoSeen = false;
  socket.on("info", (data: unknown) => {
    infoSeen = true;
    const info = data as
      | {
          version?: unknown;
          dbType?: unknown;
          primaryBaseURL?: unknown;
          isContainer?: unknown;
        }
      | null
      | undefined;
    if (typeof info?.version === "string") serverVersion = info.version;
    if (typeof info?.dbType === "string") serverDbType = info.dbType;
    if (typeof info?.primaryBaseURL === "string") primaryBaseURL = info.primaryBaseURL;
    if (typeof info?.isContainer === "boolean") isContainer = info.isContainer;
  });
  // 1.23 pushes these right after the login callback and 2.x before it, so the
  // listeners must be in place before login is emitted.
  socket.on("monitorList", (data: Record<string, Monitor>) => {
    pushed.monitorList = data;
  });
  socket.on("maintenanceList", (data: Record<string, MaintenanceRow>) => {
    pushed.maintenanceList = data;
  });
  socket.on("notificationList", (data: NotificationRow[]) => {
    pushed.notificationList = data;
  });
  socket.on("proxyList", (data: ProxyRow[]) => {
    pushed.proxyList = data;
  });
  socket.on("dockerHostList", (data: DockerHostRow[]) => {
    pushed.dockerHostList = data;
  });
  socket.on("apiKeyList", (data: ApiKeyRow[]) => {
    pushed.apiKeyList = data;
  });
  socket.on("statusPageList", (data: Record<string, StatusPageRow>) => {
    pushed.statusPageList = data;
  });
  socket.on("heartbeatList", (id: unknown, beats: unknown) => {
    heartbeats.set(Number(id), Array.isArray(beats) ? (beats as BeatRow[]) : []);
  });
  // The stats pushes arrive after the lists, once after login and again on
  // every heartbeat; only `monitors stats` waits for them. The first value
  // of each kind wins; arrival times bound each monitor's 500 ms certInfo
  // grace.
  socket.on("avgPing", (id: unknown, value: unknown) => {
    const mid = statId(id);
    if (Number.isNaN(mid)) return;
    const rec = statRecord(mid);
    if (rec.avgPing === undefined) {
      rec.avgPing = {
        // parseInt(AVG(ping)) is NaN without beats; JSON carries NaN as null
        value: typeof value === "number" && Number.isFinite(value) ? value : null,
      };
    }
  });
  socket.on("uptime", (id: unknown, period: unknown, value: unknown) => {
    const mid = statId(id);
    if (Number.isNaN(mid) || typeof value !== "number" || !Number.isFinite(value)) return;
    const rec = statRecord(mid);
    // 2.x emits a third period, the string "1y", after 24 and 720
    if (period === "1y") {
      if (rec.uptime1y === undefined) rec.uptime1y = { at: Date.now(), value };
      return;
    }
    if (typeof period !== "number" || !Number.isFinite(period)) return;
    if (!rec.uptime.has(period)) {
      rec.uptime.set(period, { at: Date.now(), value });
    }
  });
  socket.on("certInfo", (id: unknown, data: unknown) => {
    const mid = statId(id);
    if (Number.isNaN(mid) || typeof data !== "string") return;
    const rec = statRecord(mid);
    if (rec.certInfo === undefined) {
      rec.certInfo = { at: Date.now(), json: data };
    }
  });
  // 2.1.0+ sendDomainInfo emits (id, daysRemaining, expiryDate) right after
  // certInfo, only for monitors whose domain resolved an expiry through RDAP.
  // A malformed field records null like a malformed certInfo does — the event
  // arriving and being unreadable differs from it never coming, so it is not
  // dropped whole
  socket.on("domainInfo", (id: unknown, daysRemaining: unknown, expiryDate: unknown) => {
    const mid = statId(id);
    if (Number.isNaN(mid)) {
      return;
    }
    const rec = statRecord(mid);
    if (rec.domainInfo === undefined) {
      rec.domainInfo = {
        at: Date.now(),
        daysRemaining:
          typeof daysRemaining === "number" && Number.isFinite(daysRemaining)
            ? daysRemaining
            : null,
        expiryDate: typeof expiryDate === "string" ? expiryDate : "",
      };
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CliError(2, `timed out connecting to ${shownUrl}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err: Error) => {
      clearTimeout(timer);
      reject(new CliError(2, `failed to connect to ${shownUrl}: ${err.message}`));
    });
  });

  // 2.5.11 registers its login listener only after awaiting the pre-login
  // sendInfo (server.js connection handler); a login emitted before that is
  // dropped by socket.io and never answered. Both versions send that info on
  // connect, so it marks the moment login can be sent.
  const preLoginDeadline = Date.now() + timeoutMs;
  while (!infoSeen) {
    if (Date.now() >= preLoginDeadline) {
      fail(2, `timed out waiting for the server info from ${shownUrl}`);
    }
    await Promise.race([sleep(10), disconnected]);
  }

  let login = await emitAck(
    socket,
    "login",
    [{ username, password, token: "" }],
    timeoutMs,
    disconnected,
  );
  if (login?.tokenRequired === true) {
    // Kuma answers tokenRequired (not ok:false) when the account has
    // 2FA and the login carried no token, and only then is a TOTP resolved —
    // a totp_* command never runs for accounts without 2FA. The retry reuses
    // the credentials resolved for the tokenless attempt, so a *_command
    // cannot return a different secret than the first attempt used.
    const totp = await resolveTotp();
    login = await emitAck(
      socket,
      "login",
      [{ username, password, token: totp.token }],
      timeoutMs,
      disconnected,
    );
    // Credentials were already proven by the tokenless attempt, so an
    // invalid-token answer is about the token itself — "Invalid Token!" on
    // Kuma 1.x, the i18n key "authInvalidToken" on 2.x. Only the
    // CLI-generated secret path can mint the adjacent counters' tokens —
    // each differs from the rejected one and verifies while the skew
    // stays inside Kuma's ±1 window.
    for (const retryToken of totp.retryTokens) {
      if (
        login?.ok !== false ||
        (login?.msg !== "Invalid Token!" && login?.msg !== "authInvalidToken")
      )
        break;
      login = await emitAck(
        socket,
        "login",
        [{ username, password, token: retryToken }],
        timeoutMs,
        disconnected,
      );
    }
  }
  if (login?.ok !== true) {
    const msg = typeof login?.msg === "string" ? login.msg : "login failed";
    // hasOwn, not []: a wire-controlled msg like "toString" would resolve
    // a prototype member and print it
    fail(2, Object.hasOwn(LOGIN_MSG_I18N, msg) ? LOGIN_MSG_I18N[msg] : msg);
  }

  const wanted = new Set<keyof typeof pushed>([
    "monitorList",
    "notificationList",
    "proxyList",
    "dockerHostList",
    ...extraLists,
  ]);
  const listsDeadline = Date.now() + timeoutMs;
  for (;;) {
    const missing = [...wanted].filter((name) => pushed[name] === undefined);
    if (missing.length === 0) break;
    if (Date.now() >= listsDeadline) {
      fail(2, `timed out waiting for pushed lists: ${missing.join(", ")}`);
    }
    await Promise.race([sleep(10), disconnected]);
  }
  // 1.23.17 and 2.5.11 have sent it by now; the grace covers a release that
  // pushes it later than the lists, and one that never sends it is 1.x out loud.
  const infoDeadline = Date.now() + INFO_GRACE_MS;
  while (serverVersion === undefined && Date.now() < infoDeadline) {
    await Promise.race([sleep(10), disconnected]);
  }
  if (serverVersion === undefined) {
    console.error("warning: the server sent no version after login; assuming Uptime Kuma 1.x");
  }
  const present = <K extends keyof typeof pushed>(name: K): NonNullable<(typeof pushed)[K]> => {
    const value = pushed[name];
    if (value === undefined) fail(70, `pushed ${name} missing after the wait`);
    return value;
  };

  return new KumaSession(
    socket,
    url,
    timeoutMs,
    present("monitorList"),
    wanted.has("maintenanceList") ? present("maintenanceList") : undefined,
    present("notificationList"),
    present("proxyList"),
    present("dockerHostList"),
    wanted.has("apiKeyList") ? present("apiKeyList") : undefined,
    wanted.has("statusPageList") ? present("statusPageList") : undefined,
    heartbeats,
    statsEvents,
    serverVersion,
    serverDbType,
    isContainer,
    primaryBaseURL,
    password,
    disconnected,
  );
}
