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

type BeatRow = Record<string, unknown>;

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
    private readonly disconnected: Promise<never>,
  ) {}

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
    disconnected,
  );
}
