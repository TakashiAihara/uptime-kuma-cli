import { io, type Socket } from "socket.io-client";
import { CliError, fail, resolveCredentials, sleep, socketTimeoutMs } from "./lib.ts";

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

// The resolved stats of one monitor as `monitors stats` reports them: the
// uptime values are Kuma's 0..1 ratios over its 24h and 30d windows,
// avgPing is null when the monitor has no beats with a ping in 24h, and
// certInfo is the raw monitor_tls_info info_json (undefined when the
// monitor has no such row).
export type MonitorStats = {
  avgPing: number | null;
  uptime24h: number;
  uptime30d: number;
  certInfo: string | undefined;
};

type BeatRow = Record<string, unknown>;

// First-value-wins record of the stats pushes, kept event by event; sendStats
// re-emits them on every heartbeat.
type MonitorStatEvents = {
  avgPing?: { value: number | null };
  uptime: Map<number, { at: number; value: number }>;
  certInfo?: { at: number; json: string };
};

// Grace after the pushed lists for the versioned `info` (connect() below).
const INFO_GRACE_MS = 500;

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
    readonly statusPageList: Record<string, StatusPageRow> | undefined,
    readonly heartbeats: Map<number, BeatRow[]>,
    private readonly statsEvents: Map<number, MonitorStatEvents>,
    readonly serverVersion: string | undefined,
    // setSettings takes the login password again as currentPassword when the
    // request would disable auth; it is the same secret resolveCredentials
    // already produced for the login, kept here so no command re-resolves it.
    readonly loginPassword: string,
    private readonly disconnected: Promise<never>,
  ) {}

  get majorVersion(): number {
    return parseMajorVersion(this.serverVersion);
  }

  // ok:false is Kuma answering no (exit 1); a missing callback is a timeout (exit 2).
  async request(event: string, args: any[] = []): Promise<any> {
    const res = await emitAck(this.socket, event, args, this.timeoutMs, this.disconnected);
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

  proxies(): ProxyRow[] {
    return [...this.proxyList].sort((a, b) => a.id - b.id);
  }

  proxyById(id: number): ProxyRow | undefined {
    return this.proxies().find((p) => p.id === id);
  }

  dockerHosts(): DockerHostRow[] {
    return [...this.dockerHostList].sort((a, b) => a.id - b.id);
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
  // certInfo right after the uptime 30d. Besides the post-login walk it runs
  // on every heartbeat of any monitor, outside that walk, so another
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

    // a monitor's own bound: certInfo counts only when it came within 500 ms
    // of that monitor's uptime 30d, whatever else the command still waits for
    const certInTime = (id: number): string | undefined => {
      const rec = this.statsEvents.get(id);
      const uptime30d = rec?.uptime.get(720);
      if (uptime30d === undefined || rec?.certInfo === undefined) return undefined;
      return rec.certInfo.at <= uptime30d.at + 500 ? rec.certInfo.json : undefined;
    };
    const certDone = (id: number): boolean => {
      const uptime30d = this.statsEvents.get(id)?.uptime.get(720);
      if (uptime30d === undefined) return false;
      return certInTime(id) !== undefined || Date.now() >= uptime30d.at + 500;
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
      out.set(id, {
        avgPing: avgPing.value,
        uptime24h: uptime24h.value,
        uptime30d: uptime30d.value,
        certInfo: certInTime(id),
      });
    }
    return out;
  }
}

// info.version is package.json's semver on both Kuma versions; a missing or
// unparsable value keeps major 1 so 1.23 stays the default target. Nightly
// builds already report 3.x, so callers branch on `>= 2`, not `=== 2`.
export function parseMajorVersion(version: string | undefined): number {
  const match = version === undefined ? null : /^(\d+)\.\d+\.\d+/.exec(version);
  return match === null ? 1 : Number(match[1]);
}

// monitorList, notificationList, proxyList and dockerHostList are pushed in
// the same tick right after login, so every command waits for them. The
// maintenance commands additionally name the lists they read: maintenanceList
// for the window itself and statusPageList for the status-pages attach —
// statusPageList arrives ~500ms later (afterLogin sleeps first), so waiting
// for it unconditionally would add that latency to every command.
export async function connect(
  extraLists: readonly ("maintenanceList" | "statusPageList")[] = [],
): Promise<KumaSession> {
  const timeoutMs = socketTimeoutMs();
  const { url, username, password } = await resolveCredentials();
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
    rejectDisconnected(new CliError(2, `socket disconnected from ${url}`));
  });

  const pushed: {
    monitorList?: Record<string, Monitor>;
    maintenanceList?: Record<string, MaintenanceRow>;
    notificationList?: NotificationRow[];
    proxyList?: ProxyRow[];
    dockerHostList?: DockerHostRow[];
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
  socket.on("info", (data: unknown) => {
    const version = (data as { version?: unknown } | null | undefined)?.version;
    if (typeof version === "string") serverVersion = version;
  });
  // The server pushes these right after the login callback, so the listeners
  // must be in place before login is emitted.
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
    if (
      Number.isNaN(mid) ||
      typeof period !== "number" ||
      !Number.isFinite(period) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      return;
    }
    const rec = statRecord(mid);
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

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CliError(2, `timed out connecting to ${url}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err: Error) => {
      clearTimeout(timer);
      reject(new CliError(2, `failed to connect to ${url}: ${err.message}`));
    });
  });

  const login = await emitAck(
    socket,
    "login",
    [{ username, password, token: "" }],
    timeoutMs,
    disconnected,
  );
  if (login?.tokenRequired === true) {
    fail(2, "login requires 2FA; this CLI does not support 2FA logins");
  }
  if (login?.ok !== true) {
    const msg = typeof login?.msg === "string" ? login.msg : "login failed";
    fail(2, msg);
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
  // Real Kuma has sent it by now on both versions; the grace only covers a
  // slow push, and a server that never sends it is treated as 1.x out loud.
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
    wanted.has("statusPageList") ? present("statusPageList") : undefined,
    heartbeats,
    statsEvents,
    serverVersion,
    password,
    disconnected,
  );
}
