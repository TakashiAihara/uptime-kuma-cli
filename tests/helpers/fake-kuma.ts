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
  testNotificationResult: { ok: boolean; msg: string };
  // getSettings data; primaryBaseURL is what the UI uses for push URLs
  settings: Record<string, unknown>;
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
    maintenances: [],
    maintenanceMonitors: {},
    maintenanceStatusPages: {},
    skipLists: [],
    unlistedMonitors: [],
    fail: {},
    silentHeartbeat: [],
    testNotificationResult: { ok: true, msg: "Sent Successfully." },
    settings: {},
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
      setTimeout(() => {
        if (state.dropInsteadOfLists) {
          socket.disconnect(true);
          return;
        }
        const push = (name: string, emit: () => void) => {
          if (!state.skipLists.includes(name)) emit();
        };
        push("monitorList", () => socket.emit("monitorList", monitorList()));
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
      socket.emit("monitorList", monitorList());
      return { ok: true, msg: "Deleted Successfully." };
    });

    handle("getMonitorBeats", (id: number, period: number) => {
      if (period == null) throw new Error("Invalid period.");
      const cutoff = Date.now() - Number(period) * 3600_000;
      const data = (state.beats[Number(id)] ?? []).filter(
        (b) => Date.parse(`${b.time.replace(" ", "T")}Z`) > cutoff,
      );
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

    handle("getSettings", () => ({ ok: true, data: structuredClone(state.settings) }));

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
