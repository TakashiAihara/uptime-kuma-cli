import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";

// Mimics the Uptime Kuma 1.23.17 Socket.IO server (server/server.js, server/client.js,
// server/socket-handlers/proxy-socket-handler.js): event names, argument order, callback shapes,
// and the lists pushed right after login.

export type Monitor = Record<string, unknown> & { id: number; name: string };
export type Beat = {
  id: number;
  monitor_id: number;
  status: number;
  msg: string;
  time: string;
  ping: number | null;
  important: number;
  duration: number;
};
export type NotificationRow = {
  id: number;
  name: string;
  active: boolean;
  isDefault: boolean;
  userId: number;
  config: string;
};
// Kuma 1.23's sendProxyList emits the raw bean, so auth/active/default are 0/1
export type ProxyRow = {
  id: number;
  user_id: number;
  protocol: string;
  host: string;
  port: number;
  auth: number;
  username: string | null;
  password: string | null;
  active: number;
  default: number;
  created_date: string;
};
// The statusPageList push carries StatusPage.toJSON(); the fake keeps the
// fields fixtures set (id and title are what the CLI reads).
export type StatusPageRow = {
  id: number;
  title: string;
  slug?: string;
} & Record<string, unknown>;

// Incident rows behind postIncident/unpinIncident and the public
// /api/status-page/:slug route: the Incident.toPublicJSON shape plus the
// owning status page id. Every field but id/statusPageId is optional so
// fixtures can stay small; missing ones fall back to the column defaults.
export type IncidentRow = {
  id: number;
  statusPageId: number;
  title?: string;
  content?: string;
  style?: string;
  pin?: boolean;
  active?: boolean;
  createdDate?: string | null;
  lastUpdatedDate?: string | null;
};

export type Call = { event: string; args: unknown[] };
export type TagRow = { id: number; name: string; color: string };
// monitor.toJSON sends monitor.tags as the monitor_tag⋈tag join:
// mt.* (id, monitor_id, tag_id, value) plus tag.name and tag.color
export type MonitorTagRow = {
  id: number;
  monitor_id: number;
  tag_id: number;
  value: string | null;
  name: string;
  color: string;
};
// The maintenanceList push and getMaintenance carry Maintenance.toJSON(): the
// public shape. The fake stores these fields and derives timeslotList/status
// on emit like the real model does; every field but id is optional so
// fixtures can stay small.
export type MaintenanceRow = {
  id: number;
  title?: string;
  description?: string;
  strategy?: string;
  intervalDay?: number | null;
  active?: boolean;
  // toJSON's dateRange: [start|null] with end appended only when set
  dateRange?: (string | null)[];
  timeRange?: { hours: number; minutes: number; seconds?: number }[];
  weekdays?: unknown[];
  daysOfMonth?: unknown[];
  cron?: string | null;
  duration?: number | null;
  timezone?: string;
  timezoneOption?: string | null;
};

// Per-monitor stats values for the post-login stats pushes; a field left
// out is derived like Kuma computes it (avgPing and the uptimes from the
// beats), and certInfo exists only when set here — it is sent verbatim, so
// a malformed string reaches the CLI unchanged.
export type StatsValues = {
  avgPing?: number | null;
  uptime24h?: number;
  uptime30d?: number;
  certInfo?: string;
};

type ResolvedStats = {
  avgPing: number | null;
  uptime24h: number;
  uptime30d: number;
  certInfo: string | undefined;
};

export type FakeState = {
  username: string;
  password: string;
  monitors: Monitor[];
  beats: Record<number, Beat[]>;
  notifications: NotificationRow[];
  proxies: ProxyRow[];
  // rows returned by getTags; Kuma 1.23 does not push a tag list after login
  tags: TagRow[];
  // rows pushed as dockerHostList after login; the CLI checks docker_host ids against them
  dockerHosts: { id: number }[];
  // rows pushed as statusPageList after login (StatusPage.toJSON values)
  statusPages: StatusPageRow[];
  // incident rows; the public route shows the pinned+active one per page
  incidents: IncidentRow[];
  // publicGroupList rows the /api/status-page/:slug route returns,
  // keyed by status page id (the fake has no group model)
  statusPageGroups: Record<number, Record<string, unknown>[]>;
  // non-200 status the /api/status-page/:slug route answers with
  statusPageApiStatus: number;
  // drops the TCP connection instead of answering, like a network failure
  statusPageApiDrop: boolean;
  // verbatim body the route answers with; undefined computes it from state
  statusPageApiBody: unknown;
  // the route caches per req.url for 5 minutes like apicache; requests after
  // the first N answer 500 (0 disables) so tests can fail a later read
  statusPageApiFailAfter: number;
  // answers the requests after the first N with a body missing publicGroupList
  statusPageApiMalformedAfter: number;
  // req.url values the route saw, in order
  apiRequests: string[];
  // postIncident answer override; null uses the stored-incident answer
  postIncidentResult: Record<string, unknown> | null;
  // rows pushed as maintenanceList after login and returned by getMaintenance
  maintenances: MaintenanceRow[];
  // maintenance_id -> attached monitor ids / status page ids (the
  // monitor_maintenance and maintenance_status_page join tables)
  maintenanceMonitors: Record<number, number[]>;
  maintenanceStatusPages: Record<number, number[]>;
  // login push names withheld from this socket; proves commands only wait for
  // the lists they read
  skipLists: string[];
  // monitor ids that exist but stay out of the login monitorList push, like
  // monitors created after this socket logged in
  unlistedMonitors: number[];
  // event name -> msg; the next call to that event answers { ok: false, msg }.
  // an array arms one outcome per call in order; a null entry lets that call through
  fail: Record<string, string | (string | null)[]>;
  // monitor ids whose heartbeatList is never pushed
  silentHeartbeat: number[];
  // per-monitor stats values; unset fields derive from beats like Kuma computes them
  stats: Record<number, StatsValues>;
  // ms to wait before a monitor's whole stats sequence; like a slow sendStats
  // it also delays every monitor after it in monitorList order
  statsDelay: Record<number, number>;
  // ms to wait before a monitor's certInfo emit; it still precedes the next
  // monitor's stats like the awaited sendCertInfo
  certInfoDelay: Record<number, number>;
  // a second stats round, resendStatsAfterMs after the first, with per-monitor
  // overrides — proves the CLI keeps the first values
  resendStatsAfterMs: number;
  resendStats: Record<number, StatsValues>;
  // monitor ids whose stats pushes (avgPing / uptime / certInfo) never arrive
  silentStats: number[];
  // per-monitor single stats events left out ("avgPing", "uptime24", "uptime720")
  skipStatEvents: Record<number, string[]>;
  testNotificationResult: { ok: boolean; msg: string };
  // getSettings data; primaryBaseURL is what the UI uses for push URLs
  settings: Record<string, unknown>;
  // getSettings answer override; null answers the stored settings with the
  // serverTimezone fill. An array arms one answer per call in order; a null
  // entry lets that call answer normally, like fail's per-call list
  getSettingsResult: Record<string, unknown> | (Record<string, unknown> | null)[] | null;
  // the password setSettings' disableAuth check verifies against; null means
  // state.password — set it to simulate the account password having been
  // rotated after this socket logged in
  settingsPassword: string | null;
  // login answers { tokenRequired: true } like an account with 2FA enabled
  twoFA: boolean;
  // addTag answer override; null uses the stored-tag answer
  addTagResult: Record<string, unknown> | null;
  // addMaintenance answer override; null uses the stored-row answer
  addMaintenanceResult: Record<string, unknown> | null;
  // event name whose request makes the server drop the connection without answering
  disconnectOn: string | null;
  // after the login answer, drop the connection instead of pushing the lists
  dropInsteadOfLists: boolean;
  // drop the connection right after pushing the lists (and the heartbeats not silenced)
  dropAfterLists: boolean;
};

