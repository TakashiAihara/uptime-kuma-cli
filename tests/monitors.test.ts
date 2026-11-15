import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

const http = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  type: "http",
  active: true,
  url: `https://${name}.example.com`,
  hostname: null,
  port: null,
  interval: 60,
  retryInterval: 60,
  timeout: 48,
  proxyId: null,
  docker_host: null,
  dns_resolve_server: "1.1.1.1",
  parent: null,
  maxretries: 0,
  notificationIDList: {},
  accepted_statuscodes: ["200-299"],
  ...extra,
});

const group = (id: number, name: string) => ({
  id,
  name,
  type: "group",
  active: true,
  parent: null,
  notificationIDList: {},
});

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    monitors: [
      http(7, "Taba", { notificationIDList: { "3": true, "5": true } }),
      http(2, "dav", { notificationIDList: [4] }),
      { ...http(9, "trade1 push"), type: "push", url: null, active: false },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

const addCalls = () => kuma.calls.filter((c) => c.event === "add");

const defaultProxy = () => ({
  id: 3,
  user_id: 1,
  protocol: "http",
  host: "p",
  port: 1,
  auth: 0,
  username: null,
  password: null,
  active: 1,
  default: 1,
  created_date: "",
});

describe("monitors list", () => {
  test("prints every monitor sorted by id with normalized notification ids", async () => {
    const r = await run(sb, ["monitors", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.map((m: any) => m.id)).toEqual([2, 7, 9]);
    expect(out[0]).toEqual({
      id: 2,
      name: "dav",
      type: "http",
      active: true,
      url: "https://dav.example.com",
      hostname: null,
      port: null,
      interval: 60,
      parent: null,
      notificationIDList: [4],
    });
    expect(out[1].notificationIDList).toEqual([3, 5]);
  });

  test("hides the password in a URL with credentials and keeps plain URLs as they are", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.url =
      "https://u1:fixture-hidden-u1@x.example.com/p";
    const r = await run(sb, ["monitors", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("fixture-hidden-u1");
    const out = r.json();
    expect(out.find((m: any) => m.id === 7).url).toBe("https://u1:***@x.example.com/p");
    expect(out.find((m: any) => m.id === 2).url).toBe("https://dav.example.com");
  });

  test("--name filters case-insensitively by substring", async () => {
    const r = await run(sb, ["monitors", "list", "--name", "TAB"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().map((m: any) => m.id)).toEqual([7]);
  });
});

describe("monitors get", () => {
  test("prints the whole monitor", async () => {
    const r = await run(sb, ["monitors", "get", "7"], creds(kuma.url));
    expect(r.code).toBe(0);
    const m = r.json();
    expect(m.maxretries).toBe(0);
    expect(m.accepted_statuscodes).toEqual(["200-299"]);
    expect(m.notificationIDList).toEqual([3, 5]);
  });

  test("redacts secret fields but keeps empty ones and the push token", async () => {
    Object.assign(
      kuma.state.monitors.find((m) => m.id === 9)!,
      {
        pushToken: "visible-push-tok",
        basic_auth_pass: "fixture-hidden-1",
        oauth_client_secret: "fixture-hidden-2",
        tlsKey: "fixture-hidden-3",
        headers: '{"X-Auth":"fixture-hidden-4"}',
        body: '{"k":"fixture-hidden-5"}',
        mqttPassword: "fixture-hidden-6",
        radiusPassword: "fixture-hidden-7",
        radiusSecret: "fixture-hidden-8",
        databaseConnectionString: "postgres://u:fixture-hidden-9@db/x",
        basic_auth_user: "visible-user",
        tlsCert: "",
      },
    );
    const r = await run(sb, ["monitors", "get", "9"], creds(kuma.url));
    expect(r.code).toBe(0);
    for (let i = 1; i <= 9; i++) expect(r.stdout).not.toContain(`fixture-hidden-${i}`);
    const m = r.json();
    expect(m.basic_auth_pass).toBe("***");
    expect(m.databaseConnectionString).toBe("***");
    expect(m.pushToken).toBe("visible-push-tok");
    expect(m.basic_auth_user).toBe("visible-user");
    expect(m.tlsCert).toBe("");
  });

  test("redacts grpc fields and the secret parts of kafkaProducerSaslOptions", async () => {
    Object.assign(
      kuma.state.monitors.find((m) => m.id === 9)!,
      {
        grpcBody: '{"k":"fixture-hidden-g1"}',
        grpcMetadata: '{"m":"fixture-hidden-g2"}',
        kafkaProducerSaslOptions: {
          mechanism: "aws",
          username: "kuser",
          accessKeyId: "AKIDVISIBLE",
          awsRegion: "ap-northeast-1",
          secretAccessKey: "fixture-hidden-g3",
          sessionToken: "fixture-hidden-g4",
        },
      },
    );
    const r = await run(sb, ["monitors", "get", "9"], creds(kuma.url));
    expect(r.code).toBe(0);
    for (let i = 1; i <= 4; i++) expect(r.stdout).not.toContain(`fixture-hidden-g${i}`);
    const m = r.json();
    expect(m.grpcBody).toBe("***");
    expect(m.grpcMetadata).toBe("***");
    expect(m.kafkaProducerSaslOptions).toEqual({
      mechanism: "aws",
      username: "kuser",
      accessKeyId: "AKIDVISIBLE",
      awsRegion: "ap-northeast-1",
      secretAccessKey: "***",
      sessionToken: "***",
    });
  });

  test("get hides the password in the URL too", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.url =
      "https://u1:fixture-hidden-u2@x.example.com/";
    const r = await run(sb, ["monitors", "get", "7"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("fixture-hidden-u2");
    expect(r.json().url).toBe("https://u1:***@x.example.com/");
  });

  test("an empty secret field stays empty so the reader can tell it is unset", async () => {
    Object.assign(
      kuma.state.monitors.find((m) => m.id === 9)!,
      { basic_auth_pass: "", tlsKey: null },
    );
    const r = await run(sb, ["monitors", "get", "9"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().basic_auth_pass).toBe("");
    expect(r.json().tlsKey).toBeNull();
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "get", "404"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("404");
  });
});

describe("monitors add", () => {
  test("http: sends the UI defaults and prints the new monitor", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "new-site",
        "--url",
        "https://new.example.com",
        "--interval",
        "120",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 10, name: "new-site", type: "http", active: true });
    const [call] = addCalls();
    const sent = call!.args[0] as Record<string, any>;
    expect(sent.url).toBe("https://new.example.com");
    expect(sent.interval).toBe(120);
    expect(sent.method).toBe("GET");
    expect(sent.maxredirects).toBe(10);
    expect(sent.accepted_statuscodes).toEqual(["200-299"]);
    expect(sent.kafkaProducerBrokers).toEqual([]);
    expect(sent.kafkaProducerSaslOptions).toEqual({ mechanism: "None" });
    expect(sent.notificationIDList).toEqual({});
  });

  test("keyword: sends the keyword", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "keyword",
        "--name",
        "kw",
        "--url",
        "https://kw.example.com",
        "--keyword",
        "Welcome",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("keyword");
    expect(sent.keyword).toBe("Welcome");
  });

  test("json-query: sends jsonPath and expectedValue", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "relay",
        "--url",
        "https://api.example.com/relays",
        "--json-path",
        '$[hostname="jp-1"].active',
        "--expected-value",
        "true",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.jsonPath).toBe('$[hostname="jp-1"].active');
    expect(sent.expectedValue).toBe("true");
  });

  test("port: sends hostname and numeric port", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "port",
        "--name",
        "ssh",
        "--hostname",
        "10.0.0.5",
        "--port",
        "2222",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("10.0.0.5");
    expect(sent.port).toBe(2222);
  });

  test("push: puts a 32-char token in add itself and prints the push URL", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "cron-a"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.pushToken).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(out.pushUrl).toBe(`${kuma.url}/api/push/${out.pushToken}?status=up&msg=OK&ping=`);
    expect((addCalls()[0]!.args[0] as any).pushToken).toBe(out.pushToken);
    expect(kuma.calls.filter((c) => c.event === "editMonitor")).toHaveLength(0);
  });

  test("push: --push-token is used as given", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "cron-b", "--push-token", "given-token-123"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().pushToken).toBe("given-token-123");
  });

  test("--paused sends active false", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "later", "--paused"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().active).toBe(false);
    expect((addCalls()[0]!.args[0] as any).active).toBe(false);
  });

  test("--notifications-from copies an object-shaped list and --notification-id adds to it", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "push",
        "--name",
        "n1",
        "--notifications-from",
        "7",
        "--notification-id",
        "8",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).notificationIDList).toEqual({
      "3": true,
      "5": true,
      "8": true,
    });
  });

  test("--notifications-from copies a list-shaped notificationIDList as an object", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "n2", "--notifications-from", "2"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).notificationIDList).toEqual({ "4": true });
  });

  test("--proxy-id, --max-retries, --retry-interval, --resend-interval and --timeout are sent as numbers", async () => {
    kuma.state.proxies = [{ ...defaultProxy(), id: 4, default: 0 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "px",
        "--url",
        "https://px.example.com",
        "--proxy-id",
        "4",
        "--max-retries",
        "3",
        "--retry-interval",
        "30",
        "--resend-interval",
        "5",
        "--timeout",
        "20",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.proxyId).toBe(4);
    expect(sent.maxretries).toBe(3);
    expect(sent.retryInterval).toBe(30);
    expect(sent.resendInterval).toBe(5);
    expect(sent.timeout).toBe(20);
  });

  test("an exact same name exits 3 without sending add", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "Taba"],
      creds(kuma.url),
    );
    expect(r.code).toBe(3);
    expect(r.json()).toEqual({ id: 7, name: "Taba", skipped: true });
    expect(addCalls()).toHaveLength(0);
  });

  test("a name that only differs in case is added", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "taba"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(addCalls()).toHaveLength(1);
  });

  test.each([
    [["--type", "http", "--name", "x"], "--url"],
    [["--type", "keyword", "--name", "x", "--url", "https://x"], "--keyword"],
    [
      ["--type", "json-query", "--name", "x", "--url", "https://x", "--json-path", "$.a"],
      "--expected-value",
    ],
    [["--type", "port", "--name", "x", "--hostname", "h"], "--port"],
    [["--type", "dns", "--name", "x"], "--type"],
  ])("missing or bad options exit 2 before connecting: %p", async (args, word) => {
    const r = await run(sb, ["monitors", "add", ...args], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(word);
    expect(kuma.calls).toHaveLength(0);
  });

  test("adds default notifications and, for http, the default proxy like the UI", async () => {
    kuma.state.notifications = [
      { id: 6, name: "def", active: true, isDefault: true, userId: 1, config: "{}" },
      { id: 8, name: "other", active: true, isDefault: false, userId: 1, config: "{}" },
    ];
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "d1", "--url", "https://d1.example.com"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.notificationIDList).toEqual({ "6": true });
    expect(sent.proxyId).toBe(3);
  });

  test("push monitors get default notifications but no proxy", async () => {
    kuma.state.notifications = [
      { id: 6, name: "def", active: true, isDefault: true, userId: 1, config: "{}" },
    ];
    kuma.state.proxies = [defaultProxy()];
    const r = await run(sb, ["monitors", "add", "--type", "push", "--name", "d2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.notificationIDList).toEqual({ "6": true });
    expect(sent.proxyId).toBeNull();
  });

  test("retryInterval follows --interval and timeout is capped at 80% of it", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "fast",
        "--url",
        "https://f.example.com",
        "--interval",
        "30",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.retryInterval).toBe(30);
    expect(sent.timeout).toBe(24);
  });

  test("timeout stays 48 when 80% of --interval is larger", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "slow",
        "--url",
        "https://s.example.com",
        "--interval",
        "300",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.retryInterval).toBe(300);
    expect(sent.timeout).toBe(48);
  });

  test("an explicit --timeout is capped at 80% of the interval too", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "cap",
        "--url",
        "https://c.example.com",
        "--interval",
        "20",
        "--timeout",
        "30",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).timeout).toBe(16);
  });

  test.each([
    ["keyword", ["--url", "https://k.example.com", "--keyword", "ok"]],
    [
      "json-query",
      ["--url", "https://j.example.com", "--json-path", "$.a", "--expected-value", "1"],
    ],
  ])("%s monitors get the default proxy too", async (type, extra) => {
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      ["monitors", "add", "--type", type, "--name", `p-${type}`, ...extra],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).proxyId).toBe(3);
  });

  test("--proxy-id wins over the default proxy", async () => {
    kuma.state.proxies = [defaultProxy(), { ...defaultProxy(), id: 5, default: 0 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "px5",
        "--url",
        "https://x.example.com",
        "--proxy-id",
        "5",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).proxyId).toBe(5);
  });

  test("an empty Primary Base URL falls back to the CLI url", async () => {
    kuma.state.settings = { primaryBaseURL: "" };
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "pb0"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().pushUrl.startsWith(`${kuma.url}/api/push/`)).toBe(true);
  });

  test("pushUrl encodes the token as a path segment and add sends it unchanged", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "enc", "--push-token", "a#b/c"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().pushUrl).toBe(`${kuma.url}/api/push/a%23b%2Fc?status=up&msg=OK&ping=`);
    expect((addCalls()[0]!.args[0] as any).pushToken).toBe("a#b/c");
  });

  test("pushUrl uses the Primary Base URL setting when it is set", async () => {
    kuma.state.settings = { primaryBaseURL: "https://status.example.org/" };
    const r = await run(sb, ["monitors", "add", "--type", "push", "--name", "pb"], creds(kuma.url));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.pushUrl).toBe(
      `https://status.example.org/api/push/${out.pushToken}?status=up&msg=OK&ping=`,
    );
  });

  test.each([
    [["--type", "push", "--name", "x", "--push-token", ""], "--push-token"],
    [["--type", "push", "--name", "x", "--interval", ""], "--interval"],
    [["--type", "push", "--name", "x", "--max-retries", " "], "--max-retries"],
    [["--type", "push", "--name", "x", "--interval", "0"], "--interval"],
    [["--type", "push", "--name", "x", "--retry-interval", "-5"], "--retry-interval"],
    [["--type", "push", "--name", "x", "--max-retries", "1.5"], "--max-retries"],
    [["--type", "push", "--name", "x", "--resend-interval", "-1"], "--resend-interval"],
    [["--type", "push", "--name", "x", "--timeout", "-1"], "--timeout"],
    [["--type", "push", "--name", "x", "--notification-id", "0"], "--notification-id"],
  ])("empty or out-of-range values exit 2 before connecting: %p", async (args, word) => {
    const r = await run(sb, ["monitors", "add", ...args], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(word);
    expect(kuma.calls).toHaveLength(0);
  });

  test("Kuma's refusal exits 1 with its message", async () => {
    kuma.state.fail.add = "Invalid monitor";
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "bad"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid monitor");
  });

  test("ping: sends hostname and packetSize 56 by default", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "p1", "--hostname", "10.0.0.1"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("10.0.0.1");
    expect(sent.packetSize).toBe(56);
    expect(sent.port).toBeUndefined();
  });

  test("ping: --packet-size overrides the default", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "p2",
        "--hostname",
        "10.0.0.1",
        "--packet-size",
        "128",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).packetSize).toBe(128);
  });

  test("dns: sends hostname, resolver 1.1.1.1, type A and port 53", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "dns", "--name", "d1", "--hostname", "example.com"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("example.com");
    expect(sent.dns_resolve_server).toBe("1.1.1.1");
    expect(sent.dns_resolve_type).toBe("A");
    expect(sent.port).toBe(53);
  });

  test("dns: --dns-resolve-server, --dns-resolve-type and --port are sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "dns",
        "--name",
        "d2",
        "--hostname",
        "example.com",
        "--dns-resolve-server",
        "8.8.8.8",
        "--dns-resolve-type",
        "AAAA",
        "--port",
        "5353",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.dns_resolve_server).toBe("8.8.8.8");
    expect(sent.dns_resolve_type).toBe("AAAA");
    expect(sent.port).toBe(5353);
  });

  test("docker: sends docker_container and the docker_host id", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "ctr",
        "--docker-container",
        "web-1",
        "--docker-host",
        "2",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.docker_container).toBe("web-1");
    expect(sent.docker_host).toBe(2);
    expect(sent.hostname).toBeUndefined();
  });

  test("group: sends the common fields and no type-specific ones", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "group", "--name", "grp"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("group");
    expect(sent.name).toBe("grp");
    expect(sent.url).toBeNull();
    expect(sent.hostname).toBeUndefined();
    expect(sent.port).toBeUndefined();
  });

  test("steam: sends hostname and port", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "steam",
        "--name",
        "srv",
        "--hostname",
        "game.example.com",
        "--port",
        "27015",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("game.example.com");
    expect(sent.port).toBe(27015);
  });

  test("gamedig: sends hostname, port, game and gamedigGivenPortOnly", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "gamedig",
        "--name",
        "mc",
        "--hostname",
        "mc.example.com",
        "--port",
        "25565",
        "--game",
        "minecraft",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("mc.example.com");
    expect(sent.port).toBe(25565);
    expect(sent.game).toBe("minecraft");
    expect(sent.gamedigGivenPortOnly).toBe(true);
  });

  test("tailscale-ping: sends hostname only", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "tailscale-ping",
        "--name",
        "ts",
        "--hostname",
        "node.tailnet.ts.net",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("node.tailnet.ts.net");
    expect(sent.port).toBeUndefined();
  });

  test("grpc-keyword: sends the gRPC fields and reads --grpc-protobuf from a file", async () => {
    const proto = join(sb.dir, "health.proto");
    writeFileSync(
      proto,
      'syntax = "proto3";\n\nservice Health {\n  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);\n}\n',
    );
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "grpc1",
        "--grpc-url",
        "grpc.example.com:443",
        "--keyword",
        "SERVING",
        "--grpc-service-name",
        "Health",
        "--grpc-method",
        "check",
        "--grpc-protobuf",
        proto,
        "--grpc-enable-tls",
        "--invert-keyword",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("grpc-keyword");
    expect(sent.url).toBeNull();
    expect(sent.grpcUrl).toBe("grpc.example.com:443");
    expect(sent.keyword).toBe("SERVING");
    expect(sent.invertKeyword).toBe(true);
    expect(sent.grpcServiceName).toBe("Health");
    expect(sent.grpcMethod).toBe("check");
    expect(sent.grpcProtobuf).toContain("service Health");
    expect(sent.grpcEnableTls).toBe(true);
    expect(sent.grpcBody).toBe("{}");
  });

  test("grpc-keyword: grpcBody comes from --config-file when given", async () => {
    const proto = join(sb.dir, "health.proto");
    writeFileSync(proto, 'syntax = "proto3";\n');
    const f = join(sb.dir, "grpc.json");
    writeFileSync(f, JSON.stringify({ grpcBody: '{"k":"v"}' }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "grpc-body",
        "--grpc-url",
        "h:1",
        "--keyword",
        "k",
        "--grpc-service-name",
        "S",
        "--grpc-method",
        "m",
        "--grpc-protobuf",
        proto,
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).grpcBody).toBe('{"k":"v"}');
  });

  test("grpc-keyword: grpcEnableTls and invertKeyword stay unset without the flags", async () => {
    const proto = join(sb.dir, "health.proto");
    writeFileSync(proto, 'syntax = "proto3";\n');
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "grpc2",
        "--grpc-url",
        "grpc.example.com:443",
        "--keyword",
        "SERVING",
        "--grpc-service-name",
        "Health",
        "--grpc-method",
        "check",
        "--grpc-protobuf",
        proto,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.grpcEnableTls).toBeUndefined();
    expect(sent.invertKeyword).toBeUndefined();
    expect(sent.grpcBody).toBe("{}");
  });

  test("grpc-keyword: --set grpcProtobuf=null exits 2 before sending", async () => {
    const proto = join(sb.dir, "health.proto");
    writeFileSync(proto, 'syntax = "proto3";\n');
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "x",
        "--grpc-url",
        "h:1",
        "--keyword",
        "k",
        "--grpc-service-name",
        "S",
        "--grpc-method",
        "m",
        "--grpc-protobuf",
        proto,
        "--set",
        "grpcProtobuf=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("grpcProtobuf");
    expect(addCalls()).toHaveLength(0);
  });

  test.each([
    ["empty", ""],
    ["not JSON", "not json"],
    ["null", null],
  ])("grpc-keyword: --config-file grpcBody=%s exits 2 before sending", async (_l, body) => {
    const proto = join(sb.dir, "p.proto");
    writeFileSync(proto, 'syntax = "proto3";\n');
    const f = join(sb.dir, "grpc.json");
    writeFileSync(f, JSON.stringify({ grpcBody: body }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "x",
        "--grpc-url",
        "h:1",
        "--keyword",
        "k",
        "--grpc-service-name",
        "S",
        "--grpc-method",
        "m",
        "--grpc-protobuf",
        proto,
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("grpcBody");
    expect(addCalls()).toHaveLength(0);
  });

  test("keyword: --invert-keyword is sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "keyword",
        "--name",
        "kw-inv",
        "--url",
        "https://kw.example.com",
        "--keyword",
        "Welcome",
        "--invert-keyword",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).invertKeyword).toBe(true);
  });

  test("real-browser: sends the url like http", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "real-browser",
        "--name",
        "rb1",
        "--url",
        "https://rb.example.com",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("real-browser");
    expect(sent.url).toBe("https://rb.example.com");
  });

  test("mqtt: sends hostname, port, topic and the optional fields", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "mqtt",
        "--name",
        "mq1",
        "--hostname",
        "mqtt.example.com",
        "--port",
        "1883",
        "--mqtt-topic",
        "sensors/#",
        "--mqtt-username",
        "u1",
        "--mqtt-success-message",
        "ok",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("mqtt.example.com");
    expect(sent.port).toBe(1883);
    expect(sent.mqttTopic).toBe("sensors/#");
    expect(sent.mqttUsername).toBe("u1");
    expect(sent.mqttSuccessMessage).toBe("ok");
    expect(sent.mqttPassword).toBe("");
  });

  test("mqtt: the optional fields stay at the UI defaults without the flags", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "mqtt",
        "--name",
        "mq2",
        "--hostname",
        "mqtt.example.com",
        "--port",
        "1883",
        "--mqtt-topic",
        "t",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.mqttUsername).toBe("");
    expect(sent.mqttPassword).toBe("");
    expect(sent.mqttSuccessMessage).toBe("");
  });

  test("kafka-producer: sends brokers, topic, message and the optional flags", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "kafka-producer",
        "--name",
        "kf1",
        "--kafka-producer-broker",
        "kafka1:9092",
        "--kafka-producer-broker",
        "kafka2:9093",
        "--kafka-producer-topic",
        "uptime",
        "--kafka-producer-message",
        "ping",
        "--kafka-producer-ssl",
        "--kafka-producer-allow-auto-topic-creation",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("kafka-producer");
    expect(sent.kafkaProducerBrokers).toEqual(["kafka1:9092", "kafka2:9093"]);
    expect(sent.kafkaProducerTopic).toBe("uptime");
    expect(sent.kafkaProducerMessage).toBe("ping");
    expect(sent.kafkaProducerSsl).toBe(true);
    expect(sent.kafkaProducerAllowAutoTopicCreation).toBe(true);
    expect(sent.kafkaProducerSaslOptions).toEqual({ mechanism: "None" });
  });

  test("kafka-producer: ssl and auto-topic-creation stay false without the flags", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "kafka-producer",
        "--name",
        "kf2",
        "--kafka-producer-broker",
        "kafka1:9092",
        "--kafka-producer-topic",
        "uptime",
        "--kafka-producer-message",
        "ping",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.kafkaProducerSsl).toBe(false);
    expect(sent.kafkaProducerAllowAutoTopicCreation).toBe(false);
    expect(sent.kafkaProducerSaslOptions).toEqual({ mechanism: "None" });
  });

  test("kafka-producer: SASL options come from --config-file", async () => {
    const f = join(sb.dir, "kafka.json");
    writeFileSync(
      f,
      JSON.stringify({
        kafkaProducerSaslOptions: { mechanism: "plain", username: "u", password: "p" },
      }),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "kafka-producer",
        "--name",
        "kf3",
        "--kafka-producer-broker",
        "kafka1:9092",
        "--kafka-producer-topic",
        "uptime",
        "--kafka-producer-message",
        "ping",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.kafkaProducerSaslOptions).toEqual({
      mechanism: "plain",
      username: "u",
      password: "p",
    });
  });

  test.each([
    ["null", { kafkaProducerSaslOptions: null }, "must be an object"],
    ["a string", { kafkaProducerSaslOptions: "x" }, "must be an object"],
    ["an array", { kafkaProducerSaslOptions: ["plain"] }, "must be an object"],
    ["no mechanism", { kafkaProducerSaslOptions: {} }, "mechanism must be one of"],
    [
      "a bad mechanism",
      { kafkaProducerSaslOptions: { mechanism: "oauth" } },
      "mechanism must be one of",
    ],
  ])(
    "kafka-producer: SASL options as %s exits 2 before connecting",
    async (_label, config, word) => {
      const f = join(sb.dir, "kafka-sasl.json");
      writeFileSync(f, JSON.stringify(config));
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "kafka-producer",
          "--name",
          "x",
          "--kafka-producer-broker",
          "kafka1:9092",
          "--kafka-producer-topic",
          "t",
          "--kafka-producer-message",
          "m",
          "--config-file",
          f,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("kafkaProducerSaslOptions");
      expect(r.stderr).toContain(word);
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test.each([
    "kafka1",
    "h:abc",
    "h:0",
    "h:70000",
    ":1",
    "h:",
    "::1:9092",
    "[::1]:9092",
    "a:1:2",
    "h:1e3",
  ])(
    "kafka-producer: broker %s that is not host:port exits 2 before connecting",
    async (broker) => {
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "kafka-producer",
          "--name",
          "x",
          "--kafka-producer-broker",
          broker,
          "--kafka-producer-topic",
          "t",
          "--kafka-producer-message",
          "m",
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--kafka-producer-broker");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("kafka-producer: a hatch broker overrides the flag and a bad one exits 2", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "k:9092",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
        "--set",
        'kafkaProducerBrokers=["nohost"]',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("kafkaProducerBrokers");
    expect(r.stderr).toContain("host:port");
    expect(kuma.calls).toHaveLength(0);
  });

  test("radius: sends hostname, the 1812 default port and the station ids", async () => {
    const f = join(sb.dir, "radius.json");
    writeFileSync(f, JSON.stringify({ radiusPassword: "pw", radiusSecret: "sec" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "rad1",
        "--hostname",
        "radius.example.com",
        "--radius-username",
        "user1",
        "--radius-called-station-id",
        "00-11-22",
        "--radius-calling-station-id",
        "aa-bb-cc",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("radius");
    expect(sent.hostname).toBe("radius.example.com");
    expect(sent.port).toBe(1812);
    expect(sent.radiusUsername).toBe("user1");
    expect(sent.radiusPassword).toBe("pw");
    expect(sent.radiusSecret).toBe("sec");
    expect(sent.radiusCalledStationId).toBe("00-11-22");
    expect(sent.radiusCallingStationId).toBe("aa-bb-cc");
  });

  test("radius: --port overrides the 1812 default", async () => {
    const f = join(sb.dir, "radius.json");
    writeFileSync(f, JSON.stringify({ radiusPassword: "pw", radiusSecret: "sec" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "rad2",
        "--hostname",
        "radius.example.com",
        "--port",
        "1813",
        "--radius-username",
        "user1",
        "--radius-called-station-id",
        "c",
        "--radius-calling-station-id",
        "d",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).port).toBe(1813);
  });

  test("radius: --port abc exits 2 before connecting", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "abc",
        "--radius-username",
        "u",
        "--radius-called-station-id",
        "c",
        "--radius-calling-station-id",
        "d",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--port");
    expect(kuma.calls).toHaveLength(0);
  });

  test("radius: missing the config-file secrets exits 2 before sending", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "x",
        "--hostname",
        "h",
        "--radius-username",
        "u",
        "--radius-called-station-id",
        "c",
        "--radius-calling-station-id",
        "d",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("radiusPassword");
    expect(addCalls()).toHaveLength(0);
  });

  test("radius: --config-file with radiusPassword but no radiusSecret exits 2", async () => {
    const f = join(sb.dir, "radius.json");
    writeFileSync(f, JSON.stringify({ radiusPassword: "pw" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "x",
        "--hostname",
        "h",
        "--radius-username",
        "u",
        "--radius-called-station-id",
        "c",
        "--radius-calling-station-id",
        "d",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("radiusSecret");
    expect(addCalls()).toHaveLength(0);
  });

  test.each(["radiusCalledStationId", "radiusCallingStationId"])(
    "radius: --set %s=null exits 2 even with the secrets in --config-file",
    async (field) => {
      const f = join(sb.dir, "radius.json");
      writeFileSync(f, JSON.stringify({ radiusPassword: "pw", radiusSecret: "sec" }));
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "radius",
          "--name",
          "x",
          "--hostname",
          "h",
          "--radius-username",
          "u",
          "--radius-called-station-id",
          "c",
          "--radius-calling-station-id",
          "d",
          "--config-file",
          f,
          "--set",
          `${field}=null`,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(field);
      expect(addCalls()).toHaveLength(0);
    },
  );

  test("--grpc-protobuf with a missing file exits 2 before connecting", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "grpc-keyword",
        "--name",
        "x",
        "--grpc-url",
        "h:1",
        "--keyword",
        "k",
        "--grpc-service-name",
        "S",
        "--grpc-method",
        "m",
        "--grpc-protobuf",
        join(sb.dir, "nope.proto"),
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--grpc-protobuf");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([
    [["--type", "ping", "--name", "x"], "--hostname"],
    [["--type", "dns", "--name", "x"], "--hostname"],
    [["--type", "docker", "--name", "x"], "--docker-container"],
    [["--type", "docker", "--name", "x", "--docker-container", "c"], "--docker-host"],
    [["--type", "steam", "--name", "x", "--hostname", "h"], "--port"],
    [["--type", "steam", "--name", "x", "--port", "1"], "--hostname"],
    [["--type", "gamedig", "--name", "x", "--hostname", "h", "--port", "1"], "--game"],
    [["--type", "gamedig", "--name", "x", "--hostname", "h", "--game", "g"], "--port"],
    [["--type", "tailscale-ping", "--name", "x"], "--hostname"],
    [["--type", "real-browser", "--name", "x"], "--url"],
    [["--type", "grpc-keyword", "--name", "x"], "--keyword"],
    [["--type", "grpc-keyword", "--name", "x", "--keyword", "k"], "--grpc-url"],
    [
      ["--type", "grpc-keyword", "--name", "x", "--keyword", "k", "--grpc-url", "h:1"],
      "--grpc-service-name",
    ],
    [
      [
        "--type",
        "grpc-keyword",
        "--name",
        "x",
        "--keyword",
        "k",
        "--grpc-url",
        "h:1",
        "--grpc-service-name",
        "S",
      ],
      "--grpc-method",
    ],
    [
      [
        "--type",
        "grpc-keyword",
        "--name",
        "x",
        "--keyword",
        "k",
        "--grpc-url",
        "h:1",
        "--grpc-service-name",
        "S",
        "--grpc-method",
        "m",
      ],
      "--grpc-protobuf",
    ],
    [["--type", "mqtt", "--name", "x"], "--hostname"],
    [["--type", "mqtt", "--name", "x", "--hostname", "h"], "--port"],
    [["--type", "mqtt", "--name", "x", "--hostname", "h", "--port", "1883"], "--mqtt-topic"],
    [["--type", "kafka-producer", "--name", "x"], "--kafka-producer-broker"],
    [
      ["--type", "kafka-producer", "--name", "x", "--kafka-producer-broker", "h:1"],
      "--kafka-producer-topic",
    ],
    [
      [
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "h:1",
        "--kafka-producer-topic",
        "t",
      ],
      "--kafka-producer-message",
    ],
    [["--type", "radius", "--name", "x"], "--hostname"],
    [["--type", "radius", "--name", "x", "--hostname", "h"], "--radius-username"],
    [
      ["--type", "radius", "--name", "x", "--hostname", "h", "--radius-username", "u"],
      "--radius-called-station-id",
    ],
    [
      [
        "--type",
        "radius",
        "--name",
        "x",
        "--hostname",
        "h",
        "--radius-username",
        "u",
        "--radius-called-station-id",
        "c",
      ],
      "--radius-calling-station-id",
    ],
  ])("missing required options exit 2 before connecting: %p", async (args, word) => {
    const r = await run(sb, ["monitors", "add", ...args], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(word);
    expect(kuma.calls).toHaveLength(0);
  });

  test("--type docker without --docker-host exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "docker", "--name", "x", "--docker-container", "c"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type docker requires --docker-host");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--set beats --config-file which beats typed flags which beat the defaults", async () => {
    const f = join(sb.dir, "add.json");
    writeFileSync(f, JSON.stringify({ interval: 90, maxretries: 7, resendInterval: 5 }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "prec",
        "--url",
        "https://p.example.com",
        "--interval",
        "120",
        "--max-retries",
        "9",
        "--resend-interval",
        "8",
        "--config-file",
        f,
        "--set",
        "interval=45",
        "--set",
        "maxretries=2",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(45);
    expect(sent.maxretries).toBe(2);
    expect(sent.resendInterval).toBe(5);
  });

  test("--set with a key that is not a monitor field exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--set", "bogus=1"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bogus");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--config-file with a key that is not a monitor field exits 2 before connecting", async () => {
    const f = join(sb.dir, "bad.json");
    writeFileSync(f, JSON.stringify({ bogus: 1 }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bogus");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([["id=1"], ["type=ping"], ["name=other"]])(
    "--set %s is refused before connecting",
    async (set) => {
      const r = await run(
        sb,
        ["monitors", "add", "--type", "push", "--name", "x", "--set", set],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(set.split("=")[0]!);
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("--config-file cannot set type", async () => {
    const f = join(sb.dir, "typed.json");
    writeFileSync(f, JSON.stringify({ type: "ping" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("type");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([
    ["basic_auth_pass=x"],
    ["oauth_client_secret=x"],
    ["tlsKey=x"],
    ["headers=x"],
    ["body=x"],
    ["grpcBody=x"],
    ["grpcMetadata=x"],
    ["mqttPassword=x"],
    ["radiusPassword=x"],
    ["radiusSecret=x"],
    ["databaseConnectionString=x"],
    ["kafkaProducerSaslOptions={}"],
  ])("--set %s would put a secret in argv and exits 2", async (set) => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--set", set],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("a secret field is accepted through --config-file", async () => {
    const f = join(sb.dir, "sec.json");
    writeFileSync(f, JSON.stringify({ mqttPassword: "cfg-secret-value" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "sec",
        "--url",
        "https://s.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).mqttPassword).toBe("cfg-secret-value");
  });

  test("--parent sends an existing group id", async () => {
    kuma.state.monitors.push(group(20, "grp"));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "child",
        "--hostname",
        "127.0.0.1",
        "--parent",
        "20",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).parent).toBe(20);
  });

  test("--parent rejects a monitor that is not a group", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "c2", "--hostname", "h", "--parent", "7"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 7 is not a group");
    expect(addCalls()).toHaveLength(0);
  });

  test("--parent rejects an unknown monitor id", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "c3", "--hostname", "h", "--parent", "404"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 404 not found");
    expect(addCalls()).toHaveLength(0);
  });

  test("add --parent with --set parent exits 2 before connecting", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "x",
        "--hostname",
        "h",
        "--parent",
        "20",
        "--set",
        "parent=21",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add --parent with --config-file parent exits 2 before connecting", async () => {
    const f = join(sb.dir, "add-parent-cfg.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "x",
        "--hostname",
        "h",
        "--parent",
        "20",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
    expect(kuma.calls).toHaveLength(0);
  });

  test("a new monitor type gets the default proxy the UI assigns on add", async () => {
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "pp", "--hostname", "h"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).proxyId).toBe(3);
  });

  test("port monitors still get no default proxy", async () => {
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      ["monitors", "add", "--type", "port", "--name", "pt", "--hostname", "h", "--port", "22"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).proxyId).toBeNull();
  });

  test.each([['pushToken=""'], ["pushToken=null"], ["pushToken=123"], ["pushToken=false"]])(
    "push --set %s exits 2 before connecting",
    async (set) => {
      const r = await run(
        sb,
        ["monitors", "add", "--type", "push", "--name", "x", "--set", set],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("pushToken");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("push --config-file with an empty pushToken exits 2 before connecting", async () => {
    const f = join(sb.dir, "pt.json");
    writeFileSync(f, JSON.stringify({ pushToken: "" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pushToken");
    expect(kuma.calls).toHaveLength(0);
  });

  test("push: the printed pushToken and pushUrl use the merged value that was sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "push",
        "--name",
        "x",
        "--push-token",
        "flag-tok",
        "--set",
        'pushToken="set-tok"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).pushToken).toBe("set-tok");
    const out = r.json();
    expect(out.pushToken).toBe("set-tok");
    expect(out.pushUrl).toContain("set-tok");
  });

  test("push: --config-file pushToken is sent and printed", async () => {
    const f = join(sb.dir, "pt2.json");
    writeFileSync(f, JSON.stringify({ pushToken: "cfg-tok" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).pushToken).toBe("cfg-tok");
    expect(r.json().pushToken).toBe("cfg-tok");
  });

  test("add --set parent as a numeric string is sent as a number", async () => {
    kuma.state.monitors.push(group(20, "grp"));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "c",
        "--hostname",
        "h",
        "--set",
        'parent="20"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).parent).toBe(20);
  });

  test.each([['parent=""'], ["parent=abc"], ["parent=-1"], ["parent=1.5"]])(
    "add --set %s exits 2 before connecting",
    async (set) => {
      const r = await run(
        sb,
        ["monitors", "add", "--type", "ping", "--name", "x", "--hostname", "h", "--set", set],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("parent");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("add --set parent as a JSON empty string names the empty-string error", async () => {
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "x", "--hostname", "h", "--set", 'parent=""'],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent must not be an empty string");
    expect(kuma.calls).toHaveLength(0);
  });

  test("retryInterval and the timeout cap derive from the final interval", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "iv",
        "--url",
        "https://i.example.com",
        "--interval",
        "120",
        "--set",
        "interval=30",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(30);
    expect(sent.retryInterval).toBe(30);
    expect(sent.timeout).toBe(24);
  });

  test("explicit retryInterval and timeout are kept; the cap uses the final interval", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "iv2",
        "--url",
        "https://i2.example.com",
        "--interval",
        "20",
        "--timeout",
        "30",
        "--set",
        "interval=100",
        "--set",
        "retryInterval=10",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(100);
    expect(sent.retryInterval).toBe(10);
    expect(sent.timeout).toBe(30);
  });

  test("--config-file interval drives the derived values too", async () => {
    const f = join(sb.dir, "iv.json");
    writeFileSync(f, JSON.stringify({ interval: 45 }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "iv3",
        "--url",
        "https://i3.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(45);
    expect(sent.retryInterval).toBe(45);
    expect(sent.timeout).toBe(36);
  });

  test("docker: an unknown --docker-host exits 1 before add", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "ctr2",
        "--docker-container",
        "web-1",
        "--docker-host",
        "9",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host 9 not found");
    expect(addCalls()).toHaveLength(0);
  });

  test("a hatch docker_host is checked against the pushed dockerHostList", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        "docker_host=9",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host 9 not found");
    expect(addCalls()).toHaveLength(0);
  });

  test("a hatch docker_host in the list is sent", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        "docker_host=2",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).docker_host).toBe(2);
  });

  test.each([
    ["interval=abc"],
    ["interval=0"],
    ["interval=-5"],
    ["retryInterval=abc"],
    ["resendInterval=1.5"],
    ["maxretries=-1"],
    ["timeout=0"],
    ["timeout=-1"],
    ["port=70000"],
    ["port=abc"],
    ["port=[80]"],
    ["packetSize=0"],
    ["packetSize=1.5"],
    ["proxyId=abc"],
    ["proxyId=0"],
    ["dns_resolve_type=BOGUS"],
    ["docker_host=abc"],
    ["accepted_statuscodes=200-299"],
    ['accepted_statuscodes=["200-299",404]'],
    ['kafkaProducerBrokers="a:9092"'],
  ])("monitors add --set %s exits 2 before connecting", async (set) => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        set,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`${set.split("=")[0]!} must`);
    expect(kuma.calls).toHaveLength(0);
  });

  test("hatch values for typed-flag keys are coerced like the flags", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        'interval="30"',
        "--set",
        'port="8080"',
        "--set",
        'maxretries="4"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(30);
    expect(sent.port).toBe(8080);
    expect(sent.maxretries).toBe(4);
  });

  test("--config-file values get the same validation", async () => {
    const f = join(sb.dir, "badval.json");
    writeFileSync(f, JSON.stringify({ interval: "abc" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interval");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an unknown --type exits 2 with the choices error before connecting", async () => {
    const r = await run(sb, ["monitors", "add", "--type", "nope", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nope");
    expect(r.stderr).toContain("choices");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--set active=false is merged into the sent monitor and the output", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "act",
        "--url",
        "https://a.example.com",
        "--set",
        "active=false",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).active).toBe(false);
    expect(r.json().active).toBe(false);
  });

  test("--config-file active=false is merged into the sent monitor and the output", async () => {
    const f = join(sb.dir, "act.json");
    writeFileSync(f, JSON.stringify({ active: false }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "act2",
        "--url",
        "https://a2.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).active).toBe(false);
    expect(r.json().active).toBe(false);
  });

  test.each([
    ["notificationIDList=[null]"],
    ["notificationIDList=5"],
    ['notificationIDList={"a":true}'],
  ])("monitors add --set %s exits 2 before connecting", async (set) => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        set,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("notificationIDList");
    expect(kuma.calls).toHaveLength(0);
  });

  test("monitors add --config-file with a bad notificationIDList exits 2 before connecting", async () => {
    const f = join(sb.dir, "nid.json");
    writeFileSync(f, JSON.stringify({ notificationIDList: ["x"] }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("notificationIDList");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add --config-file parent as a numeric string is sent as a number", async () => {
    kuma.state.monitors.push(group(21, "g21"));
    const f = join(sb.dir, "parent.json");
    writeFileSync(f, JSON.stringify({ parent: "21" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "pc", "--hostname", "h", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).parent).toBe(21);
  });

  test("--interval flag loses to --set interval for the derived values", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "iv4",
        "--url",
        "https://i4.example.com",
        "--interval",
        "120",
        "--set",
        "interval=45",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(45);
    expect(sent.retryInterval).toBe(45);
    expect(sent.timeout).toBe(36);
  });

  test("an explicit --retry-interval is kept when --set changes the interval", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "iv5",
        "--url",
        "https://i5.example.com",
        "--interval",
        "120",
        "--retry-interval",
        "30",
        "--set",
        "interval=45",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(45);
    expect(sent.retryInterval).toBe(30);
    expect(sent.timeout).toBe(36);
  });

  test("--config-file basic_auth_pass is a real column and is sent", async () => {
    const f = join(sb.dir, "ba.json");
    writeFileSync(f, JSON.stringify({ basic_auth_user: "u", basic_auth_pass: "cfg-bp" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "ba",
        "--url",
        "https://ba.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.basic_auth_user).toBe("u");
    expect(sent.basic_auth_pass).toBe("cfg-bp");
  });

  test("docker: --set docker_host=null names the hatch source", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "dnull",
        "--docker-container",
        "c",
        "--docker-host",
        "2",
        "--set",
        "docker_host=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--set docker_host must be a docker host id");
    expect(kuma.calls).toHaveLength(0);
  });

  test("docker: --config-file docker_host=null names the hatch source", async () => {
    const f = join(sb.dir, "dnull.json");
    writeFileSync(f, JSON.stringify({ docker_host: null }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "dnull2",
        "--docker-container",
        "c",
        "--docker-host",
        "2",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file docker_host must be a docker host id");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--set proxyId=null opts out of the default proxy", async () => {
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "np",
        "--url",
        "https://np.example.com",
        "--set",
        "proxyId=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).proxyId).toBeNull();
  });

  test("--set docker_host=null on a non-docker type is sent as null", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "dh",
        "--url",
        "https://dh.example.com",
        "--set",
        "docker_host=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).docker_host).toBeNull();
  });

  test("--set timeout=0 exits 2: Kuma 1.23 turns it into interval × 800 seconds", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "t0",
        "--url",
        "https://t0.example.com",
        "--set",
        "timeout=0",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Kuma 1.23 turns 0 into interval × 800 seconds");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--timeout 0 exits 2 with the same Kuma 1.23 reason", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "t1",
        "--url",
        "https://t1.example.com",
        "--timeout",
        "0",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Kuma 1.23 turns 0 into interval × 800 seconds");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([[["--timeout", ""]], [["--timeout", "abc"]], [["--set", 'timeout="abc"']]])(
    "a non-numeric timeout exits 2 before connecting: %p",
    async (extra) => {
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "http",
          "--name",
          "x",
          "--url",
          "https://x.example.com",
          ...extra,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timeout must");
      expect(r.stderr).toContain("Kuma 1.23 turns 0 into interval × 800 seconds");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("ping: --set hostname=null exits 2 before sending add", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "x",
        "--hostname",
        "h",
        "--set",
        "hostname=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname");
    expect(addCalls()).toHaveLength(0);
  });

  test("ping: --config-file hostname null exits 2 before sending add", async () => {
    const f = join(sb.dir, "hn.json");
    writeFileSync(f, JSON.stringify({ hostname: null }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "x", "--hostname", "h", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname");
    expect(addCalls()).toHaveLength(0);
  });

  test("docker: --set docker_container empty exits 2 before sending add", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "x",
        "--docker-container",
        "c",
        "--docker-host",
        "2",
        "--set",
        'docker_container=""',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docker_container");
    expect(addCalls()).toHaveLength(0);
  });

  test("docker: --config-file docker_container empty exits 2 before sending add", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const f = join(sb.dir, "dc.json");
    writeFileSync(f, JSON.stringify({ docker_container: "" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "docker",
        "--name",
        "x",
        "--docker-container",
        "c",
        "--docker-host",
        "2",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docker_container");
    expect(addCalls()).toHaveLength(0);
  });

  test("--set proxyId naming an unknown proxy exits 1 before sending add", async () => {
    kuma.state.proxies = [defaultProxy()];
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        "proxyId=9",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("proxy 9 not found");
    expect(addCalls()).toHaveLength(0);
  });

  test("http: --set url=null exits 2 before sending add", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        "url=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("url must be a non-empty string");
    expect(addCalls()).toHaveLength(0);
  });

  test("http: --config-file url empty exits 2 before sending add", async () => {
    const f = join(sb.dir, "ue.json");
    writeFileSync(f, JSON.stringify({ url: "" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("url must be a non-empty string");
    expect(addCalls()).toHaveLength(0);
  });

  test("port: --set port=null exits 2 before sending add", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "port",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "80",
        "--set",
        "port=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port must");
    expect(addCalls()).toHaveLength(0);
  });

  test("gamedig: --set game empty exits 2 before sending add", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "gamedig",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1",
        "--game",
        "minecraft",
        "--set",
        'game=""',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("game must be a non-empty string");
    expect(addCalls()).toHaveLength(0);
  });

  test.each([
    [
      [
        "--type",
        "keyword",
        "--name",
        "x",
        "--url",
        "https://x",
        "--keyword",
        "k",
        "--set",
        "keyword=null",
      ],
      "keyword",
    ],
    [
      [
        "--type",
        "json-query",
        "--name",
        "x",
        "--url",
        "https://x",
        "--json-path",
        "$.a",
        "--expected-value",
        "1",
        "--set",
        "jsonPath=null",
      ],
      "jsonPath",
    ],
    [
      [
        "--type",
        "json-query",
        "--name",
        "x",
        "--url",
        "https://x",
        "--json-path",
        "$.a",
        "--expected-value",
        "1",
        "--set",
        "expectedValue=null",
      ],
      "expectedValue",
    ],
    [
      [
        "--type",
        "port",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "80",
        "--set",
        "hostname=null",
      ],
      "hostname",
    ],
    [
      [
        "--type",
        "steam",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1",
        "--set",
        "hostname=null",
      ],
      "hostname",
    ],
    [
      [
        "--type",
        "gamedig",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1",
        "--game",
        "minecraft",
        "--set",
        "hostname=null",
      ],
      "hostname",
    ],
    [
      ["--type", "tailscale-ping", "--name", "x", "--hostname", "h", "--set", "hostname=null"],
      "hostname",
    ],
    [
      ["--type", "steam", "--name", "x", "--hostname", "h", "--port", "1", "--set", "port=null"],
      "port must",
    ],
    [
      [
        "--type",
        "gamedig",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1",
        "--game",
        "minecraft",
        "--set",
        "port=null",
      ],
      "port must",
    ],
    [
      ["--type", "dns", "--name", "x", "--hostname", "h", "--set", "dns_resolve_server=null"],
      "dns_resolve_server",
    ],
    [
      ["--type", "dns", "--name", "x", "--hostname", "h", "--set", 'dns_resolve_server=""'],
      "dns_resolve_server",
    ],
    [
      [
        "--type",
        "mqtt",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1883",
        "--mqtt-topic",
        "t",
        "--set",
        "mqttTopic=null",
      ],
      "mqttTopic",
    ],
    [
      [
        "--type",
        "mqtt",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1883",
        "--mqtt-topic",
        "t",
        "--set",
        "hostname=null",
      ],
      "hostname",
    ],
    [
      [
        "--type",
        "mqtt",
        "--name",
        "x",
        "--hostname",
        "h",
        "--port",
        "1883",
        "--mqtt-topic",
        "t",
        "--set",
        "port=null",
      ],
      "port must",
    ],
    [
      ["--type", "real-browser", "--name", "x", "--url", "https://x", "--set", "url=null"],
      "url must be a non-empty string",
    ],
    [
      [
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "h:1",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
        "--set",
        "kafkaProducerTopic=null",
      ],
      "kafkaProducerTopic",
    ],
    [
      [
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "h:1",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
        "--set",
        "kafkaProducerMessage=null",
      ],
      "kafkaProducerMessage",
    ],
    [
      [
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "h:1",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
        "--set",
        "kafkaProducerBrokers=null",
      ],
      "kafkaProducerBrokers",
    ],
    [
      [
        "--type",
        "kafka-producer",
        "--name",
        "x",
        "--kafka-producer-broker",
        "h:1",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
        "--set",
        "kafkaProducerBrokers=[]",
      ],
      "kafkaProducerBrokers",
    ],
    [
      [
        "--type",
        "radius",
        "--name",
        "x",
        "--hostname",
        "h",
        "--radius-username",
        "u",
        "--radius-called-station-id",
        "c",
        "--radius-calling-station-id",
        "d",
        "--set",
        "radiusUsername=null",
      ],
      "radiusUsername",
    ],
  ])("a hatch-nulled required field exits 2 before sending add: %p", async (extra, field) => {
    const r = await run(sb, ["monitors", "add", ...extra], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(field);
    expect(addCalls()).toHaveLength(0);
  });

  test.each(["grpcUrl", "grpcServiceName", "grpcMethod", "keyword"])(
    "grpc-keyword: --set %s=null exits 2 even with --grpc-protobuf",
    async (field) => {
      const proto = join(sb.dir, "p.proto");
      writeFileSync(proto, 'syntax = "proto3";\n');
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "grpc-keyword",
          "--name",
          "x",
          "--grpc-url",
          "h:1",
          "--keyword",
          "k",
          "--grpc-service-name",
          "S",
          "--grpc-method",
          "m",
          "--grpc-protobuf",
          proto,
          "--set",
          `${field}=null`,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(field);
      expect(addCalls()).toHaveLength(0);
    },
  );

  test.each([[["--interval", "19"]], [["--interval", "2073601"]], [["--set", "interval=19"]]])(
    "an interval outside Kuma's 20..2073600 bounds exits 2: %p",
    async (extra) => {
      const r = await run(
        sb,
        [
          "monitors",
          "add",
          "--type",
          "http",
          "--name",
          "x",
          "--url",
          "https://x.example.com",
          ...extra,
        ],
        creds(kuma.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("interval must be between 20 and 2073600");
      expect(addCalls()).toHaveLength(0);
    },
  );

  test("--interval 20 is accepted", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--interval",
        "20",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls()[0]!.args[0] as any).interval).toBe(20);
  });

  test('--expected-value "" exits 2 before connecting', async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--json-path",
        "$.a",
        "--expected-value",
        "",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expectedValue must be a non-empty string");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add --type http with dns_resolve_server null is sent: only dns requires it", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "x",
        "--url",
        "https://x.example.com",
        "--set",
        "dns_resolve_server=null",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls()[0]!.args[0] as Record<string, any>;
    expect(sent.dns_resolve_server).toBeNull();
  });
});

describe("monitors edit", () => {
  test("applies --set over getMonitor and sends notificationIDList as an object", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "name=Taba web",
        "--set",
        "maxretries=2",
        "--set",
        "notificationIDList=[3]",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.id).toBe(7);
    expect(sent.name).toBe("Taba web");
    expect(sent.maxretries).toBe(2);
    expect(sent.url).toBe("https://Taba.example.com");
    expect(sent.notificationIDList).toEqual({ "3": true });
    const out = r.json();
    expect(out.name).toBe("Taba web");
    expect(out.notificationIDList).toEqual([3]);
  });

  test("a value that is not JSON stays a string", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "2", "--set", "url=https://dav2.example.com/x?y=1"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.url).toBe("https://dav2.example.com/x?y=1");
    expect(sent.notificationIDList).toEqual({ "4": true });
  });

  test.each([
    ["notificationIDList=[null]"],
    ['notificationIDList=["x"]'],
    ["notificationIDList=[-1]"],
    ["notificationIDList=[1.5]"],
    ['notificationIDList={"a":true}'],
    ['notificationIDList={"0":true}'],
  ])("a notificationIDList with a non-id entry exits 2 before connecting: %s", async (set) => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", set], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("notificationIDList");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--set without = exits 2", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "name"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "edit", "404", "--set", "name=x"], creds(kuma.url));
    expect(r.code).toBe(1);
  });

  test("prints what Kuma saved, not the local merge", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "active=false"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().active).toBe(true);
  });

  test.each([["parent=7"], ['parent="7"']])(
    "making a monitor its own parent is refused before connecting: %s",
    async (set) => {
      const r = await run(sb, ["monitors", "edit", "7", "--set", set], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("parent");
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("--set parent naming a group is sent", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const r = await run(sb, ["monitors", "edit", "7", "--set", "parent=20"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect((kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as any).parent).toBe(20);
  });

  test("--set id is refused before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "id=2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("id");
    expect(kuma.calls).toHaveLength(0);
  });

  test("redacts secrets in the printed monitor", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.basic_auth_pass = "fixture-hidden-e1";
    const r = await run(sb, ["monitors", "edit", "7", "--set", "maxretries=1"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("fixture-hidden-e1");
    expect(r.json().basic_auth_pass).toBe("***");
  });

  test("--config-file merges into the monitor below --set", async () => {
    const f = join(sb.dir, "edit.json");
    writeFileSync(f, JSON.stringify({ maxretries: 5, name: "from-file" }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "maxretries=2"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.maxretries).toBe(2);
    expect(sent.name).toBe("from-file");
    expect(r.json().name).toBe("from-file");
  });

  test("--parent cannot be combined with --set and --config-file parent", async () => {
    kuma.state.monitors.push(group(20, "g20"), group(21, "g21"), group(22, "g22"));
    const f = join(sb.dir, "edit-parent.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "parent=21", "--parent", "22"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --parent with --set parent exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--parent", "20", "--set", "parent=21"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --parent with --config-file parent exits 2 before connecting", async () => {
    const f = join(sb.dir, "edit-parent-cfg.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--parent", "20", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not both");
    expect(kuma.calls).toHaveLength(0);
  });

  test("--set parent wins over --config-file parent", async () => {
    kuma.state.monitors.push(group(20, "g20"), group(21, "g21"));
    const f = join(sb.dir, "edit-parent2.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "parent=21"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(21);
  });

  test("--config-file parent must name an existing group", async () => {
    const f = join(sb.dir, "edit-parent3.json");
    writeFileSync(f, JSON.stringify({ parent: 7 }));
    const r = await run(sb, ["monitors", "edit", "2", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 7 is not a group");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --parent sets an existing group as parent", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const r = await run(sb, ["monitors", "edit", "7", "--parent", "20"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(20);
    expect(r.json().parent).toBe(20);
  });

  test("edit --parent rejects a monitor that is not a group", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--parent", "2"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 2 is not a group");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --parent rejects an unknown monitor id", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--parent", "404"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 404 not found");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --parent none clears the parent", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.parent = 20;
    const r = await run(sb, ["monitors", "edit", "7", "--parent", "none"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBeNull();
    expect(r.json().parent).toBeNull();
  });

  test("edit --parent to itself exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--parent", "7"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file parent to itself exits 2 before connecting", async () => {
    const f = join(sb.dir, "edit-self.json");
    writeFileSync(f, JSON.stringify({ parent: 7 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set with a secret field exits 2 and points to --config-file", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "basic_auth_pass=x"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set with a key that is not a monitor field exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "bogus=1"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bogus");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file with a key that is not a monitor field exits 2 before connecting", async () => {
    const f = join(sb.dir, "edit-bad.json");
    writeFileSync(f, JSON.stringify({ bogus: 1 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bogus");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file cannot set id", async () => {
    const f = join(sb.dir, "edit-id.json");
    writeFileSync(f, JSON.stringify({ id: 9 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("id");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit without --set, --config-file or --parent exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file accepts a secret field and the output stays redacted", async () => {
    const f = join(sb.dir, "edit-sec.json");
    writeFileSync(f, JSON.stringify({ basic_auth_pass: "cfg-secret-value" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.basic_auth_pass).toBe("cfg-secret-value");
    expect(r.stdout).not.toContain("cfg-secret-value");
    expect(r.json().basic_auth_pass).toBe("***");
  });

  test("edit --set parent must name a group too", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "parent=2"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 2 is not a group");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit parent checks run on the final merged hatch value", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const f = join(sb.dir, "edit-parent-final.json");
    writeFileSync(f, JSON.stringify({ parent: 2 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "parent=20"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(20);
  });

  test("edit parent group-check applies to the winning hatch value", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const f = join(sb.dir, "edit-parent-lose.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "parent=2"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 2 is not a group");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set parent beats --config-file parent for the self-parent check", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const f = join(sb.dir, "edit-self2.json");
    writeFileSync(f, JSON.stringify({ parent: 20 }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--config-file", f, "--set", "parent=7"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set parent as a numeric string is sent as a number", async () => {
    kuma.state.monitors.push(group(20, "g20"));
    const r = await run(sb, ["monitors", "edit", "7", "--set", 'parent="20"'], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(20);
  });

  test("edit --set parent empty string exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", 'parent=""'], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file parent as an empty string names the empty-string error", async () => {
    const f = join(sb.dir, "edit-parent-empty.json");
    writeFileSync(f, JSON.stringify({ parent: "" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("parent must not be an empty string");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set parent=null clears the parent", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.parent = 20;
    const r = await run(sb, ["monitors", "edit", "7", "--set", "parent=null"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBeNull();
  });

  test("edit --set interval=abc exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=abc"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interval");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([
    ["basic_auth_pass=x"],
    ["oauth_client_secret=x"],
    ["tlsKey=x"],
    ["headers=x"],
    ["body=x"],
    ["grpcBody=x"],
    ["grpcMetadata=x"],
    ["mqttPassword=x"],
    ["radiusPassword=x"],
    ["radiusSecret=x"],
    ["databaseConnectionString=x"],
    ["kafkaProducerSaslOptions={}"],
  ])("edit --set %s would put a secret in argv and exits 2", async (set) => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", set], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(set.split("=")[0]!);
    expect(r.stderr).toContain("--config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file with a bad notificationIDList exits 2 before connecting", async () => {
    const f = join(sb.dir, "edit-nid.json");
    writeFileSync(f, JSON.stringify({ notificationIDList: [0] }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("notificationIDList");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file parent as a numeric string is sent as a number", async () => {
    kuma.state.monitors.push(group(21, "g21"));
    const f = join(sb.dir, "edit-parent.json");
    writeFileSync(f, JSON.stringify({ parent: "21" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(21);
  });

  test("edit --config-file values get the same validation", async () => {
    const f = join(sb.dir, "edit-badval.json");
    writeFileSync(f, JSON.stringify({ interval: "abc" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interval must");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set timeout=0 exits 2: Kuma 1.23 turns it into interval × 800 seconds", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "timeout=0"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Kuma 1.23 turns 0 into interval × 800 seconds");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --config-file timeout=0 exits 2 with the same reason", async () => {
    const f = join(sb.dir, "edit-t0.json");
    writeFileSync(f, JSON.stringify({ timeout: 0 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Kuma 1.23 turns 0 into interval × 800 seconds");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set docker_host is checked against dockerHostList", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(sb, ["monitors", "edit", "7", "--set", "docker_host=9"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host 9 not found");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set docker_host in the list is sent", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    const r = await run(sb, ["monitors", "edit", "7", "--set", "docker_host=2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.docker_host).toBe(2);
  });

  test.each([['pushToken=""'], ["pushToken=null"]])(
    "edit on a push monitor with %s exits 2",
    async (set) => {
      kuma.state.monitors.find((m) => m.id === 9)!.pushToken = "tok-9";
      const r = await run(sb, ["monitors", "edit", "9", "--set", set], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("pushToken");
      expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
    },
  );

  test("edit derives timeout from the final interval like add", async () => {
    const m7 = kuma.state.monitors.find((m) => m.id === 7)!;
    m7.retryInterval = 60;
    m7.timeout = 48;
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=30"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(30);
    expect(sent.retryInterval).toBe(60);
    expect(sent.timeout).toBe(24);
  });

  test("edit a docker monitor: --config-file docker_host null exits 2", async () => {
    kuma.state.dockerHosts = [{ id: 2 }];
    kuma.state.monitors.push({
      id: 30,
      name: "dkr",
      type: "docker",
      active: true,
      docker_container: "c",
      docker_host: 2,
      interval: 60,
      parent: null,
      notificationIDList: {},
    });
    const f = join(sb.dir, "edit-dh.json");
    writeFileSync(f, JSON.stringify({ docker_host: null }));
    const r = await run(sb, ["monitors", "edit", "30", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docker_host");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set interval=0.1 exits 2 naming interval", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=0.1"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interval");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=dns on a monitor without hostname exits 2", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=dns"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=port on a monitor without a stored port exits 2", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=port", "--set", "hostname=h"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port must be a port number");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=nonsense exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=nonsense"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("type must be one of");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set type=mqtt with the required fields is sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=mqtt",
        "--set",
        "hostname=mqtt.example.com",
        "--set",
        "port=1883",
        "--set",
        "mqttTopic=sensors/#",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("mqtt");
    expect(sent.hostname).toBe("mqtt.example.com");
    expect(sent.port).toBe(1883);
    expect(sent.mqttTopic).toBe("sensors/#");
  });

  test("edit --set type=postgres is accepted for a type add cannot create yet", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=postgres"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("postgres");
  });

  test("edit --set type=mqtt without the required fields exits 2", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=mqtt"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=grpc-keyword without the required fields exits 2", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=grpc-keyword"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("keyword");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=grpc-keyword with every required field is sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=grpc-keyword",
        "--set",
        "grpcUrl=grpc.example.com:443",
        "--set",
        "keyword=SERVING",
        "--set",
        "grpcServiceName=Health",
        "--set",
        "grpcMethod=check",
        "--set",
        'grpcProtobuf="syntax = \\"proto3\\";"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("grpc-keyword");
    expect(sent.grpcUrl).toBe("grpc.example.com:443");
    expect(sent.keyword).toBe("SERVING");
    expect(sent.grpcServiceName).toBe("Health");
    expect(sent.grpcMethod).toBe("check");
    expect(sent.grpcProtobuf).toBe('syntax = "proto3";');
  });

  test("edit --set type=grpc-keyword without grpcProtobuf exits 2", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=grpc-keyword",
        "--set",
        "grpcUrl=grpc.example.com:443",
        "--set",
        "keyword=SERVING",
        "--set",
        "grpcServiceName=Health",
        "--set",
        "grpcMethod=check",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("grpcProtobuf");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=grpc-keyword defaults a stored null grpcBody to {}", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.grpcBody = null;
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=grpc-keyword",
        "--set",
        "grpcUrl=h:1",
        "--set",
        "keyword=k",
        "--set",
        "grpcServiceName=S",
        "--set",
        "grpcMethod=m",
        "--set",
        'grpcProtobuf="proto"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("grpc-keyword");
    expect(sent.grpcBody).toBe("{}");
  });

  test('edit --set type=grpc-keyword with --config-file grpcBody="" exits 2', async () => {
    const f = join(sb.dir, "grpc-empty.json");
    writeFileSync(f, JSON.stringify({ grpcBody: "" }));
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=grpc-keyword",
        "--set",
        "grpcUrl=h:1",
        "--set",
        "keyword=k",
        "--set",
        "grpcServiceName=S",
        "--set",
        "grpcMethod=m",
        "--set",
        'grpcProtobuf="proto"',
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("grpcBody");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=grpc-keyword defaults a stored empty grpcBody to {}", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.grpcBody = "";
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=grpc-keyword",
        "--set",
        "grpcUrl=h:1",
        "--set",
        "keyword=k",
        "--set",
        "grpcServiceName=S",
        "--set",
        "grpcMethod=m",
        "--set",
        'grpcProtobuf="proto"',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("grpc-keyword");
    expect(sent.grpcBody).toBe("{}");
  });

  test("edit --set type=real-browser without url exits 2", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "9", "--set", "type=real-browser"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("url must be a non-empty string");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=real-browser with url is sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "9",
        "--set",
        "type=real-browser",
        "--set",
        "url=https://rb.example.com",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("real-browser");
    expect(sent.url).toBe("https://rb.example.com");
  });

  test("edit --set type=kafka-producer without the required fields exits 2", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=kafka-producer"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("kafkaProducerTopic");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=kafka-producer with every required field is sent", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=kafka-producer",
        "--set",
        "kafkaProducerTopic=t",
        "--set",
        "kafkaProducerMessage=m",
        "--set",
        'kafkaProducerBrokers=["h:1"]',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("kafka-producer");
    expect(sent.kafkaProducerTopic).toBe("t");
    expect(sent.kafkaProducerMessage).toBe("m");
    expect(sent.kafkaProducerBrokers).toEqual(["h:1"]);
  });

  test("edit --set type=kafka-producer with a stored malformed broker exits 2", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.kafkaProducerBrokers = ["bad-broker"];
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=kafka-producer",
        "--set",
        "kafkaProducerTopic=t",
        "--set",
        "kafkaProducerMessage=m",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("kafkaProducerBrokers");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=kafka-producer over stored null brokers exits 2", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.kafkaProducerBrokers = null;
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=kafka-producer",
        "--set",
        "kafkaProducerTopic=t",
        "--set",
        "kafkaProducerMessage=m",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("kafkaProducerBrokers");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=radius without the required fields exits 2", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=radius"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=radius without the secrets exits 2", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=radius",
        "--set",
        "hostname=h",
        "--set",
        "port=1812",
        "--set",
        "radiusUsername=u",
        "--set",
        "radiusCalledStationId=c",
        "--set",
        "radiusCallingStationId=d",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("radiusPassword");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=radius with secrets via --config-file is sent", async () => {
    const f = join(sb.dir, "radius-secrets.json");
    writeFileSync(f, JSON.stringify({ radiusPassword: "pw", radiusSecret: "sec" }));
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=radius",
        "--set",
        "hostname=h",
        "--set",
        "port=1812",
        "--set",
        "radiusUsername=u",
        "--set",
        "radiusCalledStationId=c",
        "--set",
        "radiusCallingStationId=d",
        "--config-file",
        f,
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("radius");
    expect(sent.hostname).toBe("h");
    expect(sent.port).toBe(1812);
    expect(sent.radiusUsername).toBe("u");
    expect(sent.radiusPassword).toBe("pw");
    expect(sent.radiusSecret).toBe("sec");
  });

  test("edit --set type=radius over stored port 0 exits 2", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.port = 0;
    const f = join(sb.dir, "radius-edit.json");
    writeFileSync(
      f,
      JSON.stringify({
        hostname: "h",
        radiusUsername: "u",
        radiusCalledStationId: "c",
        radiusCallingStationId: "d",
        radiusPassword: "pw",
        radiusSecret: "sec",
      }),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=radius", "--config-file", f],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port must be a port number");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=mqtt over stored null port exits 2", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=mqtt",
        "--set",
        "hostname=h",
        "--set",
        "mqttTopic=t",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port must be a port number");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit name-only keeps a stored timeout of 0", async () => {
    kuma.state.monitors.find((m) => m.id === 7)!.timeout = 0;
    const r = await run(sb, ["monitors", "edit", "7", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.timeout).toBe(0);
  });

  test("edit name-only keeps docker_host null on a docker monitor", async () => {
    kuma.state.monitors.push({
      id: 30,
      name: "dkr",
      type: "docker",
      active: true,
      docker_container: "c",
      docker_host: null,
      interval: 60,
      parent: null,
      notificationIDList: {},
    });
    const r = await run(sb, ["monitors", "edit", "30", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.docker_host).toBeNull();
  });

  test("edit name-only keeps stored proxyId 0 and port 0", async () => {
    const m7 = kuma.state.monitors.find((m) => m.id === 7)!;
    m7.proxyId = 0;
    m7.port = 0;
    const r = await run(sb, ["monitors", "edit", "7", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.proxyId).toBe(0);
    expect(sent.port).toBe(0);
  });

  test("edit --set dns_resolve_server empty on a dns monitor exits 2", async () => {
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=dns",
        "--set",
        "hostname=h",
        "--set",
        'dns_resolve_server=""',
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_server must be a non-empty string");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set dns_resolve_server empty on a non-dns monitor is sent", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", 'dns_resolve_server=""'],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.dns_resolve_server).toBe("");
  });

  test("edit name-only on a port monitor keeps a stored port of 0", async () => {
    kuma.state.monitors.push({ ...http(31, "pt"), type: "port", hostname: "h", port: 0 });
    const r = await run(sb, ["monitors", "edit", "31", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.port).toBe(0);
  });

  test("edit name-only on a steam monitor keeps a stored port of 0", async () => {
    kuma.state.monitors.push({ ...http(32, "stm"), type: "steam", hostname: "h", port: 0 });
    const r = await run(sb, ["monitors", "edit", "32", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.port).toBe(0);
  });

  test("edit name-only on a ping monitor keeps a stored empty hostname", async () => {
    kuma.state.monitors.push({ ...http(33, "png"), type: "ping", hostname: "" });
    const r = await run(sb, ["monitors", "edit", "33", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.hostname).toBe("");
  });

  test("edit name-only on a push monitor keeps a stored null pushToken", async () => {
    kuma.state.monitors.find((m) => m.id === 9)!.pushToken = null;
    const r = await run(sb, ["monitors", "edit", "9", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.pushToken).toBeNull();
  });

  test("edit name-only keeps a stored parent that is no longer a group", async () => {
    kuma.state.monitors.push({ ...http(34, "pp"), parent: 2 });
    const r = await run(sb, ["monitors", "edit", "34", "--set", "name=x2"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.parent).toBe(2);
  });

  test("edit --set proxyId naming an unknown proxy exits 1", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "proxyId=999"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("proxy 999 not found");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=dns on a monitor with stored dns_resolve_server null exits 2", async () => {
    kuma.state.monitors.push({
      ...http(40, "dnsw"),
      hostname: "h",
      dns_resolve_server: null,
    });
    const r = await run(sb, ["monitors", "edit", "40", "--set", "type=dns"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_server");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=docker without a docker_host exits 2", async () => {
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=docker", "--set", "docker_container=c"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docker_host");
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("edit --set type=http on a dns monitor with null resolver passes", async () => {
    kuma.state.monitors.push({
      ...http(42, "dnstohttp"),
      type: "dns",
      hostname: "h",
      url: null,
      dns_resolve_server: null,
    });
    const r = await run(
      sb,
      ["monitors", "edit", "42", "--set", "type=http", "--set", "url=https://x.example.com"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.type).toBe("http");
  });

  test("edit --config-file with a numeric type exits 2 before connecting", async () => {
    const f = join(sb.dir, "edit-type.json");
    writeFileSync(f, JSON.stringify({ type: 5 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("type must be one of");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --set timeout=100 on interval 60 sends the capped 48", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "timeout=100"], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.timeout).toBe(48);
    expect(sent.retryInterval).toBe(60);
  });

  test("edit --config-file interval re-derives the timing", async () => {
    const f = join(sb.dir, "edit-int.json");
    writeFileSync(f, JSON.stringify({ interval: 30 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.interval).toBe(30);
    expect(sent.timeout).toBe(24);
  });

  test("edit --config-file timeout=100 is capped at 80% of the interval", async () => {
    const f = join(sb.dir, "edit-t100.json");
    writeFileSync(f, JSON.stringify({ timeout: 100 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    const sent = kuma.calls.find((c) => c.event === "editMonitor")!.args[0] as Record<string, any>;
    expect(sent.timeout).toBe(48);
  });

  test("edit --set interval=19 exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=19"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interval must be between 20 and 2073600");
    expect(kuma.calls).toHaveLength(0);
  });
});

describe("monitors pause / resume", () => {
  test("pause prints active false", async () => {
    const r = await run(sb, ["monitors", "pause", "7"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 7, active: false });
    expect(kuma.state.monitors.find((m) => m.id === 7)!.active).toBe(false);
  });

  test("resume prints active true", async () => {
    const r = await run(sb, ["monitors", "resume", "9"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 9, active: true });
    expect(kuma.state.monitors.find((m) => m.id === 9)!.active).toBe(true);
    expect(kuma.calls.map((c) => c.event)).toContain("resumeMonitor");
    expect(kuma.calls.map((c) => c.event)).not.toContain("pauseMonitor");
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "pause", "404"], creds(kuma.url));
    expect(r.code).toBe(1);
  });
});

describe("monitors delete", () => {
  test("deletes the monitor and prints { id, deleted: true }", async () => {
    const r = await run(sb, ["monitors", "delete", "7", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 7, deleted: true });
    expect(kuma.state.monitors.map((m) => m.id)).toEqual([2, 9]);
    expect(kuma.calls.find((c) => c.event === "deleteMonitor")!.args).toEqual([7]);
  });

  test("without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "delete", "7"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would delete monitor 7");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["monitors", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an unknown id exits 1 without sending deleteMonitor", async () => {
    const r = await run(sb, ["monitors", "delete", "404", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("monitor 404 not found");
    expect(kuma.calls.find((c) => c.event === "deleteMonitor")).toBeUndefined();
    expect(kuma.state.monitors.map((m) => m.id).sort((a, b) => a - b)).toEqual([2, 7, 9]);
  });

  test("Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.deleteMonitor = "cannot delete";
    const r = await run(sb, ["monitors", "delete", "7", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot delete");
    expect(kuma.state.monitors.map((m) => m.id).sort((a, b) => a - b)).toEqual([2, 7, 9]);
  });
});
