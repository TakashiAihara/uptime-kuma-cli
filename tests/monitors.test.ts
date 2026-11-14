import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  parent: null,
  maxretries: 0,
  notificationIDList: {},
  accepted_statuscodes: ["200-299"],
  ...extra,
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

  test("--set without = exits 2", async () => {
    const r = await run(sb, ["monitors", "edit", "7", "--set", "name"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls.find((c) => c.event === "editMonitor")).toBeUndefined();
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "edit", "404", "--set", "name=x"], creds(kuma.url));
    expect(r.code).toBe(1);
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
  });

  test("an unknown id exits 1", async () => {
    const r = await run(sb, ["monitors", "pause", "404"], creds(kuma.url));
    expect(r.code).toBe(1);
  });
});