export type FakeKuma = { url: string; calls: Call[]; state: FakeState; close: () => Promise<void> };

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const beatTime = (b: Beat): number => Date.parse(`${b.time.replace(" ", "T")}Z`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// checkSlug of server/socket-handlers/status-page-socket-handler.js (1.23.17):
// addStatusPage lower-cases the slug first, so the accepted set is lowercase
// words joined by single hyphens
const checkStatusPageSlug = (slug: string): void => {
  if (typeof slug !== "string") throw new Error("Slug must be string");
  const s = slug.trim();
  if (!s) throw new Error("Slug cannot be empty");
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(s)) throw new Error("Invalid Slug");
};

// Kuma 1.23 runs redbean frozen, so `add` with a key that is not a monitor column fails.
// The set is the monitor columns: monitorDefaults of src/pages/EditMonitor.vue (1.23.17)
// plus the fields the form edits through v-model (e.g. description, body, headers,
// basic_auth_user). Kept as a literal copy, independent of src/, so the fake keeps
// checking the implementation.
const ADD_KEYS = new Set([
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

export async function startFakeKuma(init: Partial<FakeState> = {}): Promise<FakeKuma> {
  const state: FakeState = {
    username: "admin",
    password: "pw-from-test",
    monitors: [],
    beats: {},
    notifications: [],
    proxies: [],
    tags: [],
    dockerHosts: [],
    statusPages: [],
    incidents: [],
    statusPageGroups: {},
    statusPageApiStatus: 200,
    statusPageApiDrop: false,
    statusPageApiBody: undefined,
    statusPageApiFailAfter: 0,
    statusPageApiMalformedAfter: 0,
    apiRequests: [],
    postIncidentResult: null,
    maintenances: [],
    maintenanceMonitors: {},
    maintenanceStatusPages: {},
    skipLists: [],
    unlistedMonitors: [],
    fail: {},
    silentHeartbeat: [],
    stats: {},
    statsDelay: {},
    skipStatEvents: {},
    certInfoDelay: {},
    resendStatsAfterMs: 0,
    resendStats: {},
    silentStats: [],
    testNotificationResult: { ok: true, msg: "Sent Successfully." },
    settings: {},
    getSettingsResult: null,
    settingsPassword: null,
    twoFA: false,
    addTagResult: null,
    addMaintenanceResult: null,
    disconnectOn: null,
    dropInsteadOfLists: false,
    dropAfterLists: false,
    ...init,
  };
  const calls: Call[] = [];
  const http = createServer();
  const io = new Server(http);
  // apicache of the /api/status-page/:slug route: keyed by req.url (path +
  // query); in Kuma several events call apicache.clear() and the fake models
  // the two relevant here — saveStatusPage and deleteMonitor
  const apiCache = new Map<string, { status: number; body: string }>();
  // status_page.id is AUTOINCREMENT: deleted ids are never reused
  let nextStatusPageId = Math.max(0, ...state.statusPages.map((p) => p.id));

  // monitor.toJSON always carries tags (the monitor_tag⋈tag join, [] when none)
  const tagsOf = (m: Monitor): MonitorTagRow[] =>
    Array.isArray(m.tags) ? (m.tags as MonitorTagRow[]) : [];

  // Monitor.getTags orders the join by tag.name
  const monitorTags = (m: Monitor): MonitorTagRow[] =>
    [...tagsOf(m)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const monitorList = () => {
    const out: Record<string, Monitor> = {};
    for (const m of state.monitors) {
      if (state.unlistedMonitors.includes(m.id)) continue;
      out[String(m.id)] = structuredClone({ ...m, tags: monitorTags(m) });
    }
    return out;
  };

  const nextMonitorTagId = () =>
    Math.max(
      0,
      ...state.monitors.flatMap((m) => tagsOf(m).map((t) => (typeof t.id === "number" ? t.id : 0))),
    ) + 1;

  // Maintenance.getStatus of Kuma 1.23.17, approximated: the real one parses
  // start/end in the maintenance timezone; the fake compares the instants, so
  // tests should use Z-suffixed or distant dates.
  const maintenanceStatus = (m: {
    active: boolean;
    strategy: string;
    dateRange: (string | null)[];
  }): string => {
    if (!m.active) return "inactive";
    if (m.strategy === "manual") return "under-maintenance";
    const now = Date.now();
    const start = m.dateRange[0];
    const end = m.dateRange[1];
    if (start && Date.parse(start) > now) return "scheduled";
    if (end && Date.parse(end) < now) return "ended";
    if (m.strategy === "single") return "under-maintenance";
    return "unknown";
  };

  // dayjs.tz(dayjs(), tz).format("Z"): the current UTC offset of the timezone
  const timezoneOffset = (timezone: string): string => {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
    return match ? `${match[1]}${match[2]}:${match[3]}` : "+00:00";
  };

  // Maintenance.toPublicJSON of Kuma 1.23.17 for the fields the CLI sees;
  // timeslotList and status are derived, missing columns get the model's
  // defaults (the fake's server timezone is UTC). durationMinutes is
  // parseInt(duration / 60) and timezoneOffset the current offset, both
  // derived like the real toJSON.
  const maintenanceJSON = (m: MaintenanceRow): Record<string, unknown> => {
    const strategy = m.strategy ?? "single";
    const active = m.active === undefined ? true : Boolean(m.active);
    const dateRange = m.dateRange ?? [null];
    const timezoneOption = m.timezoneOption ?? null;
    const timezone =
      m.timezone ??
      (timezoneOption === null || timezoneOption === "" || timezoneOption === "SAME_AS_SERVER"
        ? "UTC"
        : timezoneOption);
    const start = dateRange[0] ?? null;
    const end = dateRange[1] ?? null;
    return {
      id: m.id,
      title: m.title ?? "",
      description: m.description ?? "",
      strategy,
      intervalDay: m.intervalDay ?? null,
      active,
      dateRange,
      timeRange: m.timeRange ?? [
        { hours: 0, minutes: 0 },
        { hours: 0, minutes: 0 },
      ],
      weekdays: m.weekdays ?? [],
      daysOfMonth: m.daysOfMonth ?? [],
      timeslotList: strategy === "single" ? [{ startDate: start, endDate: end }] : [],
      cron: m.cron ?? null,
      duration: m.duration ?? null,
      durationMinutes: typeof m.duration === "number" ? Math.trunc(m.duration / 60) : null,
      timezone,
      timezoneOption,
      timezoneOffset: timezoneOffset(timezone),
      status: maintenanceStatus({ active, strategy, dateRange }),
    };
  };

  const maintenanceListJSON = () =>
    Object.fromEntries(state.maintenances.map((m) => [String(m.id), maintenanceJSON(m)]));

  // Incident.toPublicJSON of Kuma 1.23.17; fields a fixture leaves out fall
  // back to the column defaults (style 'warning', pin/active 1)
  const incidentJSON = (i: IncidentRow): Record<string, unknown> => ({
    id: i.id,
    style: i.style ?? "warning",
    title: i.title ?? "",
    content: i.content ?? "",
    pin: i.pin ?? true,
    createdDate: i.createdDate ?? null,
    lastUpdatedDate: i.lastUpdatedDate ?? null,
  });

  // Maintenance.jsonToBean of Kuma 1.23.17: assigns the listed fields
  // unconditionally, dateRange into start/end dates, and the schedule fields
  // only for the strategy that reads them; everything else keeps the stored
  // value. Rows are kept in the toJSON shape, so dateRange and the resolved
  // timezone are rebuilt the way toJSON emits them. recurring-* keeps the
  // stored cron/duration: generateCron and validateCron are not faked.
  const applyMaintenanceJson = (
    before: MaintenanceRow | null,
    obj: Record<string, unknown>,
  ): MaintenanceRow => {
    const dateRange = obj.dateRange as (string | null)[];
    const start = dateRange[0] || null;
    const end = dateRange[1] || null;
    const strategy = (obj.strategy as string | undefined) ?? before?.strategy ?? "single";
    const timezoneOption = (obj.timezoneOption as string | null | undefined) ?? null;
    const row: MaintenanceRow = {
      ...before,
      id: before?.id ?? (obj.id as number),
      title: obj.title as string,
      description: obj.description as string,
      strategy,
      intervalDay: (obj.intervalDay as number | null | undefined) ?? null,
      active: Boolean(obj.active),
      dateRange: end === null ? [start] : [start, end],
      timezoneOption,
      timezone:
        timezoneOption === null || timezoneOption === "" || timezoneOption === "SAME_AS_SERVER"
          ? "UTC"
          : timezoneOption,
    };
    if (strategy === "cron") {
      row.cron = (obj.cron as string | null | undefined) ?? null;
      row.duration = typeof obj.durationMinutes === "number" ? obj.durationMinutes * 60 : null;
    } else if (strategy.startsWith("recurring-")) {
      // parseTimeFromTimeObject -> stored "HH:mm[:ss]" -> parseTimeObject adds
      // seconds: 0; a missing timeRange throws like the real indexing does
      const tr = obj.timeRange as { hours: number; minutes: number; seconds?: number }[];
      const toTime = (t: { hours: number; minutes: number; seconds?: number } | undefined) =>
        t === undefined
          ? { hours: 0, minutes: 0 }
          : { hours: t.hours, minutes: t.minutes, seconds: t.seconds ?? 0 };
      row.timeRange = [toTime(tr[0]), toTime(tr[1])];
      row.weekdays = (obj.weekdays as unknown[] | undefined) ?? [];
      row.daysOfMonth = (obj.daysOfMonth as unknown[] | undefined) ?? [];
    } else if (before === null) {
      // manual/single never write the schedule columns; a fresh bean has the
      // DB defaults (NULL times -> {0,0}, '[]' -> [])
      row.timeRange = [
        { hours: 0, minutes: 0 },
        { hours: 0, minutes: 0 },
      ];
      row.weekdays = [];
      row.daysOfMonth = [];
      row.cron = null;
      row.duration = null;
    }
    return row;
  };

  // Monitor.sendAvgPing of Kuma 1.23.17: parseInt of AVG(ping) over the last
  // 24 hours of beats with a ping; NaN without any, which the wire carries
  // as null
  const avgPingOf = (id: number): number | null => {
    const cutoff = Date.now() - 24 * 3600_000;
    const pings = (state.beats[id] ?? []).flatMap((b) =>
      typeof b.ping === "number" && beatTime(b) > cutoff ? [b.ping] : [],
    );
    return pings.length === 0 ? null : Math.trunc(pings.reduce((a, b) => a + b, 0) / pings.length);
  };

  // calcUptime of Kuma 1.23.17 is duration-weighted over the window; the
  // fake approximates it as the share of up beats (status 1 or 3) inside it
  const uptimeOf = (id: number, hours: number): number => {
    const cutoff = Date.now() - hours * 3600_000;
    const rows = (state.beats[id] ?? []).filter((b) => beatTime(b) > cutoff);
    if (rows.length === 0) return 0;
    const up = rows.filter((b) => b.status === 1 || b.status === 3).length;
    return up / rows.length;
  };

  // stats state overrides beat the derived values field by field; an explicit
  // null avgPing stays null (?? would fall back to the derived value)
  const pick = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);

  // certInfo has no derived value: it exists only when the fixture sets it
  const statValues = (m: Monitor): ResolvedStats => {
    const o = state.stats[m.id];
    return {
      avgPing: pick(o?.avgPing, avgPingOf(m.id)),
      uptime24h: pick(o?.uptime24h, uptimeOf(m.id, 24)),
      uptime30d: pick(o?.uptime30d, uptimeOf(m.id, 720)),
      certInfo: o?.certInfo,
    };
  };

  const resendValues = (m: Monitor): ResolvedStats => {
    const base = statValues(m);
    const o = state.resendStats[m.id];
    return {
      avgPing: pick(o?.avgPing, base.avgPing),
      uptime24h: pick(o?.uptime24h, base.uptime24h),
      uptime30d: pick(o?.uptime30d, base.uptime30d),
      certInfo: pick(o?.certInfo, base.certInfo),
    };
  };

  io.on("connection", (socket) => {
    let loggedIn = false;
    socket.onAny((event, ...args) => {
      const plain = args.filter((a) => typeof a !== "function");
      calls.push({ event, args: structuredClone(plain) });
    });

    const handle = (event: string, fn: (...a: any[]) => unknown) => {
      socket.on(event, async (...args: any[]) => {
        const cb = args[args.length - 1];
        if (state.disconnectOn === event) {
          socket.disconnect(true);
          return;
        }
        const armed = state.fail[event];
        if (typeof armed === "string") {
          delete state.fail[event];
          cb({ ok: false, msg: armed });
          return;
        }
        if (Array.isArray(armed) && armed.length > 0) {
          const msg = armed.shift();
          if (armed.length === 0) delete state.fail[event];
          if (msg != null) {
            cb({ ok: false, msg });
            return;
          }
        }
        if (event !== "login" && !loggedIn) {
          cb({ ok: false, msg: "You are not logged in." });
          return;
        }
        try {
          cb(await fn(...args.slice(0, -1)));
        } catch (e) {
          cb({ ok: false, msg: (e as Error).message });
        }
      });
    };

    handle("login", (data: { username: string; password: string }) => {
      if (data.username !== state.username || data.password !== state.password)
        return { ok: false, msg: "Incorrect username or password." };
      if (state.twoFA) return { tokenRequired: true };
      loggedIn = true;
      // afterLogin sets socket.userID = user.id; the fake's user id is 1
      (socket as { userID?: number }).userID = 1;
      setTimeout(() => {
        if (state.dropInsteadOfLists) {
          socket.disconnect(true);
          return;
        }
        const push = (name: string, emit: () => void) => {
          if (!state.skipLists.includes(name)) emit();
        };
        const list = monitorList();
        push("monitorList", () => socket.emit("monitorList", list));
        push("maintenanceList", () => socket.emit("maintenanceList", maintenanceListJSON()));
        push("notificationList", () =>
          socket.emit(
            "notificationList",
            state.notifications.map((n) => structuredClone(n)),
          ),
        );
        push("proxyList", () =>
          socket.emit(
            "proxyList",
            state.proxies.map((p) => structuredClone(p)),
          ),
        );
        push("dockerHostList", () =>
          socket.emit(
            "dockerHostList",
            state.dockerHosts.map((h) => structuredClone(h)),
          ),
        );
        // Kuma pushes this one ~500ms after the other lists (afterLogin sleeps
        // first); the fake sends it in the same batch, the CLI waits either way
        push("statusPageList", () =>
          socket.emit(
            "statusPageList",
            Object.fromEntries(state.statusPages.map((p) => [String(p.id), structuredClone(p)])),
          ),
        );
        for (const m of state.monitors) {
          if (state.silentHeartbeat.includes(m.id)) continue;
          socket.emit("heartbeatList", m.id, (state.beats[m.id] ?? []).slice(-100));
        }
        for (const m of state.monitors) {
          const imp = (state.beats[m.id] ?? []).filter((b) => b.important).reverse();
          socket.emit("importantHeartbeatList", m.id, imp, false);
        }
        // Monitor.sendStats of Kuma 1.23.17 runs after the heartbeat lists,
        // once per monitor in monitorList order (its integer keys enumerate
        // by id): avgPing, uptime 24h, uptime 30d, then certInfo only when a
        // monitor_tls_info row exists. Each sendStats is awaited, so a
        // monitor's certInfo precedes the next monitor's avgPing; the delays
        // model the DB lookups and hold the rest of the stream the same way
        const emitStats = async (values: (m: Monitor) => ResolvedStats) => {
          for (const m of Object.values(list)) {
            if (state.silentStats.includes(m.id)) continue;
            const delay = state.statsDelay[m.id] ?? 0;
            if (delay > 0) await sleep(delay);
            const v = values(m);
            const skip = state.skipStatEvents[m.id] ?? [];
            if (!skip.includes("avgPing")) socket.emit("avgPing", m.id, v.avgPing);
            if (!skip.includes("uptime24")) socket.emit("uptime", m.id, 24, v.uptime24h);
            if (!skip.includes("uptime720")) socket.emit("uptime", m.id, 720, v.uptime30d);
            if (v.certInfo !== undefined) {
              const certDelay = state.certInfoDelay[m.id] ?? 0;
              if (certDelay > 0) await sleep(certDelay);
              socket.emit("certInfo", m.id, v.certInfo);
            }
          }
        };
        void (async () => {
          await emitStats(statValues);
          if (Object.keys(state.resendStats).length > 0) {
            if (state.resendStatsAfterMs > 0) await sleep(state.resendStatsAfterMs);
            await emitStats(resendValues);
          }
        })();
        if (state.dropAfterLists) setTimeout(() => socket.disconnect(true), 50);
      }, 20);
      return { ok: true, token: "jwt-token" };
    });

    handle("getMonitor", (id: number) => {
      const m = state.monitors.find((x) => x.id === Number(id));
      if (!m) throw new Error("Cannot read properties of null (reading 'toJSON')");
      return { ok: true, monitor: structuredClone({ ...m, tags: monitorTags(m) }) };
    });

    handle("add", (monitor: Monitor) => {
      const unknown = Object.keys(monitor).filter((k) => !ADD_KEYS.has(k));
      if (unknown.length)
        throw new Error(`SQLITE_ERROR: table monitor has no column named ${unknown[0]}`);
      if (!(monitor.accepted_statuscodes as unknown[]).every((c) => typeof c === "string"))
        throw new Error("Accepted status codes are not all strings");
      const id = Math.max(0, ...state.monitors.map((m) => m.id)) + 1;
      const list = monitor.notificationIDList as Record<string, boolean>;
      const ids: Record<string, boolean> = {};
      for (const k in list) if (list[k]) ids[k] = true;
      state.monitors.push({
        ...structuredClone(monitor),
        id,
        active: monitor.active !== false,
        notificationIDList: ids,
      });
      socket.emit("monitorList", monitorList());
      return { ok: true, msg: "Added Successfully.", monitorID: id };
    });

    handle("editMonitor", (monitor: Monitor) => {
      const i = state.monitors.findIndex((m) => m.id === monitor.id);
      if (i < 0) throw new Error("Cannot read properties of null (reading 'user_id')");
      // Like updateMonitorNotification: `for...in` over an array stores its indexes as ids
      const list = monitor.notificationIDList as Record<string, boolean>;
      const ids: Record<string, boolean> = {};
      for (const k in list) if (list[k]) ids[k] = true;
      // editMonitor copies a fixed field list onto the bean; `active` is not among them
      const before = state.monitors[i]!;
      state.monitors[i] = {
        ...structuredClone(monitor),
        active: before.active,
        notificationIDList: ids,
      };
      socket.emit("monitorList", monitorList());
      return { ok: true, msg: "Saved.", monitorID: monitor.id };
    });

    const setActive = (active: boolean) => (id: number) => {
      const m = state.monitors.find((x) => x.id === Number(id));
      if (!m) throw new Error("Cannot read properties of null (reading 'user_id')");
      m.active = active;
      socket.emit("monitorList", monitorList());
      return { ok: true, msg: active ? "Resumed Successfully." : "Paused Successfully." };
    };
    handle("pauseMonitor", setActive(false));
    handle("resumeMonitor", setActive(true));

    // Kuma 1.23 does not check that the id exists: the DELETE affects 0 rows and still answers ok
    handle("deleteMonitor", (id: number) => {
      state.monitors = state.monitors.filter((m) => m.id !== Number(id));
      // deleteMonitor calls apicache.clear() so cached public pages drop the monitor
      apiCache.clear();
      socket.emit("monitorList", monitorList());
      return { ok: true, msg: "Deleted Successfully." };
    });

    handle("getMonitorBeats", (id: number, period: number) => {
      if (period == null) throw new Error("Invalid period.");
      const cutoff = Date.now() - Number(period) * 3600_000;
      const data = (state.beats[Number(id)] ?? []).filter((b) => beatTime(b) > cutoff);
      return { ok: true, data: structuredClone(data) };
    });

    handle("addNotification", (n: Record<string, unknown>, id: number | null) => {
      let row: NotificationRow | undefined;
      if (id) {
        row = state.notifications.find((x) => x.id === Number(id));
        if (!row) throw new Error("notification not found");
      } else {
        row = {
          id: Math.max(0, ...state.notifications.map((x) => x.id)) + 1,
          name: "",
          active: true,
          isDefault: false,
          userId: 1,
          config: "{}",
        };
        state.notifications.push(row);
      }
      row.name = String(n.name);
      row.config = JSON.stringify(n);
      row.isDefault = Boolean(n.isDefault);
      return { ok: true, msg: "Saved", id: row.id };
    });

    handle("testNotification", () => structuredClone(state.testNotificationResult));

    handle("deleteNotification", (id: number) => {
      const i = state.notifications.findIndex((x) => x.id === Number(id));
      if (i < 0) return { ok: false, msg: "notification not found" };
      state.notifications.splice(i, 1);
      socket.emit(
        "notificationList",
        state.notifications.map((n) => structuredClone(n)),
      );
      return { ok: true, msg: "Deleted" };
    });

    handle("getSettings", () => {
      const armed = state.getSettingsResult;
      if (Array.isArray(armed)) {
        if (armed.length > 0) {
          const next = armed.shift();
          if (armed.length === 0) state.getSettingsResult = null;
          if (next != null) return next;
        }
      } else if (armed !== null) {
        return armed;
      }
      const data = structuredClone(state.settings);
      // getSettings fills a missing serverTimezone from server.getTimezone();
      // the fake's server timezone is UTC like maintenanceJSON's
      if (!data.serverTimezone) data.serverTimezone = "UTC";
      return { ok: true, data };
    });

    // server.js setSettings of Kuma 1.23.17: Settings.setSettings upserts only
    // the keys present in data. Turning auth off while it is on re-checks the
    // password (doubleCheckPassword), and turning it back on disconnects every
    // other client of the user (GHSA-23q2-5gf8-gjpp).
    handle("setSettings", (data: Record<string, unknown>, currentPassword: unknown) => {
      const currentDisabledAuth = state.settings.disableAuth;
      if (!currentDisabledAuth && data.disableAuth) {
        if (typeof currentPassword !== "string") throw new Error("Wrong data type?");
        if (currentPassword !== (state.settingsPassword ?? state.password)) {
          throw new Error("Incorrect current password");
        }
      }
      if (currentDisabledAuth && !data.disableAuth) {
        for (const other of io.sockets.sockets.values()) {
          if ((other as { userID?: number }).userID !== 1 || other.id === socket.id) continue;
          other.emit("refresh");
          other.disconnect();
        }
      }
      for (const key of Object.keys(data)) {
        state.settings[key] = structuredClone(data[key]);
      }
      return { ok: true, msg: "Saved" };
    });

    handle("addProxy", (p: Record<string, unknown>, id: number | null) => {
      let row: ProxyRow | undefined;
      if (id) {
        row = state.proxies.find((x) => x.id === Number(id));
        if (!row) throw new Error("proxy not found");
      } else {
        row = {
          id: Math.max(0, ...state.proxies.map((x) => x.id)) + 1,
          user_id: 1,
          protocol: "",
          host: "",
          port: 0,
          auth: 0,
          username: null,
          password: null,
          active: 1,
          default: 0,
          created_date: now(),
        };
        state.proxies.push(row);
      }
      Object.assign(row, {
        protocol: p.protocol,
        host: p.host,
        port: p.port,
        auth: p.auth ? 1 : 0,
        username: (p.username as string) ?? null,
        password: (p.password as string) ?? null,
        // Kuma 1.23's proxy save stores every proxy active (proxy.active || true)
        active: 1,
        default: p.default ? 1 : 0,
      });
      return { ok: true, msg: "Saved", id: row.id };
    });

    handle("deleteProxy", (id: number) => {
      const i = state.proxies.findIndex((x) => x.id === Number(id));
      if (i < 0) return { ok: false, msg: "proxy not found" };
      // monitors using the proxy get proxy_id = null
      for (const m of state.monitors) if (m.proxyId === Number(id)) m.proxyId = null;
      state.proxies.splice(i, 1);
      socket.emit(
        "proxyList",
        state.proxies.map((p) => structuredClone(p)),
      );
      return { ok: true, msg: "Deleted" };
    });

    handle("getTags", () => ({ ok: true, tags: structuredClone(state.tags) }));

    handle("addTag", (tag: { name: string; color: string }) => {
      if (state.addTagResult !== null) return state.addTagResult;
      const row: TagRow = {
        id: Math.max(0, ...state.tags.map((t) => t.id)) + 1,
        name: tag.name,
        color: tag.color,
      };
      state.tags.push(row);
      return { ok: true, tag: structuredClone(row) };
    });

    handle("editTag", (tag: { id: number; name: string; color: string }) => {
      const row = state.tags.find((t) => t.id === Number(tag.id));
      if (!row) return { ok: false, msg: "Tag not found" };
      row.name = tag.name;
      row.color = tag.color;
      // the monitor_tag⋈tag join reads name/color live
      for (const m of state.monitors) {
        for (const t of tagsOf(m)) {
          if (t.tag_id === row.id) {
            t.name = row.name;
            t.color = row.color;
          }
        }
      }
      return { ok: true, msg: "Saved", tag: structuredClone(row) };
    });

    // Kuma 1.23 answers ok even for an unknown id: the DELETE affects 0 rows;
    // monitor_tag rows cascade with the tag
    handle("deleteTag", (id: number) => {
      state.tags = state.tags.filter((t) => t.id !== Number(id));
      for (const m of state.monitors) {
        m.tags = tagsOf(m).filter((t) => t.tag_id !== Number(id));
      }
      return { ok: true, msg: "Deleted Successfully." };
    });

    handle("getMaintenance", (id: number) => {
      const m = state.maintenances.find((x) => x.id === Number(id));
      // R.findOne returns null and bean.toJSON() throws, like getMonitor
      if (!m) throw new Error("Cannot read properties of null (reading 'toJSON')");
      return { ok: true, maintenance: maintenanceJSON(m) };
    });

    handle("addMaintenance", (maintenance: Record<string, unknown>) => {
      if (state.addMaintenanceResult !== null) return state.addMaintenanceResult;
      const id = Math.max(0, ...state.maintenances.map((m) => m.id)) + 1;
      const row = applyMaintenanceJson(null, { ...maintenance, id });
      state.maintenances.push(row);
      socket.emit("maintenanceList", maintenanceListJSON());
      return { ok: true, msg: "Added Successfully.", maintenanceID: id };
    });

    handle("editMaintenance", (maintenance: Record<string, unknown>) => {
      const i = state.maintenances.findIndex((m) => m.id === Number(maintenance.id));
      // server.getMaintenance returns null and bean.user_id throws
      if (i < 0) throw new Error("Cannot read properties of null (reading 'user_id')");
      const row = applyMaintenanceJson(state.maintenances[i]!, maintenance);
      state.maintenances[i] = row;
      socket.emit("maintenanceList", maintenanceListJSON());
      return { ok: true, msg: "Saved.", maintenanceID: row.id };
    });

    // the DELETE is user-scoped but answers ok even when nothing matches
    handle("deleteMaintenance", (id: number) => {
      state.maintenances = state.maintenances.filter((m) => m.id !== Number(id));
      socket.emit("maintenanceList", maintenanceListJSON());
      return { ok: true, msg: "Deleted Successfully." };
    });

    const setMaintenanceActive = (active: boolean) => (id: number) => {
      const m = state.maintenances.find((x) => x.id === Number(id));
      if (!m) throw new Error("Maintenance not found");
      m.active = active;
      socket.emit("maintenanceList", maintenanceListJSON());
      return { ok: true, msg: active ? "Resume Successfully" : "Paused Successfully." };
    };
    handle("pauseMaintenance", setMaintenanceActive(false));
    handle("resumeMaintenance", setMaintenanceActive(true));

    // monitor_maintenance / maintenance_status_page: add*Maintenance* handlers
    // DELETE every row of the maintenance first, then insert the given ids —
    // they replace the whole set, they do not add to it. Both join tables have
    // foreign keys to monitor / status_page / maintenance.
    const attachIds = (
      maintenanceID: number,
      items: { id?: unknown }[],
      exists: (id: number) => boolean,
    ): number[] => {
      if (!state.maintenances.some((m) => m.id === maintenanceID)) {
        throw new Error("FOREIGN KEY constraint failed");
      }
      const ids = items.map((item) => Number(item?.id));
      for (const id of ids) {
        if (!exists(id)) throw new Error("FOREIGN KEY constraint failed");
      }
      return ids;
    };

    handle("getMonitorMaintenance", (maintenanceID: number) => {
      const ids = state.maintenanceMonitors[Number(maintenanceID)] ?? [];
      // the SQL selects only monitor.id
      return { ok: true, monitors: ids.map((id) => ({ id })) };
    });

    handle("addMonitorMaintenance", (maintenanceID: number, monitors: { id?: unknown }[]) => {
      state.maintenanceMonitors[Number(maintenanceID)] = attachIds(
        Number(maintenanceID),
        monitors,
        (id) => state.monitors.some((m) => m.id === id),
      );
      return { ok: true, msg: "Added Successfully." };
    });

    handle("getMaintenanceStatusPage", (maintenanceID: number) => {
      const ids = state.maintenanceStatusPages[Number(maintenanceID)] ?? [];
      // the SQL joins status_page, so a dangling id would not be returned
      return {
        ok: true,
        statusPages: ids
          .map((id) => state.statusPages.find((p) => p.id === id))
          .filter((p): p is StatusPageRow => p !== undefined)
          .map((p) => ({ id: p.id, title: p.title })),
      };
    });

    handle("addMaintenanceStatusPage", (maintenanceID: number, statusPages: { id?: unknown }[]) => {
      state.maintenanceStatusPages[Number(maintenanceID)] = attachIds(
        Number(maintenanceID),
        statusPages,
        (id) => state.statusPages.some((p) => p.id === id),
      );
      return { ok: true, msg: "Added Successfully." };
    });

    // monitor_tag has no unique constraint: the same tag+value can be attached twice
    handle("addMonitorTag", (tagID: number, monitorID: number, value: string | null) => {
      const tag = state.tags.find((t) => t.id === Number(tagID));
      const monitor = state.monitors.find((m) => m.id === Number(monitorID));
      // foreign keys are on, so an unknown tag or monitor fails inside SQLite
      if (!tag || !monitor) throw new Error("FOREIGN KEY constraint failed");
      const rows = tagsOf(monitor);
      rows.push({
        id: nextMonitorTagId(),
        monitor_id: monitor.id,
        tag_id: tag.id,
        value: value ?? null,
        name: tag.name,
        color: tag.color,
      });
      monitor.tags = rows;
      return { ok: true, msg: "Added Successfully." };
    });

    // UPDATE ... WHERE tag_id AND monitor_id rewrites the value on every row of
    // that tag on the monitor and answers ok even when nothing matches
    handle("editMonitorTag", (tagID: number, monitorID: number, value: string | null) => {
      const monitor = state.monitors.find((m) => m.id === Number(monitorID));
      if (monitor) {
        for (const t of tagsOf(monitor)) {
          if (t.tag_id === Number(tagID)) t.value = value ?? null;
        }
      }
      return { ok: true, msg: "Edited Successfully." };
    });

    // DELETE ... WHERE tag_id AND monitor_id AND value answers ok even when
    // nothing matches; `value = ?` never matches a stored NULL
    handle("deleteMonitorTag", (tagID: number, monitorID: number, value: string | null) => {
      const monitor = state.monitors.find((m) => m.id === Number(monitorID));
      if (monitor && value != null) {
        monitor.tags = tagsOf(monitor).filter(
          (t) => !(t.tag_id === Number(tagID) && t.value === value),
        );
      }
      return { ok: true, msg: "Deleted Successfully." };
    });

    // status-page-socket-handler.js of Kuma 1.23.17. None of these events
    // re-pushes statusPageList — sendStatusPageList only runs in afterLogin.
    handle("getStatusPage", (slug: string) => {
      const page = state.statusPages.find((p) => p.slug === slug);
      // R.findOne returns null and the handler throws "No slug?"
      if (page === undefined) throw new Error("No slug?");
      return { ok: true, config: structuredClone(page) };
    });

    handle("addStatusPage", (title: string, slug: string) => {
      const t = title?.trim();
      const s = slug?.trim();
      if (!t || !s) throw new Error("Please input all fields");
      if (typeof s !== "string") throw new Error("Slug -Accept string only");
      const normalized = s.toLowerCase();
      checkStatusPageSlug(normalized);
      // status_page.slug has a UNIQUE index (patch-status-page.sql)
      if (state.statusPages.some((p) => p.slug === normalized)) {
        throw new Error("UNIQUE constraint failed: status_page.slug");
      }
      const id = ++nextStatusPageId;
      state.statusPages.push({
        id,
        slug: normalized,
        title: t,
        description: null,
        // getIcon() maps the empty stored icon to /icon.svg
        icon: "/icon.svg",
        theme: "auto",
        published: true,
        showTags: false,
        domainNameList: [],
        customCSS: null,
        footerText: null,
        showPoweredBy: true,
        googleAnalyticsId: null,
        showCertificateExpiry: false,
      });
      return { ok: true, msg: "OK!" };
    });

    handle("deleteStatusPage", (slug: string) => {
      const page = state.statusPages.find((p) => p.slug === slug);
      // slugToID finds nothing and the handler throws "Status Page is not found"
      if (page === undefined) throw new Error("Status Page is not found");
      // incidents and groups are deleted by hand (no cascade FK); cnames cascade
      state.incidents = state.incidents.filter((i) => i.statusPageId !== page.id);
      delete state.statusPageGroups[page.id];
      state.statusPages = state.statusPages.filter((p) => p.id !== page.id);
      return { ok: true };
    });

    handle(
      "postIncident",
      (
        slug: string,
        incident: { id?: number; title?: string; content?: string; style?: string },
      ) => {
        if (state.postIncidentResult !== null) return state.postIncidentResult;
        const page = state.statusPages.find((p) => p.slug === slug);
        const statusPageID = page?.id;
        if (!statusPageID) throw new Error("slug is not found");
        // every incident of the page is unpinned before the new one is stored
        for (const i of state.incidents) {
          if (i.statusPageId === statusPageID) i.pin = false;
        }
        // an incident.id that does not belong to the page falls through to a
        // fresh bean, but the date branch still follows incident.id
        const isEdit = Boolean(incident.id);
        let row = isEdit
          ? state.incidents.find(
              (i) => i.id === Number(incident.id) && i.statusPageId === statusPageID,
            )
          : undefined;
        if (row === undefined) {
          row = {
            id: Math.max(0, ...state.incidents.map((i) => i.id)) + 1,
            statusPageId: statusPageID,
            active: true,
          };
          state.incidents.push(row);
        }
        row.title = incident.title;
        row.content = incident.content;
        row.style = incident.style;
        row.pin = true;
        if (isEdit) {
          row.lastUpdatedDate = now();
        } else {
          row.createdDate = now();
        }
        return { ok: true, incident: incidentJSON(row) };
      },
    );

    handle("unpinIncident", (slug: string) => {
      const page = state.statusPages.find((p) => p.slug === slug);
      // slugToID returns null for an unknown slug and the UPDATE with a NULL
      // status_page_id matches nothing — the event still answers ok
      if (page !== undefined) {
        for (const i of state.incidents) {
          if (i.statusPageId === page.id) i.pin = false;
        }
      }
      return { ok: true };
    });

    // saveStatusPage of Kuma 1.23.17: finds the page by the first slug arg,
    // overwrites every config column it reads (a missing key becomes null),
    // rewrites the domain names, then replaces the whole public group set —
    // groups not in the list are deleted. It answers { ok, publicGroupList }
    // with the sent groups mutated to carry their (new) ids.
    handle(
      "saveStatusPage",
      (
        slug: string,
        config: Record<string, any>,
        imgDataUrl: string,
        publicGroupList: Record<string, any>[],
      ) => {
        const page = state.statusPages.find((p) => p.slug === slug);
        // R.findOne returns null and the handler throws "No slug?"
        if (page === undefined) throw new Error("No slug?");
        checkStatusPageSlug(config?.slug);
        // imgDataUrl.startsWith crashes on a missing value like the real one;
        // a data: URL must be PNG, anything else becomes the icon verbatim
        if (imgDataUrl.startsWith("data:")) {
          if (!imgDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("Only allowed PNG logo.");
          }
          // ImageDataURI.outputFile is not faked; only the stored icon matters
          page.icon = `/upload/logo${page.id}.png?t=${Date.now()}`;
        } else {
          // getIcon() reports /icon.svg for a falsy stored icon
          page.icon = imgDataUrl || "/icon.svg";
        }
        // the handler stores config.slug verbatim: checkSlug trims only its
        // own copy, so surrounding spaces would be stored too
        page.slug = config.slug;
        page.title = config.title;
        page.description = config.description;
        page.theme = config.theme;
        page.showTags = config.showTags;
        page.footerText = config.footerText;
        page.customCSS = config.customCSS;
        page.showPoweredBy = config.showPoweredBy;
        page.showCertificateExpiry = config.showCertificateExpiry;
        page.googleAnalyticsId = config.googleAnalyticsId;
        // updateDomainNameList: not an array throws "Invalid array", a
        // non-string entry "Invalid domain"; blanks are skipped and a domain
        // moves off the page that had it
        if (!Array.isArray(config.domainNameList)) throw new Error("Invalid array");
        for (const d of config.domainNameList) {
          if (typeof d !== "string") throw new Error("Invalid domain");
        }
        const domains = (config.domainNameList as string[]).filter((d) => d.trim() !== "");
        for (const p of state.statusPages) {
          if (p.id !== page.id && Array.isArray(p.domainNameList)) {
            p.domainNameList = p.domainNameList.filter((d) => !domains.includes(d));
          }
        }
        page.domainNameList = domains;

        const kept: Record<string, unknown>[] = [];
        const existing = state.statusPageGroups[page.id] ?? [];
        const nextGroupId = () =>
          Math.max(
            0,
            ...Object.values(state.statusPageGroups)
              .flat()
              .map((g) => Number(g.id)),
            ...kept.map((g) => Number(g.id)),
          ) + 1;
        let groupOrder = 1;
        for (const g of publicGroupList) {
          // findOne hits the DB, which already holds the groups stored earlier
          // in this same loop, so the lookup pool is old plus just-written
          const wantedId = g.id ? Number(g.id) : undefined;
          const found =
            wantedId === undefined
              ? undefined
              : [...existing, ...kept].find((x) => x.id === wantedId);
          // findOne("id = ? AND public = 1 AND status_page_id = ?") returns
          // null for another page's group and the handler throws on it
          if (wantedId !== undefined && found === undefined) {
            throw new TypeError("Cannot set properties of null (setting 'status_page_id')");
          }
          const id = found === undefined ? nextGroupId() : Number(found.id);
          const monitorList: Record<string, unknown>[] = [];
          for (const m of g.monitorList) {
            const mon = state.monitors.find((x) => x.id === Number(m?.id));
            // monitor_group.monitor_id references monitor(id)
            if (mon === undefined) throw new Error("FOREIGN KEY constraint failed");
            // send_url is only written when the key is present; the column
            // defaults to 0
            const sendUrl = m?.sendUrl === undefined ? 0 : m.sendUrl;
            const row: Record<string, unknown> = {
              id: mon.id,
              name: mon.name,
              sendUrl,
              type: mon.type,
            };
            if (sendUrl) row.url = mon.url;
            monitorList.push(row);
          }
          const row = { id, name: g.name, weight: groupOrder++, monitorList };
          const at = kept.findIndex((x) => x.id === id);
          if (at >= 0) kept[at] = row;
          else kept.push(row);
          // the handler mutates the sent object so the callback carries ids
          g.id = id;
        }
        // groups of this page that are not in the list are deleted
        state.statusPageGroups[page.id] = kept;
        // saveStatusPage calls apicache.clear(), as does deleteMonitor; the
        // fake clears its simulated cache on both
        apiCache.clear();
        return { ok: true, publicGroupList };
      },
    );
  });

  // GET /api/status-page/:slug of status-page-router.js: the public status
  // page data ({ config: toPublicJSON, incident, publicGroupList,
  // maintenanceList }). The real route is apicache'd for 5 minutes keyed on
  // req.originalUrl including the query string, and hangs on an unknown
  // slug; the fake answers 404 instead and caches per req.url, cleared by
  // the events the fake models that clear it (saveStatusPage, deleteMonitor).
  // Requests outside this path are left alone so the socket.io handshake is
  // untouched.
  http.on("request", (req, res) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    const match = req.method === "GET" ? /^\/api\/status-page\/([^/]+)$/.exec(path) : null;
    if (match === null) return;
    res.setHeader("content-type", "application/json");
    state.apiRequests.push(url);
    if (state.statusPageApiDrop) {
      res.socket?.destroy();
      return;
    }
    const hit = apiCache.get(url);
    if (hit !== undefined) {
      res.statusCode = hit.status;
      res.end(hit.body);
      return;
    }
    const slug = decodeURIComponent(match[1] ?? "");
    const page = state.statusPages.find((p) => p.slug === slug);
    let status = state.statusPageApiStatus;
    // statusPageApiFailAfter fails the requests after the first N
    if (
      status === 200 &&
      state.statusPageApiFailAfter > 0 &&
      state.apiRequests.length > state.statusPageApiFailAfter
    ) {
      status = 500;
    }
    let body: string;
    if (page === undefined || status !== 200) {
      status = page === undefined ? 404 : status;
      body = JSON.stringify({ status: "fail", msg: "Not Found" });
    } else if (
      state.statusPageApiMalformedAfter > 0 &&
      state.apiRequests.length > state.statusPageApiMalformedAfter
    ) {
      body = JSON.stringify({ config: {}, incident: null });
    } else if (state.statusPageApiBody !== undefined) {
      body = JSON.stringify(state.statusPageApiBody);
    } else {
      const incident = state.incidents.find(
        (i) => i.statusPageId === page.id && i.pin !== false && i.active !== false,
      );
      // toPublicJSON drops id and domainNameList
      const config = structuredClone(page) as Record<string, unknown>;
      delete config.id;
      delete config.domainNameList;
      body = JSON.stringify({
        config,
        incident: incident === undefined ? null : incidentJSON(incident),
        publicGroupList: state.statusPageGroups[page.id] ?? [],
        maintenanceList: [],
      });
    }
    apiCache.set(url, { status, body });
    res.statusCode = status;
    res.end(body);
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    close: () =>
      new Promise<void>((r) => {
        io.close();
        http.close(() => r());
      }),
  };
}

export const beat = (
  monitor_id: number,
  minutesAgo: number,
  status: number,
  important = 0,
  msg = "",
): Beat => ({
  id: Math.floor(Math.random() * 1e9),
  monitor_id,
  status,
  msg,
  time: new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 19),
  ping: status === 1 ? 12 : null,
  important,
  duration: 60,
});
