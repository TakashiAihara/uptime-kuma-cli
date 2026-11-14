import { io, type Socket } from "socket.io-client";
import { CliError, fail, resolveCredentials, sleep, socketTimeoutMs } from "./lib.ts";

export interface Monitor extends Record<string, unknown> {
  id: number;
  name: string;
}

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
    readonly notificationList: NotificationRow[],
    readonly proxyList: ProxyRow[],
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

export async function connect(): Promise<KumaSession> {
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
    notificationList?: NotificationRow[];
    proxyList?: ProxyRow[];
  } = {};
  const heartbeats = new Map<number, BeatRow[]>();
  // The server pushes these right after the login callback, so the listeners
  // must be in place before login is emitted.
  socket.on("monitorList", (data: Record<string, Monitor>) => {
    pushed.monitorList = data;
  });
  socket.on("notificationList", (data: NotificationRow[]) => {
    pushed.notificationList = data;
  });
  socket.on("proxyList", (data: ProxyRow[]) => {
    pushed.proxyList = data;
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
    socket.once("disconnect", () => {
      clearTimeout(timer);
      reject(new CliError(2, `socket disconnected from ${url}`));
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

  const listsDeadline = Date.now() + timeoutMs;
  while (!pushed.monitorList || !pushed.notificationList || !pushed.proxyList) {
    if (Date.now() >= listsDeadline) {
      fail(2, "timed out waiting for pushed monitor/notification/proxy lists");
    }
    await Promise.race([sleep(10), disconnected]);
  }
  const lists = pushed as Required<typeof pushed>;

  return new KumaSession(
    socket,
    url,
    timeoutMs,
    lists.monitorList,
    lists.notificationList,
    lists.proxyList,
    heartbeats,
    disconnected,
  );
}
