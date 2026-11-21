import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma | undefined;
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

const jsonQuery = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  ...http(id, name),
  type: "json-query",
  jsonPath: "$.status",
  expectedValue: "ok",
  conditions: [],
  rabbitmqNodes: [],
  ...extra,
});

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await kuma?.close();
  kuma = undefined;
  sb.cleanup();
});

// Each test picks its own profile and fixtures; the const keeps the fake
// non-optional for the assertions below.
async function useFake(init: Parameters<typeof startFakeKuma>[0] = {}): Promise<FakeKuma> {
  kuma = await startFakeKuma(init);
  return kuma;
}

const addCalls = (k: FakeKuma) => k.calls.filter((c) => c.event === "add");
const editCalls = (k: FakeKuma) => k.calls.filter((c) => c.event === "editMonitor");
const stored = (k: FakeKuma, name: string) => k.state.monitors.find((m) => m.name === name)!;

describe("monitors add on Kuma 2.x", () => {
  test("push and http adds store the conditions and rabbitmqNodes defaults", async () => {
    const k = await useFake({ profile: "2.x" });
    const push = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "push-x"],
      creds(k.url),
    );
    expect(push.code).toBe(0);
    const httpAdd = await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "http-x", "--url", "https://h.example.com"],
      creds(k.url),
    );
    expect(httpAdd.code).toBe(0);
    expect(addCalls(k)).toHaveLength(2);
    for (const name of ["push-x", "http-x"]) {
      const m = stored(k, name);
      expect(m.conditions).toEqual([]);
      expect(m.rabbitmqNodes).toEqual([]);
    }
  });

  test("a --config-file conditions value wins over the 2.x default", async () => {
    const k = await useFake({ profile: "2.x" });
    const conditions = [{ type: "json", jsonPath: "$.ok", operator: "==", value: "true" }];
    const f = join(sb.dir, "cond.json");
    writeFileSync(f, JSON.stringify({ conditions }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "http-x",
        "--url",
        "https://h.example.com",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "http-x");
    expect(m.conditions).toEqual(conditions);
    expect(m.rabbitmqNodes).toEqual([]);
  });

  test("a json-query add defaults jsonPathOperator to ==", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "jq",
        "--url",
        "https://jq.example.com",
        "--json-path",
        "$.status",
        "--expected-value",
        "ok",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "jq");
    expect(m.jsonPathOperator).toBe("==");
    expect(m.conditions).toEqual([]);
    expect(m.rabbitmqNodes).toEqual([]);
  });

  test("a json-query add stores the --json-path-operator value", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "jq",
        "--url",
        "https://jq.example.com",
        "--json-path",
        "$.status",
        "--expected-value",
        "ok",
        "--json-path-operator",
        "contains",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "jq").jsonPathOperator).toBe("contains");
  });

  test("--json-path-operator on a non-json-query type exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "http-x",
        "--url",
        "https://h.example.com",
        "--json-path-operator",
        "contains",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--json-path-operator only applies to --type json-query");
    expect(k.calls).toHaveLength(0);
  });

  test("an http add on 2.x stores the == operator default like the 2.x UI", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h2", "--url", "https://h.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h2").jsonPathOperator).toBe("==");
  });

  test("tailscale-ping exits 2 on a container server like the picker's hidden type", async () => {
    const k = await useFake({ profile: "2.x" });
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
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("tailscale-ping is not available");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("--set jsonPathOperator with an unknown operator exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "jsonPathOperator=bogus",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("jsonPathOperator must be one of");
    expect(k.calls).toHaveLength(0);
  });

  test("--config-file jsonPathOperator with an unknown operator exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "op.json");
    writeFileSync(f, JSON.stringify({ jsonPathOperator: "bogus" }));
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
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("jsonPathOperator must be one of");
    expect(k.calls).toHaveLength(0);
  });

  test("--json-path-operator with an unknown operator exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "--json-path-operator",
        "bogus",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(k.calls).toHaveLength(0);
  });
});

describe("monitors edit on Kuma 2.x", () => {
  test("edit --json-path-operator stores the operator", async () => {
    const k = await useFake({ profile: "2.x", monitors: [jsonQuery(7, "jq")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "contains"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(editCalls(k)).toHaveLength(1);
    expect(stored(k, "jq").jsonPathOperator).toBe("contains");
  });

  test("edit turning an http monitor into json-query defaults the operator to ==", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=json-query",
        "--set",
        "jsonPath=$.status",
        "--set",
        "expectedValue=ok",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").jsonPathOperator).toBe("==");
  });

  test("edit gives a fetched json-query monitor with a null operator ==", async () => {
    // a real 2.x server returns null, not a missing key, for an unset operator
    const k = await useFake({
      profile: "2.x",
      monitors: [jsonQuery(7, "jq", { jsonPathOperator: null })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=x"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "jq").jsonPathOperator).toBe("==");
  });

  test("edit --config-file jsonPathOperator wins over --json-path-operator", async () => {
    const k = await useFake({ profile: "2.x", monitors: [jsonQuery(7, "jq")] });
    const f = join(sb.dir, "op.json");
    writeFileSync(f, JSON.stringify({ jsonPathOperator: "contains" }));
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "<", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "jq").jsonPathOperator).toBe("contains");
  });

  test("edit keeps a fetched json-query operator", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [jsonQuery(7, "jq", { jsonPathOperator: "!=" })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=x"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "jq").jsonPathOperator).toBe("!=");
  });

  test("edit --set jsonPathOperator wins over --json-path-operator", async () => {
    const k = await useFake({ profile: "2.x", monitors: [jsonQuery(7, "jq")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "<", "--set", "jsonPathOperator=>"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "jq").jsonPathOperator).toBe(">");
  });

  test("edit --json-path-operator on a non-json-query monitor exits 2", async () => {
    // a real 2.x http monitor carries the "==" the add defaults gave it
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { jsonPathOperator: "==" })],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "!=", "--set", "description=x"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--json-path-operator only applies to --type json-query");
    expect(editCalls(k)).toHaveLength(0);
  });

  test.each([
    ["--set", "conditions=x"],
    ["--set", "rabbitmqNodes=5"],
  ])("edit %s %s exits 2 before connecting (not an array)", async (flag, value) => {
    const k = await useFake({ profile: "2.x", monitors: [jsonQuery(7, "jq")] });
    const r = await run(sb, ["monitors", "edit", "7", flag, value], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must be an array");
    expect(k.calls).toHaveLength(0);
  });

  test("edit keeps the fetched conditions and rabbitmqNodes", async () => {
    const conditions = [{ type: "json", jsonPath: "$.ok", operator: "==", value: "true" }];
    const rabbitmqNodes = [{ name: "mq1", enabled: true }];
    const k = await useFake({
      profile: "2.x",
      monitors: [jsonQuery(7, "jq", { conditions, rabbitmqNodes })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=hi"], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.conditions).toEqual(conditions);
    expect(sent.rabbitmqNodes).toEqual(rabbitmqNodes);
    const m = stored(k, "jq");
    expect(m.conditions).toEqual(conditions);
    expect(m.rabbitmqNodes).toEqual(rabbitmqNodes);
    expect(m.description).toBe("hi");
  });

  test("edit --set jsonPathOperator with an unknown operator exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", monitors: [jsonQuery(7, "jq")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "jsonPathOperator=bogus"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("jsonPathOperator must be one of");
    expect(k.calls).toHaveLength(0);
  });

  test("edit --set type=kafka-producer fills absent SASL options like add does", async () => {
    // a non-kafka monitor never carried SASL options; sent absent, the
    // server's JSON.stringify writes NULL and the kafka check's
    // JSON.parse(...).mechanism throws on every beat
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
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
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.kafkaProducerSaslOptions).toEqual({ mechanism: "None" });
    expect(stored(k, "h").kafkaProducerSaslOptions).toEqual({ mechanism: "None" });
  });
});

describe("2.x-only fields", () => {
  test("a --config-file sshPassword is stored on 2.x and redacted by monitors get", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sec.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-hidden-ssh" }));
    const add = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "push-x", "--config-file", f],
      creds(k.url),
    );
    expect(add.code).toBe(0);
    const id = add.json().id as number;
    expect(addCalls(k)[0]!.args[0]).toMatchObject({ sshPassword: "fixture-hidden-ssh" });
    const get = await run(sb, ["monitors", "get", String(id)], creds(k.url));
    expect(get.code).toBe(0);
    expect(get.stdout).not.toContain("fixture-hidden-ssh");
    expect(get.json().sshPassword).toBe("***");
  });

  test("a --set sshPassword still exits 2 on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--set", "sshPassword=x"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file");
    expect(k.calls).toHaveLength(0);
  });
});

describe("2.x-only fields on Kuma 1.x", () => {
  test("add sends neither conditions, rabbitmqNodes nor jsonPathOperator", async () => {
    const k = await useFake();
    const jq = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "jq",
        "--url",
        "https://jq.example.com",
        "--json-path",
        "$.status",
        "--expected-value",
        "ok",
      ],
      creds(k.url),
    );
    expect(jq.code).toBe(0);
    const httpAdd = await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "http-x", "--url", "https://h.example.com"],
      creds(k.url),
    );
    expect(httpAdd.code).toBe(0);
    expect(addCalls(k)).toHaveLength(2);
    for (const c of addCalls(k)) {
      const sent = c.args[0] as Record<string, unknown>;
      expect(sent.conditions).toBeUndefined();
      expect(sent.rabbitmqNodes).toBeUndefined();
      expect(sent.jsonPathOperator).toBeUndefined();
    }
  });

  test("--json-path-operator exits 2 on a 1.x server before add", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "json-query",
        "--name",
        "jq",
        "--url",
        "https://jq.example.com",
        "--json-path",
        "$.status",
        "--expected-value",
        "ok",
        "--json-path-operator",
        "contains",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"jsonPathOperator" needs Uptime Kuma 2.x');
    expect(r.stderr).toContain("1.23.17");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("a --config-file sshPassword exits 2 on a 1.x server before add", async () => {
    const k = await useFake();
    const f = join(sb.dir, "sec.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "x" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "x", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"sshPassword" needs Uptime Kuma >= 2.5.4');
    expect(r.stderr).toContain("1.23.17");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit of a json-query monitor on a 1.x server sends no jsonPathOperator", async () => {
    const { conditions: _c, rabbitmqNodes: _r, ...m } = jsonQuery(7, "jq");
    const k = await useFake({ monitors: [m] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=x"], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("jsonPathOperator");
  });

  test("--json-path-operator on a non-json-query add exits 2 on a 1.x server too", async () => {
    const k = await useFake({});
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h1",
        "--url",
        "https://h.example.com",
        "--json-path-operator",
        "!=",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--json-path-operator only applies to --type json-query");
    expect(k.calls).toHaveLength(0);
  });

  test("add --set with a non-secret 2.x key exits 2 on a 1.x server before add", async () => {
    const k = await useFake({});
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "p", "--set", "saveResponse=true"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"saveResponse" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set with a non-secret 2.x key exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"saveResponse" needs Uptime Kuma >= 2.1.0');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --config-file with a 2.x key exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const f = join(sb.dir, "e.json");
    writeFileSync(f, JSON.stringify({ responseMaxLength: 100 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"responseMaxLength" needs Uptime Kuma >= 2.1.0');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("with no version from the server the refusal says 1.x was assumed", async () => {
    const k = await useFake({ info: null, monitors: [http(7, "Taba")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the server sent no version, so 1.x was assumed");
  });

  test("edit --json-path-operator exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "contains"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"jsonPathOperator" needs Uptime Kuma 2.x');
    expect(editCalls(k)).toHaveLength(0);
  });

  // the buckets below are the first upstream releases whose editMonitor
  // reads the key (checked per tag: 2.0.x, 2.1.0, 2.4.0, 2.5.0, 2.5.4); on
  // every older 2.x the set key would silently drop like on 1.x

  test("edit --set saveResponse exits 2 on a 2.0 server naming 2.1.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.0.2" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"saveResponse" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set saveResponse runs on 2.1.0, the first release reading the key", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.1.0" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.saveResponse).toBe(true);
  });

  test("edit --set wsSubprotocol exits 2 on a 2.0 server naming 2.1.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.0.2" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "wsSubprotocol=chat"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"wsSubprotocol" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --config-file bearer_token exits 2 on a 2.3 server naming 2.4.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.3.2" },
      monitors: [http(7, "h")],
    });
    const f = join(sb.dir, "bt.json");
    writeFileSync(f, JSON.stringify({ bearer_token: "t" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"bearer_token" needs Uptime Kuma >= 2.4.0; the server reports 2.3.2',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --config-file bearer_token runs on 2.4.0, the first release reading the key", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.4.0" },
      monitors: [http(7, "h")],
    });
    const f = join(sb.dir, "bt.json");
    writeFileSync(f, JSON.stringify({ bearer_token: "t" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.bearer_token).toBe("t");
  });

  test("edit --set screenshot_delay exits 2 on a 2.4 server naming 2.5.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.4.0" },
      monitors: [http(7, "h")],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "screenshot_delay=10"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"screenshot_delay" needs Uptime Kuma >= 2.5.0; the server reports 2.4.0',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set sftpPath exits 2 on a 2.5.3 server naming 2.5.4", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.5.3" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "sftpPath=/tmp/x"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"sftpPath" needs Uptime Kuma >= 2.5.4; the server reports 2.5.3');
    expect(editCalls(k)).toHaveLength(0);
  });

  // a greater major clears every entry — the gate is `>=`, not `==`
  test("edit --set saveResponse runs on a 3.x server", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "3.0.0" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.saveResponse).toBe(true);
  });

  test("edit --set sftpPath runs on 2.5.4, the first release reading the key", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.5.4" },
      monitors: [http(7, "h")],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "sftpPath=/tmp/x"], creds(k.url));
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.sftpPath).toBe("/tmp/x");
  });
});

describe("manual monitors", () => {
  test("add --type manual stores a manual monitor on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, ["monitors", "add", "--type", "manual", "--name", "m1"], creds(k.url));
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ name: "m1", type: "manual", active: true });
    const m = stored(k, "m1");
    expect(m.type).toBe("manual");
    // the UI leaves manual_status unset until a button is pressed
    expect(m.manual_status).toBeUndefined();
    expect(m.conditions).toEqual([]);
  });

  test("add --type manual --set manual_status=1 stores the status", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--set", "manual_status=1"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "m1").manual_status).toBe(1);
  });

  test("add --type manual --set manual_status=null stores null", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--set", "manual_status=null"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "m1").manual_status).toBeNull();
  });

  test("add --type manual --config-file manual_status=0 stores the status", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ms.json");
    writeFileSync(f, JSON.stringify({ manual_status: 0 }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "m1").manual_status).toBe(0);
  });

  test.each([
    ["manual_status=2"],
    ["manual_status=3"],
    ["manual_status=4"],
    ["manual_status=-1"],
    ["manual_status=1.5"],
    ['manual_status="up"'],
  ])("add --set %s exits 2 before connecting", async (set) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--set", set],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("manual_status must be null, 0 (down), or 1 (up)");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type manual --config-file with a bad manual_status exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ms.json");
    writeFileSync(f, JSON.stringify({ manual_status: 2 }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("manual_status must be null, 0 (down), or 1 (up)");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type manual exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(sb, ["monitors", "add", "--type", "manual", "--name", "m1"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "manual" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type manual names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null });
    const r = await run(sb, ["monitors", "add", "--type", "manual", "--name", "m1"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "manual" needs Uptime Kuma 2.x; the server sent no version');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set type=manual stores it on 2.x", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=manual"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "h").type).toBe("manual");
  });

  test("edit --set type=manual exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=manual"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "manual" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=manual names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null, monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=manual"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "manual" needs Uptime Kuma 2.x; the server sent no version');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set manual_status stores it on 2.x", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "manual_status=0"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "m").manual_status).toBe(0);
  });

  // the fetched monitor cannot carry manual_status (toJSON does not emit it),
  // so an edit without the key sends none — and knex drops undefined update
  // keys, leaving the stored status alone
  test("edit without manual_status keeps the stored status", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null, manual_status: 1 }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", 'name="m2"'], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "m2").manual_status).toBe(1);
  });

  test("edit --set manual_status=null clears the stored status", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null, manual_status: 1 }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "manual_status=null"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "m").manual_status).toBeNull();
  });

  test("edit --set manual_status=5 exits 2 before editMonitor", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "manual_status=5"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("manual_status must be null, 0 (down), or 1 (up)");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("--type manual refuses a flag for another type before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "manual", "--name", "m1", "--hostname", "h.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--hostname only applies to --type");
    expect(k.calls).toHaveLength(0);
  });
});

describe("ntp monitors", () => {
  test("add --type ntp stores an ntp monitor with the UI's defaults on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "n1");
    expect(m.type).toBe("ntp");
    expect(m.hostname).toBe("ntp.example.com");
    // the UI's type watcher fills port 123 and a 5-minute interval
    expect(m.port).toBe(123);
    expect(m.interval).toBe(300);
    expect(m.retryInterval).toBe(300);
    // the ntp_*_threshold columns do not exist before the 2.5 migration, so
    // an add sends none of them — the column defaults fill them there
    expect(m).not.toHaveProperty("ntpStratumThreshold");
    expect(m).not.toHaveProperty("ntpTimeOffsetThreshold");
    expect(m).not.toHaveProperty("ntpRootDispersionThreshold");
  });

  test("add --type ntp --port and --interval override the defaults", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ntp",
        "--name",
        "n1",
        "--hostname",
        "ntp.example.com",
        "--port",
        "8123",
        "--interval",
        "120",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({ port: 8123, interval: 120, retryInterval: 120 });
  });

  test("add --type ntp --set interval/port overrides the defaults too", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ntp",
        "--name",
        "n1",
        "--hostname",
        "ntp.example.com",
        "--set",
        "interval=60",
        "--set",
        "port=8123",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({ port: 8123, interval: 60 });
  });

  test("add --type ntp --set ntp*Threshold stores the thresholds", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ntp",
        "--name",
        "n1",
        "--hostname",
        "ntp.example.com",
        "--set",
        "ntpStratumThreshold=10",
        "--set",
        "ntpTimeOffsetThreshold=2000",
        "--set",
        "ntpRootDispersionThreshold=100",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({
      ntpStratumThreshold: 10,
      ntpTimeOffsetThreshold: 2000,
      ntpRootDispersionThreshold: 100,
    });
  });

  test("add --type ntp --config-file stores the thresholds", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ntp.json");
    writeFileSync(
      f,
      JSON.stringify({
        ntpStratumThreshold: 3,
        ntpTimeOffsetThreshold: 250,
        ntpRootDispersionThreshold: 50,
      }),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ntp",
        "--name",
        "n1",
        "--hostname",
        "ntp.example.com",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({
      ntpStratumThreshold: 3,
      ntpTimeOffsetThreshold: 250,
      ntpRootDispersionThreshold: 50,
    });
  });

  test("add --type ntp without --hostname exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, ["monitors", "add", "--type", "ntp", "--name", "n1"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type ntp requires --hostname");
    expect(k.calls).toHaveLength(0);
  });

  test.each([
    ["ntpStratumThreshold=0", "ntpStratumThreshold must be an integer between 1 and 15"],
    ["ntpStratumThreshold=16", "ntpStratumThreshold must be an integer between 1 and 15"],
    ["ntpStratumThreshold=-1", "ntpStratumThreshold must be an integer between 1 and 15"],
    ["ntpStratumThreshold=1.5", "ntpStratumThreshold must be an integer between 1 and 15"],
    ['ntpStratumThreshold="x"', "ntpStratumThreshold must be an integer between 1 and 15"],
    ["ntpStratumThreshold=null", "ntpStratumThreshold must be a number"],
    ["ntpTimeOffsetThreshold=0", "ntpTimeOffsetThreshold must be a positive integer"],
    ["ntpTimeOffsetThreshold=-1", "ntpTimeOffsetThreshold must be a positive integer"],
    ["ntpTimeOffsetThreshold=1.5", "ntpTimeOffsetThreshold must be a positive integer"],
    ["ntpRootDispersionThreshold=0", "ntpRootDispersionThreshold must be a positive integer"],
    ["ntpRootDispersionThreshold=1.5", "ntpRootDispersionThreshold must be a positive integer"],
  ])("add --set %s exits 2 before connecting", async (set, msg) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h", "--set", set],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls).toHaveLength(0);
  });

  test("add --type ntp --config-file with a bad threshold exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ntp.json");
    writeFileSync(f, JSON.stringify({ ntpStratumThreshold: 16 }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ntpStratumThreshold must be an integer between 1 and 15");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type ntp exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0; the server reports 1.23.17');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type ntp names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0; the server sent no version');
    expect(addCalls(k)).toHaveLength(0);
  });

  // ntp.js first ships in 2.5.0 (upstream #7214): on 2.0-2.4 the row would
  // store and every check would throw "Unknown Monitor Type"
  test("add --type ntp exits 2 on a 2.4 server naming 2.5.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.4.0" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0; the server reports 2.4.0');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type ntp runs on 2.5.0, the first release with the type", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.5.0" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({ type: "ntp", port: 123 });
  });

  // nightly builds report 3.x, which carries every 2.x type
  test("add --type ntp runs on a 3.x server", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "3.0.0" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n1")).toMatchObject({ type: "ntp" });
  });

  // the gate is per type: smtp exists since 2.0.0-beta.3, so 2.4 allows it
  test("add --type smtp still runs on a 2.4 server", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.4.0" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "smtp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ type: "smtp" });
  });

  test("edit --set type=ntp exits 2 on a 2.4 server before editMonitor", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.4.0" },
      monitors: [http(7, "h")],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0; the server reports 2.4.0');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=ntp on an http monitor needs hostname on the merged monitor", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=ntp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  // the UI's type watcher fills the same defaults on a type change, so an
  // http monitor needs only hostname to become ntp
  test("edit --set type=ntp fills the picker's port and interval on 2.x", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "ntp",
      hostname: "ntp.example.com",
      port: 123,
      interval: 300,
      retryInterval: 300,
    });
  });

  // the watcher replaces another type's well-known port, not a custom one
  test("edit --set type=ntp replaces a dns monitor's port 53", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "h"),
          type: "dns",
          url: null,
          hostname: "dns.example.com",
          port: 53,
          dns_resolve_type: "A",
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "ntp",
      hostname: "ntp.example.com",
      port: 123,
      interval: 300,
    });
  });

  test("edit --set type=ntp keeps a custom port", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        { ...http(7, "h"), type: "port", url: null, hostname: "h.example.com", port: 8080 },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "ntp",
      hostname: "ntp.example.com",
      port: 8080,
      interval: 300,
    });
  });

  test("edit --set type=ntp keeps the port and interval the edit sets", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=ntp",
        "--set",
        "hostname=ntp.example.com",
        "--set",
        "port=8053",
        "--set",
        "interval=60",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "ntp",
      hostname: "ntp.example.com",
      port: 8053,
      interval: 60,
    });
  });

  // the defaulted interval is a timing change: a stored timeout that no
  // longer fits it is re-capped to 80%, like an interval the edit set
  test("edit --set type=ntp re-caps a stored timeout over the new interval's 80%", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), interval: 3600, retryInterval: 3600, timeout: 2000 }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "ntp",
      interval: 300,
      retryInterval: 300,
      timeout: 240,
    });
  });

  // an interval already at 300 is not a change this edit made, so the
  // stored timeout pair is not re-judged either
  test("edit --set type=ntp leaves the stored timeout when the interval was already 300", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), interval: 300, retryInterval: 300, timeout: 2000 }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({ type: "ntp", interval: 300, timeout: 2000 });
  });

  test("edit --set type=ntp exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=ntp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0; the server reports 1.23.17');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set ntpStratumThreshold exits 2 on a 1.x server", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "ntpStratumThreshold=10"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"ntpStratumThreshold" needs Uptime Kuma >= 2.5.0');
    expect(editCalls(k)).toHaveLength(0);
  });

  // The ntp_*_threshold columns ship in 2.5.0 with the type: on 2.0-2.4
  // `editMonitor` would silently drop the key while answering ok
  test("add --set ntpStratumThreshold exits 2 on a 2.4 server naming 2.5.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.4.0" } });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h",
        "--url",
        "https://h.test",
        "--set",
        "ntpStratumThreshold=10",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"ntpStratumThreshold" needs Uptime Kuma >= 2.5.0; the server reports 2.4.0',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set ntpStratumThreshold exits 2 on a 2.4 server naming 2.5.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.4.0" },
      monitors: [http(7, "h")],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "ntpStratumThreshold=10"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"ntpStratumThreshold" needs Uptime Kuma >= 2.5.0; the server reports 2.4.0',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set ntpStratumThreshold runs on 2.5.0, the first release with the columns", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.5.0" },
      monitors: [{ ...http(7, "n"), type: "ntp" }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "ntpStratumThreshold=10"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.ntpStratumThreshold).toBe(10);
  });

  // a 2.x field without a min-version entry (smtpSecurity shipped in beta.3)
  // only needs major 2
  test("edit --set smtpSecurity runs on a 2.4 server", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.4.0" },
      monitors: [{ ...http(7, "s"), type: "smtp", hostname: "s.test", port: 25 }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "smtpSecurity=secure"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.smtpSecurity).toBe("secure");
  });

  // toJSON emits the ntp fields, so the fetched monitor carries them back —
  // an edit that does not touch them keeps the stored values
  test("edit without the ntp keys keeps the stored thresholds", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "n"),
          type: "ntp",
          url: null,
          hostname: "ntp.example.com",
          port: 123,
          ntpStratumThreshold: 10,
          ntpTimeOffsetThreshold: 2000,
          ntpRootDispersionThreshold: 100,
        },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", 'name="n2"'], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "n2")).toMatchObject({
      ntpStratumThreshold: 10,
      ntpTimeOffsetThreshold: 2000,
      ntpRootDispersionThreshold: 100,
    });
  });

  test("edit --set ntpStratumThreshold=0 exits 2 before editMonitor", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "n"),
          type: "ntp",
          url: null,
          hostname: "ntp.example.com",
          port: 123,
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "ntpStratumThreshold=0"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ntpStratumThreshold must be an integer between 1 and 15");
    expect(editCalls(k)).toHaveLength(0);
  });

  // an empty --interval must fail, not silently land on the 300 default
  test("add --type ntp --interval '' exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h", "--interval", ""],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--interval must be at least 1 second");
    expect(k.calls).toHaveLength(0);
  });

  // a type the server cannot run is refused before the new type's
  // required fields are judged, like the 2.x gate
  test("edit --set type=tailscale-ping names the container refusal before the hostname check", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=tailscale-ping"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("tailscale-ping is not available");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("--type ntp refuses a flag for another type before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ntp", "--name", "n1", "--hostname", "h", "--keyword", "x"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--keyword only applies to --type");
    expect(k.calls).toHaveLength(0);
  });
});

describe("smtp monitors", () => {
  test("add --type smtp stores an smtp monitor with the check's port default on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "s1");
    expect(m.type).toBe("smtp");
    expect(m.hostname).toBe("mail.example.com");
    // the picker leaves the port blank but check() runs `port || 25`
    expect(m.port).toBe(25);
    // monitorDefaults has no smtpSecurity, so an add sends none — the
    // column's null default is "unset" (plain SMTP, opportunistic STARTTLS)
    expect(m).not.toHaveProperty("smtpSecurity");
  });

  test("add --type smtp --port overrides the check's default", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "smtp",
        "--name",
        "s1",
        "--hostname",
        "mail.example.com",
        "--port",
        "587",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ port: 587 });
  });

  test("add --type smtp --set smtpSecurity stores it", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "smtp",
        "--name",
        "s1",
        "--hostname",
        "mail.example.com",
        "--set",
        "smtpSecurity=starttls",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ smtpSecurity: "starttls" });
  });

  test("add --type smtp --set smtpSecurity=null stores the explicit unset", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "smtp",
        "--name",
        "s1",
        "--hostname",
        "mail.example.com",
        "--set",
        "smtpSecurity=null",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ smtpSecurity: null });
  });

  test("add --type smtp --config-file stores smtpSecurity", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "smtp.json");
    writeFileSync(f, JSON.stringify({ smtpSecurity: "secure" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "smtp",
        "--name",
        "s1",
        "--hostname",
        "mail.example.com",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ smtpSecurity: "secure" });
  });

  test("add --type smtp without --hostname exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, ["monitors", "add", "--type", "smtp", "--name", "s1"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type smtp requires --hostname");
    expect(k.calls).toHaveLength(0);
  });

  test.each([
    ['smtpSecurity="tls"', "smtpSecurity must be one of secure, starttls, nostarttls, or null"],
    ["smtpSecurity=0", "smtpSecurity must be one of secure, starttls, nostarttls, or null"],
    ["smtpSecurity=true", "smtpSecurity must be one of secure, starttls, nostarttls, or null"],
  ])("add --type smtp --set %s exits 2 before connecting", async (set, msg) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "h", "--set", set],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls).toHaveLength(0);
  });

  test("add --type smtp --config-file with a bad smtpSecurity exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "smtp.json");
    writeFileSync(f, JSON.stringify({ smtpSecurity: "tls" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "h", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("smtpSecurity must be one of secure, starttls, nostarttls, or null");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type smtp exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "smtp" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(k.calls.filter((c) => c.event === "add")).toHaveLength(0);
  });

  test("add --type smtp names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "smtp", "--name", "s1", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "smtp" needs Uptime Kuma 2.x; the server sent no version');
  });

  test("edit --set type=smtp on an http monitor needs hostname on the merged monitor", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=smtp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  // the UI's watcher leaves the port blank for smtp; the CLI fills the
  // check's `port || 25` instead, so an http monitor needs only hostname
  test("edit --set type=smtp fills the check's port default on 2.x", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=smtp", "--set", "hostname=mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "smtp",
      hostname: "mail.example.com",
      port: 25,
    });
  });

  // the watcher replaces another type's well-known port, not a custom one —
  // and smtp has no interval pick, so the stored interval is untouched
  test("edit --set type=smtp replaces a dns monitor's port 53 but keeps its interval", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "h"),
          type: "dns",
          url: null,
          hostname: "dns.example.com",
          port: 53,
          dns_resolve_type: "A",
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=smtp", "--set", "hostname=mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "smtp",
      hostname: "mail.example.com",
      port: 25,
      interval: 60,
    });
  });

  test("edit --set type=smtp keeps a custom port", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        { ...http(7, "h"), type: "port", url: null, hostname: "h.example.com", port: 8080 },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=smtp", "--set", "hostname=mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "smtp",
      hostname: "mail.example.com",
      port: 8080,
    });
  });

  test("edit --set type=smtp keeps the port the edit sets", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=smtp",
        "--set",
        "hostname=mail.example.com",
        "--set",
        "port=465",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "smtp",
      hostname: "mail.example.com",
      port: 465,
    });
  });

  // a stored 25 is the smtp default the CLI wrote, not a custom port —
  // it reads as "another type's default" to the watcher like upstream's
  // own picks do, so the new type's default replaces it
  test("edit --set type=ntp turns the stored smtp port 25 into ntp's 123", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "s"),
          type: "smtp",
          url: null,
          hostname: "mail.example.com",
          port: 25,
          smtpSecurity: "secure",
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({
      type: "ntp",
      hostname: "ntp.example.com",
      port: 123,
      interval: 300,
    });
  });

  // ntp's 123 is a well-known default the watcher replaces, and smtp has
  // no interval pick of its own, so the 300 ntp chose is left alone
  test("edit --set type=smtp turns the stored ntp port 123 into 25 but keeps interval 300", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "n"),
          type: "ntp",
          url: null,
          hostname: "ntp.example.com",
          port: 123,
          interval: 300,
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=smtp", "--set", "hostname=mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "n")).toMatchObject({
      type: "smtp",
      hostname: "mail.example.com",
      port: 25,
      interval: 300,
    });
  });

  // a type with no port pick of its own leaves the stored port alone —
  // without the guard the branch would write the map's undefined over 53
  test("edit --set type=ping keeps a dns monitor's port 53", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "h"),
          type: "dns",
          url: null,
          hostname: "dns.example.com",
          port: 53,
          dns_resolve_type: "A",
        },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=ping"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "h").port).toBe(53);
  });

  test("edit --set type=smtp exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=smtp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "smtp" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set smtpSecurity exits 2 on a 1.x server", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "smtpSecurity=secure"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"smtpSecurity" needs Uptime Kuma 2.x');
    expect(editCalls(k)).toHaveLength(0);
  });

  // toJSON emits smtpSecurity, so the fetched monitor carries it back — an
  // edit that does not touch it keeps the stored value
  test("edit without smtpSecurity keeps the stored one", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "s"),
          type: "smtp",
          url: null,
          hostname: "mail.example.com",
          port: 25,
          smtpSecurity: "secure",
        },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", 'name="s2"'], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "s2")).toMatchObject({ smtpSecurity: "secure" });
  });

  test("edit --set smtpSecurity=bogus exits 2 before editMonitor", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "s"),
          type: "smtp",
          url: null,
          hostname: "mail.example.com",
          port: 25,
        },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "smtpSecurity=bogus"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("smtpSecurity must be one of secure, starttls, nostarttls, or null");
    expect(editCalls(k)).toHaveLength(0);
  });
});

describe("snmp monitors", () => {
  // the shared picker's required set for a v2c monitor: hostname, the OID
  // to get, and the Json Query block's path and expected value
  const snmpAdd = [
    "monitors",
    "add",
    "--type",
    "snmp",
    "--name",
    "s1",
    "--hostname",
    "rtr.example.com",
    "--snmp-oid",
    "1.3.6.1.4.1.9.6.1.101",
    "--json-path",
    "$",
    "--expected-value",
    "up",
  ];

  const snmpFixture = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    ...http(id, name),
    type: "snmp",
    url: null,
    hostname: "rtr.example.com",
    port: 161,
    timeout: 5,
    snmpOid: "1.3.6.1.4.1.9.6.1.101",
    snmpVersion: "2c",
    jsonPath: "$",
    expectedValue: "up",
    jsonPathOperator: "==",
    ...extra,
  });

  test("add --type snmp stores the picker's defaults on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, snmpAdd, creds(k.url));
    expect(r.code).toBe(0);
    const m = stored(k, "s1");
    expect(m).toMatchObject({
      type: "snmp",
      hostname: "rtr.example.com",
      port: 161,
      timeout: 5,
      snmpOid: "1.3.6.1.4.1.9.6.1.101",
      snmpVersion: "2c",
      jsonPath: "$",
      expectedValue: "up",
      jsonPathOperator: "==",
    });
    // no community given — the column stays null and net-snmp reads it as
    // "public" (snmp.js passes radiusPassword to createSession)
    expect(m).not.toHaveProperty("radiusPassword");
    expect(m).not.toHaveProperty("snmpV3Username");
  });

  test("add --type snmp --port/--snmp-version override the defaults", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, [...snmpAdd, "--port", "1161", "--snmp-version", "1"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ port: 1161, snmpVersion: "1" });
  });

  test("add --type snmp --json-path-operator stores it", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [...snmpAdd, "--json-path", "$.status", "--json-path-operator", "contains"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ jsonPathOperator: "contains" });
  });

  test("add --type snmp --config-file stores the community as radiusPassword", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "snmp.json");
    writeFileSync(f, JSON.stringify({ radiusPassword: "private" }));
    const r = await run(sb, [...snmpAdd, "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ radiusPassword: "private" });
  });

  test.each([
    ["--hostname", "--type snmp requires --hostname"],
    ["--snmp-oid", "--type snmp requires --snmp-oid"],
    ["--json-path", "--type snmp requires --json-path"],
    ["--expected-value", "--type snmp requires --expected-value"],
  ])("add --type snmp without %s exits 2 before connecting", async (missing, msg) => {
    const k = await useFake({ profile: "2.x" });
    const idx = snmpAdd.indexOf(missing);
    const args = [...snmpAdd.slice(0, idx), ...snmpAdd.slice(idx + 2)];
    const r = await run(sb, args, creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls).toHaveLength(0);
  });

  test("add --type snmp --snmp-oid that is not an OID exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const args = [...snmpAdd];
    args[args.indexOf("--snmp-oid") + 1] = "not-an-oid";
    const r = await run(sb, args, creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--snmp-oid must be an OID like 1.3.6.1.4.1.9.6.1.101");
    expect(k.calls).toHaveLength(0);
  });

  test.each([
    ["snmpVersion=9", "snmpVersion must be one of 1, 2c, 3"],
    ["snmpOid=abc", "snmpOid must be an OID like 1.3.6.1.4.1.9.6.1.101"],
    ["snmpV3Username=", "snmpV3Username must be a non-empty string"],
  ])("add --type snmp --set %s exits 2 before connecting", async (set, msg) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, [...snmpAdd, "--set", set], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls).toHaveLength(0);
  });

  // v3 needs a username, and it can only be given on add — without one the
  // stored monitor would fail every beat and no edit could fix it
  test("add --type snmp --snmp-version 3 without a username exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, [...snmpAdd, "--snmp-version", "3"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("snmpV3Username must be a non-empty string");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type snmp --snmp-version 3 --snmp-v3-username stores it on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [...snmpAdd, "--snmp-version", "3", "--snmp-v3-username", "ops"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ snmpVersion: "3", snmpV3Username: "ops" });
  });

  // snmp_v3_username ships with snmp.js's v3 branch in 2.1.0 — on 2.0.x the
  // add would die on the missing column, so the field is gated
  test("add --type snmp --snmp-v3-username exits 2 on a 2.0.x server", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.0.2" } });
    const r = await run(
      sb,
      [...snmpAdd, "--snmp-version", "3", "--snmp-v3-username", "ops"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      '"snmpV3Username" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type snmp --snmp-v3-username is accepted at the 2.1.0 boundary", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.1.0" } });
    const r = await run(
      sb,
      [...snmpAdd, "--snmp-version", "3", "--snmp-v3-username", "ops"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s1")).toMatchObject({ snmpV3Username: "ops" });
  });

  test("add --type snmp exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(sb, snmpAdd, creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "snmp" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type snmp names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null });
    const r = await run(sb, snmpAdd, creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "snmp" needs Uptime Kuma 2.x; the server sent no version');
  });

  test("edit --set type=snmp fills the picker's defaults on 2.x", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=snmp",
        "--set",
        "hostname=rtr.example.com",
        "--set",
        "snmpOid=1.3.6.1.4.1.9.6.1.101",
        "--set",
        "jsonPath=$",
        "--set",
        "expectedValue=up",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "snmp",
      hostname: "rtr.example.com",
      port: 161,
      timeout: 5,
      snmpVersion: "2c",
      jsonPathOperator: "==",
    });
  });

  // the watcher resets a stored generic-default timeout to the new type's
  // pick — the http fixture's 48 becomes snmp's 5 like the port's 161
  test("edit --set type=http on an snmp monitor resets its watcher values", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=http", "--set", "url=https://example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ type: "http", timeout: 48, port: 161 });
  });

  test("edit --set type=snmp keeps a custom timeout", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), timeout: 120 }],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=snmp",
        "--set",
        "hostname=rtr.example.com",
        "--set",
        "snmpOid=1.3.6.1.4.1.9.6.1.101",
        "--set",
        "jsonPath=$",
        "--set",
        "expectedValue=up",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({ type: "snmp", timeout: 120 });
  });

  test("edit --set type=snmp without an OID fails on the merged monitor", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=snmp",
        "--set",
        "hostname=rtr.example.com",
        "--set",
        "jsonPath=$",
        "--set",
        "expectedValue=up",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("snmpOid must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  // the watcher replaces another type's well-known port — dns's 53 — with
  // the new type's own pick
  test("edit --set type=snmp replaces a dns monitor's port 53 with 161", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "h"),
          type: "dns",
          url: null,
          hostname: "dns.example.com",
          port: 53,
          dns_resolve_type: "A",
        },
      ],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=snmp",
        "--set",
        "snmpOid=1.3.6.1.4.1.9.6.1.101",
        "--set",
        "jsonPath=$",
        "--set",
        "expectedValue=up",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "snmp",
      hostname: "dns.example.com",
      port: 161,
    });
  });

  test("edit --set type=snmp keeps a custom port", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        { ...http(7, "h"), type: "port", url: null, hostname: "h.example.com", port: 8080 },
      ],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=snmp",
        "--set",
        "snmpOid=1.3.6.1.4.1.9.6.1.101",
        "--set",
        "jsonPath=$",
        "--set",
        "expectedValue=up",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({ type: "snmp", port: 8080 });
  });

  // a stored 161 is the snmp default the CLI wrote, so it reads as "another
  // type's default" to the watcher like upstream's own picks do
  test("edit --set type=smtp turns the stored snmp port 161 into smtp's 25", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=smtp", "--set", "hostname=mail.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ type: "smtp", port: 25 });
  });

  // no editMonitor reads snmpV3Username on any version — a set of it would
  // silently do nothing, like `active`
  test("edit --set snmpV3Username exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpV3Username=ops"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot set "snmpV3Username"');
    expect(r.stderr).toContain("editMonitor does not read it");
    expect(k.calls).toHaveLength(0);
  });

  test("edit --config-file snmpV3Username exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const f = join(sb.dir, "snmp.json");
    writeFileSync(f, JSON.stringify({ snmpV3Username: "ops" }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot set "snmpV3Username"');
    expect(k.calls).toHaveLength(0);
  });

  // a v1/v2c monitor going v3 needs a username it can never get — the stored
  // monitor would be dead and no edit could fix it
  test("edit --set snmpVersion=3 on a v2c monitor exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=3"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot set snmpVersion "3" on a monitor that is not already v3');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set snmpVersion=3 on a monitor already v3 is a no-op", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [snmpFixture(7, "s", { snmpVersion: "3", snmpV3Username: "ops" })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=3"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ snmpVersion: "3" });
  });

  test("edit --set snmpVersion=2c on a v3 monitor stores the downgrade", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [snmpFixture(7, "s", { snmpVersion: "3", snmpV3Username: "ops" })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=2c"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ snmpVersion: "2c" });
  });

  test("edit --set snmpVersion=bogus exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=bogus"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("snmpVersion must be one of 1, 2c, 3");
    expect(k.calls).toHaveLength(0);
  });

  test("edit --set snmpOid on an snmp monitor stores it", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "snmpOid=1.3.6.1.2.1.1.1.0"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ snmpOid: "1.3.6.1.2.1.1.1.0" });
  });

  test("edit --set snmpOid that splits the OID shape exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpOid=abc"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("snmpOid must be an OID like");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --json-path-operator on an snmp monitor stores it", async () => {
    const k = await useFake({ profile: "2.x", monitors: [snmpFixture(7, "s")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--json-path-operator", "contains"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({ jsonPathOperator: "contains" });
  });

  test("edit --set type=snmp exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=snmp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "snmp" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(editCalls(k)).toHaveLength(0);
  });

  // a v3 row keeps its username column through a type change away (no
  // editMonitor writes it) and its snmpVersion stays stored — so editing
  // back to snmp is legal: the row was v3, still is v3, and the username
  // it added with is still there
  test("a v3 monitor can leave snmp and come back", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [snmpFixture(7, "s", { snmpVersion: "3", snmpV3Username: "ops" })],
    });
    const away = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=http", "--set", "url=https://example.com"],
      creds(k.url),
    );
    expect(away.code).toBe(0);
    const back = await run(sb, ["monitors", "edit", "7", "--set", "type=snmp"], creds(k.url));
    expect(back.code).toBe(0);
    expect(stored(k, "s")).toMatchObject({
      type: "snmp",
      snmpVersion: "3",
      snmpV3Username: "ops",
    });
  });

  // a "3" written onto a non-snmp row forges the state a later type=snmp
  // edit would trust — the username that would prove it real is invisible
  // to toJSON — so both entry points refuse it; only the untouched carry
  // of a real v3 row may store it (the round trip above)
  test("edit --set snmpVersion=3 on an http monitor exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=3"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('snmpVersion "3" cannot be set on a non-snmp monitor');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("add --type http --set snmpVersion=3 exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h1",
        "--url",
        "https://example.com",
        "--set",
        "snmpVersion=3",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('snmpVersion "3" cannot be set on a non-snmp monitor');
    expect(addCalls(k)).toHaveLength(0);
  });

  // the column exists for v3 only — a username beside another version can
  // never be reached, since no edit turns the monitor v3 later
  test.each(["1", "2c"])(
    "add --type snmp --snmp-version %s --snmp-v3-username exits 2",
    async (version) => {
      const k = await useFake({ profile: "2.x" });
      const r = await run(
        sb,
        [...snmpAdd, "--snmp-version", version, "--snmp-v3-username", "ops"],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('snmpV3Username only applies to snmpVersion "3"');
      expect(addCalls(k)).toHaveLength(0);
    },
  );

  // the watcher reset is 2.x-only: the 1.x picker never touches timeout on
  // a type change, so even a 48 there is the user's own pick
  test.each([10, 48])(
    "edit --set type=keyword keeps a stored timeout %d on a 1.x server",
    async (timeout) => {
      const k = await useFake({ monitors: [{ ...http(7, "h"), timeout }] });
      const r = await run(
        sb,
        [
          "monitors",
          "edit",
          "7",
          "--set",
          "type=keyword",
          "--set",
          "url=https://example.com",
          "--set",
          "keyword=ok",
        ],
        creds(k.url),
      );
      expect(r.code).toBe(0);
      expect(stored(k, "h")).toMatchObject({ type: "keyword", timeout });
    },
  );

  // an empty username beside a non-3 version stores an empty column — the
  // hatch check already refuses "", so the flag path refuses it too
  test("add --type snmp --snmp-version 2c --snmp-v3-username '' exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [...snmpAdd, "--snmp-version", "2c", "--snmp-v3-username", ""],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('snmpV3Username only applies to snmpVersion "3"');
    expect(addCalls(k)).toHaveLength(0);
  });

  // the column survives a 2c downgrade (no editMonitor writes it) but the
  // stored version no longer proves it — the row could never have been v3
  // — so re-upgrading is refused even though the username may still exist
  test("a v3 monitor downgraded to 2c cannot be set back to 3", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [snmpFixture(7, "s", { snmpVersion: "3", snmpV3Username: "ops" })],
    });
    const down = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=2c"], creds(k.url));
    expect(down.code).toBe(0);
    const up = await run(sb, ["monitors", "edit", "7", "--set", "snmpVersion=3"], creds(k.url));
    expect(up.code).toBe(2);
    expect(up.stderr).toContain('cannot set snmpVersion "3" on a monitor that is not already v3');
    expect(stored(k, "s")).toMatchObject({ snmpVersion: "2c", snmpV3Username: "ops" });
  });

  // 2.x mirrors the watcher here too: a stored 48 turns into ping's 10 —
  // and when a custom ping_per_request_timeout no longer fits, the same
  // save the UI would lose fails the same way, with the bound named
  test("edit --set type=ping exits 2 when the stored per-request timeout outgrows the reset", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), ping_per_request_timeout: 15 }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ping", "--set", "hostname=127.0.0.1"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("at least ping_per_request_timeout (15)");
    expect(editCalls(k)).toHaveLength(0);
  });
});

describe("websocket-upgrade monitors", () => {
  // toJSON always emits both ws fields — the fixture carries the column
  // defaults like a real fetched row
  const ws = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    ...http(id, name),
    type: "websocket-upgrade",
    url: `wss://${name}.example.com`,
    accepted_statuscodes: ["1000"],
    wsSubprotocol: "",
    wsIgnoreSecWebsocketAcceptHeader: false,
    ...extra,
  });

  test("add --type websocket-upgrade sends the ws close-code default and the generic timeout", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com/feed",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(m.type).toBe("websocket-upgrade");
    expect(m.url).toBe("wss://ws.example.com/feed");
    expect(m.accepted_statuscodes).toEqual(["1000"]);
    expect(m.timeout).toBe(48);
  });

  test("add --type websocket-upgrade accepts a plain ws:// url", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "ws://127.0.0.1:9000/socket",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).url).toBe(
      "ws://127.0.0.1:9000/socket",
    );
  });

  test("add --type websocket-upgrade without a url exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "websocket-upgrade", "--name", "ws1"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires --url");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type websocket-upgrade with an https url exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "https://ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type websocket-upgrade with an unparseable url exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "websocket-upgrade", "--name", "ws1", "--url", "notaurl"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(addCalls(k)).toHaveLength(0);
  });

  // `new WebSocket` throws SyntaxError on a fragment before connecting —
  // the stored monitor could never check
  test("add --type websocket-upgrade with a fragment url exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com/#health",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("fragment");
    expect(addCalls(k)).toHaveLength(0);
  });

  // a --config-file url may carry userinfo the flag paths refused — the
  // scheme refusal must not echo it to stderr
  test("add --type websocket-upgrade redacts userinfo in the scheme refusal", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "wscred.json");
    writeFileSync(f, JSON.stringify({ url: "https://wsuser:wspass@ws.example.com" }));
    const r = await run(
      sb,
      ["monitors", "add", "--type", "websocket-upgrade", "--name", "ws1", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("https://***@ws.example.com");
    expect(r.stderr).not.toContain("wsuser");
    expect(r.stderr).not.toContain("wspass");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add keeps an explicit accepted_statuscodes over the ws default", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        'accepted_statuscodes=["1000","1006"]',
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).accepted_statuscodes).toEqual([
      "1000",
      "1006",
    ]);
  });

  // an explicit "200-299" reads identical to the http default but is the
  // user's own choice — the picker's watcher ran before the user typed it
  test("add keeps an explicit accepted_statuscodes that equals the http default", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        'accepted_statuscodes=["200-299"]',
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).accepted_statuscodes).toEqual([
      "200-299",
    ]);
  });

  test("add --set url=wss:// counts as the required url", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--set",
        "url=wss://ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).url).toBe("wss://ws.example.com");
  });

  // upstream submit()'s acceptList (not its stricter wss?:// input
  // pattern) is the gate: ws:foo parses with host "foo" and the ws
  // library dials it like ws://foo, so storing it is not a dead check
  test("add --type websocket-upgrade accepts a scheme-relative url like ws:foo", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "ws:ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).url).toBe("ws:ws.example.com");
  });

  test("add --type websocket-upgrade refuses a ws url without a host", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "websocket-upgrade", "--name", "ws1", "--url", "wss://"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(addCalls(k)).toHaveLength(0);
  });

  // websocket-upgrade.js strips whitespace then splits on commas — an
  // empty token makes new WebSocket throw at every check
  test("add --set wsSubprotocol with an empty entry exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsSubprotocol=soap,,mqtt",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("wsSubprotocol");
    expect(addCalls(k)).toHaveLength(0);
  });

  // the ws client also throws SyntaxError on a duplicated subprotocol
  test("add --set wsSubprotocol with a duplicate entry exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsSubprotocol=soap, soap",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("wsSubprotocol");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set wsSubprotocol accepts comma-separated names with spaces", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsSubprotocol=soap, graphql-ws",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).wsSubprotocol).toBe(
      "soap, graphql-ws",
    );
  });

  test("add --set wsSubprotocol stores it", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsSubprotocol=soap,chat",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect((addCalls(k)[0]!.args[0] as Record<string, unknown>).wsSubprotocol).toBe("soap,chat");
  });

  test("add --set wsSubprotocol=5 exits 2 (non-string)", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsSubprotocol=5",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("wsSubprotocol must be a string");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set wsIgnoreSecWebsocketAcceptHeader=true stores the boolean", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsIgnoreSecWebsocketAcceptHeader=true",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(
      (addCalls(k)[0]!.args[0] as Record<string, unknown>).wsIgnoreSecWebsocketAcceptHeader,
    ).toBe(true);
  });

  test("add --set wsIgnoreSecWebsocketAcceptHeader=yes exits 2 (non-boolean)", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
        "--set",
        "wsIgnoreSecWebsocketAcceptHeader=yes",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("wsIgnoreSecWebsocketAcceptHeader must be a boolean");
    expect(addCalls(k)).toHaveLength(0);
  });

  // websocket-upgrade.js and its ws_* columns first ship in 2.1.0 — on 1.x
  // and 2.0.x an add would store a row whose checks all throw "Unknown
  // Monitor Type", so the type names its real minimum.
  test("add --type websocket-upgrade exits 2 on a 1.x server naming 2.1.0", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "websocket-upgrade" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type websocket-upgrade exits 2 on 2.0.x naming 2.1.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.0.2" } });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "websocket-upgrade" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type websocket-upgrade runs at the 2.1.0 boundary", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.1.0" } });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "websocket-upgrade",
        "--name",
        "ws1",
        "--url",
        "wss://ws.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(addCalls(k)).toHaveLength(1);
  });

  // the watcher's swap only reaches an empty url or the counterpart's
  // placeholder; a real https url stays and the scheme refusal reports it
  // instead of storing a monitor that can never connect
  test("edit --set type=websocket-upgrade keeps a real https url and exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=websocket-upgrade"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=websocket-upgrade --set url=wss:// swaps the http status default", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h");
    expect(m.type).toBe("websocket-upgrade");
    expect(m.url).toBe("wss://wsserver.example.com");
    expect(m.accepted_statuscodes).toEqual(["1000"]);
  });

  // the placeholder "https://" swaps to "wss://", which is not a usable url
  // — the picker relies on the user's typed url winning the same moment
  test("edit --set type=websocket-upgrade on a placeholder url still needs --set url", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { url: "https://" })],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=websocket-upgrade"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=websocket-upgrade keeps a custom status list", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { accepted_statuscodes: ["200-299", "500"] })],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").accepted_statuscodes).toEqual(["200-299", "500"]);
  });

  // upstream's "empty" is a truthiness check — a stored [] is a set list
  // and stays, matching the watcher's literal behavior
  test("edit --set type=websocket-upgrade keeps a stored empty status list", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { accepted_statuscodes: [] })],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").accepted_statuscodes).toEqual([]);
  });

  test("edit --set accepted_statuscodes wins over the ws swap", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
        "--set",
        'accepted_statuscodes=["1006"]',
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").accepted_statuscodes).toEqual(["1006"]);
  });

  // leaving websocket-upgrade with an explicit url, the status default
  // swaps back to the http family's
  test("edit --set type=http --set url restores the http status default", async () => {
    const k = await useFake({ profile: "2.x", monitors: [ws(7, "w")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=http", "--set", "url=https://www.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "w");
    expect(m.type).toBe("http");
    expect(m.url).toBe("https://www.example.com");
    expect(m.accepted_statuscodes).toEqual(["200-299"]);
  });

  // a stored placeholder swaps to "https://", which submit()'s gate then
  // refuses — upstream's identical outcome, since new URL("https://")
  // throws in its submit too
  test("edit --set type=http on a placeholder wss:// url still needs --set url", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [ws(7, "w", { url: "wss://" })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=http"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("http:// or https://");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=http keeps a custom ws status list", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [ws(7, "w", { accepted_statuscodes: ["1000", "1006"] })],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=http", "--set", "url=https://www.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "w").accepted_statuscodes).toEqual(["1000", "1006"]);
  });

  // 1.23's type watcher has no websocket-upgrade branch — nothing swaps
  test("edit --set type=websocket-upgrade exits 2 on a 1.x server before any swap", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "websocket-upgrade" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=websocket-upgrade exits 2 on 2.0.x naming 2.1.0", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.0.2" },
      monitors: [http(7, "h")],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "websocket-upgrade" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set wsSubprotocol and wsIgnoreSecWebsocketAcceptHeader store on the ws row", async () => {
    const k = await useFake({ profile: "2.x", monitors: [ws(7, "w")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "wsSubprotocol=soap",
        "--set",
        "wsIgnoreSecWebsocketAcceptHeader=true",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "w");
    expect(m.wsSubprotocol).toBe("soap");
    expect(m.wsIgnoreSecWebsocketAcceptHeader).toBe(true);
  });

  // the http-direction swap turns an unset url into "https://", which
  // submit()'s acceptList then refuses — the same refusal a base edit
  // gave the url-less monitor, not a stored dead placeholder
  test("edit --set type=http on a url-less monitor exits 2 like base", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "p"), type: "push", url: null, accepted_statuscodes: null }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=http"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("http:// or https://");
    expect(editCalls(k)).toHaveLength(0);
  });

  // a real wss:// url is not the placeholder, so it stays — and the http
  // family's acceptList refuses it exactly like submit() would
  test("edit --set type=http refuses a stored wss:// url", async () => {
    const k = await useFake({ profile: "2.x", monitors: [ws(7, "w")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=http"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("http:// or https://");
    expect(editCalls(k)).toHaveLength(0);
  });

  // json-query shares the url field and the http acceptList; upstream's
  // watcher just has no swap branch for it
  test("edit --set type=json-query refuses a stored wss:// url", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [ws(7, "w", { jsonPath: "$.ok", expectedValue: "ok" })],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=json-query"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("http:// or https://");
    expect(editCalls(k)).toHaveLength(0);
  });

  // real-browser's acceptList entry is null — any parseable scheme — so
  // upstream's submit accepts a wss:// url there even though playwright
  // could never navigate to it; the CLI mirrors the gate, not the outcome
  test("edit --set type=real-browser keeps a stored wss:// url", async () => {
    const k = await useFake({ profile: "2.x", monitors: [ws(7, "w")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=real-browser"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "w").url).toBe("wss://w.example.com");
  });

  // the acceptList also guards a plain url edit on a ws monitor — a
  // stored https:// url could never connect
  test("edit --set url=https:// on a ws monitor exits 2 without a type change", async () => {
    const k = await useFake({ profile: "2.x", monitors: [ws(7, "w")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "url=https://w.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ws:// or wss://");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=websocket-upgrade swaps a stored null status list", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { accepted_statuscodes: null })],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=websocket-upgrade",
        "--set",
        "url=wss://wsserver.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").accepted_statuscodes).toEqual(["1000"]);
  });
});

describe("oracledb monitors", () => {
  // the secrets (connection string and basic_auth_pass) travel by
  // --config-file; basic_auth_user is not a secret and fits --set
  const oraFile = (extra: Record<string, unknown> = {}) => {
    const f = join(sb.dir, "ora.json");
    writeFileSync(
      f,
      JSON.stringify({
        databaseConnectionString: "dbhost.example.com:1521/FREEPDB1",
        basic_auth_pass: "ora-pw",
        ...extra,
      }),
    );
    return f;
  };

  const oraArgs = (file: string) => [
    "monitors",
    "add",
    "--type",
    "oracledb",
    "--name",
    "ora1",
    "--set",
    "basic_auth_user=scott",
    "--config-file",
    file,
  ];

  test("add sends the connection string, credentials and query", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [...oraArgs(oraFile()), "--database-query", "SELECT 1 FROM DUAL"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.type).toBe("oracledb");
    expect(sent.databaseConnectionString).toBe("dbhost.example.com:1521/FREEPDB1");
    expect(sent.basic_auth_user).toBe("scott");
    expect(sent.basic_auth_pass).toBe("ora-pw");
    expect(sent.databaseQuery).toBe("SELECT 1 FROM DUAL");
  });

  test("add without --database-query sends none for the server's SELECT 1 FROM DUAL", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, oraArgs(oraFile()), creds(k.url));
    expect(r.code).toBe(0);
    const sent = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.databaseQuery).toBeUndefined();
  });

  test("add without databaseConnectionString exits 2 and sends no add", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ora-noconn.json");
    writeFileSync(f, JSON.stringify({ basic_auth_pass: "ora-pw" }));
    const r = await run(sb, oraArgs(f), creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("databaseConnectionString");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add without basic_auth_user exits 2 and sends no add", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "oracledb", "--name", "ora1", "--config-file", oraFile()],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("basic_auth_user");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add without basic_auth_pass exits 2 and sends no add", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "ora-nopass.json");
    writeFileSync(
      f,
      JSON.stringify({ databaseConnectionString: "dbhost.example.com:1521/FREEPDB1" }),
    );
    const r = await run(sb, oraArgs(f), creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("basic_auth_pass");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set basic_auth_pass is refused before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "oracledb", "--name", "ora1", "--set", "basic_auth_pass=x"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type oracledb exits 2 on a 1.x server naming 2.3.0", async () => {
    const k = await useFake();
    const r = await run(sb, oraArgs(oraFile()), creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "oracledb" needs Uptime Kuma >= 2.3.0; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type oracledb exits 2 on 2.2.x naming 2.3.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.2.1" } });
    const r = await run(sb, oraArgs(oraFile()), creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "oracledb" needs Uptime Kuma >= 2.3.0; the server reports 2.2.1',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type oracledb runs at the 2.3.0 boundary", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.3.0" } });
    const r = await run(sb, oraArgs(oraFile()), creds(k.url));
    expect(r.code).toBe(0);
    expect(addCalls(k)).toHaveLength(1);
  });

  test("add with an empty basic_auth_pass exits 2 and sends no add", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = oraFile({ basic_auth_pass: "" });
    const r = await run(sb, oraArgs(f), creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("basic_auth_pass");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set type=oracledb without the fields exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "type=oracledb"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("databaseConnectionString");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=oracledb with a full config file stores it", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const f = oraFile({ basic_auth_user: "scott" });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=oracledb", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").type).toBe("oracledb");
    expect(stored(k, "h").basic_auth_pass).toBe("ora-pw");
  });

  test("edit without touching the credentials keeps them on a stored oracledb", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        http(7, "ora1", {
          type: "oracledb",
          url: null,
          databaseConnectionString: "dbhost.example.com:1521/FREEPDB1",
          basic_auth_user: "scott",
          basic_auth_pass: "ora-pw",
        }),
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=x"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "ora1").basic_auth_pass).toBe("ora-pw");
    expect(stored(k, "ora1").basic_auth_user).toBe("scott");
  });

  // a stored value the edit does not touch is never re-judged — a raw
  // socket client could store the row without credentials and a plain
  // edit still passes, like every other required field
  test("edit on a stored oracledb missing credentials does not re-judge it", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        http(7, "ora1", {
          type: "oracledb",
          url: null,
          databaseConnectionString: "dbhost.example.com:1521/FREEPDB1",
          basic_auth_user: "scott",
        }),
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "description=x"], creds(k.url));
    expect(r.code).toBe(0);
  });

  // the picker's watcher resets conditions on every type change — a carried
  // list would name another type's variables and throw at every check
  test("edit type change into oracledb clears stored conditions", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        http(7, "ora1", {
          type: "dns",
          conditions: [{ variable: "record", operator: "==", value: "x" }],
        }),
      ],
    });
    const f = oraFile({ basic_auth_user: "scott" });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=oracledb", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.conditions).toEqual([]);
  });

  test("edit type change keeps a conditions list the same edit sets", async () => {
    const conditions = [{ variable: "result", operator: "==", value: "1" }];
    const k = await useFake({
      profile: "2.x",
      monitors: [
        http(7, "ora1", {
          type: "dns",
          conditions: [{ variable: "record", operator: "==", value: "x" }],
        }),
      ],
    });
    const f = oraFile({ basic_auth_user: "scott", conditions });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=oracledb", "--config-file", f],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent.conditions).toEqual(conditions);
  });
});

describe("system-service monitors", () => {
  // the picker offers the type only on a linux or win32 host outside a
  // container; the fake's default 2.x info is the container image
  const linuxHost = {
    version: "2.5.11",
    isContainer: false,
    runtime: { platform: "linux", arch: "x64" },
    dbType: "sqlite",
    primaryBaseURL: null,
  };

  test("add --type system-service stores the service name on a linux host", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx.service",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "svc1");
    expect(m.type).toBe("system-service");
    expect(m.system_service_name).toBe("nginx.service");
    expect(m.conditions).toEqual([]);
  });

  test("add --type system-service runs on a win32 host too", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { ...linuxHost, runtime: { platform: "win32", arch: "x64" } },
    });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "W32Time",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "svc1").system_service_name).toBe("W32Time");
  });

  test("add --type system-service without --system-service-name exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "system-service", "--name", "svc1"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type system-service requires --system-service-name");
    expect(k.calls).toHaveLength(0);
  });

  // monitor.js trims then requires letters, digits and . _ - @ only — the
  // picker's hint pattern is looser and would let this through
  test("add --system-service-name with a space exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "my service",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("service name pattern");
    expect(k.calls).toHaveLength(0);
  });

  // monitor.js reassigns the trimmed name in validate(), so the wire value
  // is trimmed the same way — surrounding whitespace never reaches the row
  test("add --system-service-name trims surrounding whitespace before storing", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "  nginx.service  ",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "svc1").system_service_name).toBe("nginx.service");
  });

  test("add --set system_service_name trims surrounding whitespace too", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx.service",
        "--set",
        "system_service_name=  memcached  ",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "svc1").system_service_name).toBe("memcached");
  });

  // a hatch key beats the flag in the merge, so the merged value is judged
  // again in validateFinalMonitor after connect
  test("add --set system_service_name overrides the flag and is pattern-checked", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
        "--set",
        "system_service_name=bad name",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system_service_name must match the service name pattern");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set system_service_name= exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
        "--set",
        "system_service_name=",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system_service_name must be a non-empty string");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type system-service exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "system-service" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type system-service names the assumed 1.x when no version arrives", async () => {
    const k = await useFake({ info: null });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "system-service" needs Uptime Kuma >= 2.1.0; the server sent no version',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  // system-service.js first ships in 2.1.0 (upstream #6488): on 2.0.x the row
  // would store and every check would throw "Unknown Monitor Type"
  test("add --type system-service exits 2 on a 2.0 server naming 2.1.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.0.2" } });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "system-service" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type system-service runs on 2.1.0, the first release with the type", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { ...linuxHost, version: "2.1.0" },
    });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "svc1")).toMatchObject({
      type: "system-service",
      system_service_name: "nginx",
    });
  });

  // the picker hides the type on the official container image, which has no
  // systemctl / Get-Service to shell out to
  test("add --type system-service exits 2 on the container image", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system-service is not available");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type system-service exits 2 on a darwin host", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { ...linuxHost, runtime: { platform: "darwin", arch: "arm64" } },
    });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "system-service",
        "--name",
        "svc1",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system-service is not available");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set type=system-service stores it on a linux host", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost, monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=system-service",
        "--set",
        "system_service_name=nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({
      type: "system-service",
      system_service_name: "nginx",
    });
  });

  test("edit --set type=system-service needs the service name on the merged monitor", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost, monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=system-service"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system_service_name must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=system-service exits 2 on the container image", async () => {
    const k = await useFake({ profile: "2.x", monitors: [http(7, "h")] });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "7",
        "--set",
        "type=system-service",
        "--set",
        "system_service_name=nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system-service is not available");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=system-service exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "h")] });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=system-service"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "system-service" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set system_service_name stores a new name on a system-service monitor", async () => {
    const k = await useFake({
      profile: "2.x",
      info: linuxHost,
      monitors: [
        {
          ...http(7, "svc"),
          type: "system-service",
          url: null,
          system_service_name: "nginx",
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "system_service_name=postgresql"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "svc").system_service_name).toBe("postgresql");
  });

  // the field's own min version is 2.1.0 too — the type gate cannot cover a
  // --set on another type, so the field gate refuses it on 2.0.x
  test("add --set system_service_name on a 2.0 server exits 2 naming 2.1.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.0.2" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "p1", "--set", "system_service_name=nginx"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"system_service_name" needs Uptime Kuma >= 2.1.0');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("--system-service-name refuses another type before connecting", async () => {
    const k = await useFake({ profile: "2.x", info: linuxHost });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h1",
        "--url",
        "https://h.example.com",
        "--system-service-name",
        "nginx",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--system-service-name only applies to --type system-service");
    expect(k.calls).toHaveLength(0);
  });
});

describe("pm2 monitors", () => {
  // the picker's select is fed by getPM2ProcessList; the fake's default
  // answer lists an online "api" and a stopped "worker"
  test("add --type pm2 stores a process name from the server's list", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "pm1");
    expect(m.type).toBe("pm2");
    expect(m.system_service_name).toBe("api");
    expect(m.conditions).toEqual([]);
  });

  // the select only offers listed names, so a typo would store a monitor
  // that goes down at its first check
  test("add --type pm2 with a name outside the list exits 1", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "typo"],
      creds(k.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('PM2 process "typo" is not in the server\'s PM2 process list');
    expect(addCalls(k)).toHaveLength(0);
  });

  // check() matches name or id, and the picker's load rewrites a saved id
  // to the stable name — the CLI does the same before storing
  test("add --type pm2 with a process id stores the process name", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "1"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("worker");
  });

  // ok:false is the picker's free-text path (no pm2 on the server), not a
  // refusal — the name is stored unverified with a warning
  test("add --type pm2 stores unverified when the server cannot list processes", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: { ok: false, msg: "Unable to query PM2 process list." },
    });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "anything"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("anything");
    expect(r.stderr).toContain("could not list PM2 processes");
  });

  test("add --type pm2 stores unverified when the process list is empty", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: { ok: true, processList: [] },
    });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "pm2",
        "--name",
        "pm1",
        "--system-service-name",
        "later-process",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("later-process");
    expect(r.stderr).toContain("process list is empty");
  });

  test("add --type pm2 without --system-service-name exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(sb, ["monitors", "add", "--type", "pm2", "--name", "pm1"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type pm2 requires --system-service-name");
    expect(k.calls).toHaveLength(0);
  });

  // unlike system-service, pm2's validate() only refuses control
  // characters — a spaced process name is legal
  test("add --type pm2 accepts a name with spaces", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: { ok: false, msg: "no pm2" },
    });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "my api"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("my api");
  });

  test("add --system-service-name with a control character exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api\u0001"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must not contain control characters");
    expect(k.calls).toHaveLength(0);
  });

  test("add --set system_service_name with a control character exits 2 after connect", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: { ok: false, msg: "no pm2" },
    });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "pm2",
        "--name",
        "pm1",
        "--system-service-name",
        "api",
        "--set",
        "system_service_name=bad\u0001name",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("system_service_name must not contain control characters");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type pm2 exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "pm2" needs Uptime Kuma >= 2.5.0; the server reports 1.23.17');
    expect(addCalls(k)).toHaveLength(0);
  });

  // pm2.js first ships in 2.5.0 (upstream #7114): on 2.4.x the row would
  // store fine but every check would throw "Unknown Monitor Type"
  test("add --type pm2 exits 2 on a 2.4 server naming 2.5.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.4.9" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "pm2" needs Uptime Kuma >= 2.5.0; the server reports 2.4.9');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type pm2 runs on 2.5.0, the first release with the type", async () => {
    const k = await useFake({
      profile: "2.x",
      info: { version: "2.5.0" },
      getPM2ProcessListResult: { ok: false, msg: "no pm2" },
    });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("api");
  });

  test("add --type pm2 with a malformed processList exits 70", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: { ok: true, processList: "nope" },
    });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected getPM2ProcessList response");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type pm2 exits 70 on a malformed row even when another row matches", async () => {
    const k = await useFake({
      profile: "2.x",
      getPM2ProcessListResult: {
        ok: true,
        processList: [
          { id: "0", name: "api", status: "online" },
          { id: "1", name: 42, status: "online" },
        ],
      },
    });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected getPM2ProcessList response");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set type=pm2 stores it with a listed process name", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "h1", "--set", "type=pm2", "--set", "system_service_name=worker"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h1");
    expect(m.type).toBe("pm2");
    expect(m.system_service_name).toBe("worker");
  });

  test("edit --set type=pm2 exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake();
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "h1", "--set", "type=pm2"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "pm2" needs Uptime Kuma >= 2.5.0; the server reports 1.23.17');
    expect(editCalls(k)).toHaveLength(0);
  });

  // the name check runs when the type changes to pm2 or the name itself is
  // touched — an unrelated edit never asks for the process list
  test("edit on a pm2 monitor checks membership only when the name is touched", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    k.calls.length = 0;
    const r = await run(sb, ["monitors", "edit", "pm1", "--set", "interval=60"], creds(k.url));
    expect(r.code).toBe(0);
    expect(k.calls.filter((c) => c.event === "getPM2ProcessList")).toHaveLength(0);

    const bad = await run(
      sb,
      ["monitors", "edit", "pm1", "--set", "system_service_name=typo"],
      creds(k.url),
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('PM2 process "typo" is not in the server\'s PM2 process list');
    expect(editCalls(k)).toHaveLength(1);
  });

  test("edit --set system_service_name on a pm2 monitor stores a listed name", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "pm2", "--name", "pm1", "--system-service-name", "api"],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "pm1", "--set", 'system_service_name="1"'],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "pm1").system_service_name).toBe("worker");
  });
});

describe("sftp monitors", () => {
  // the picker's Authentication Method select defaults to its first option,
  // so an add that names no method stores it like the UI would
  test("add --type sftp stores hostname, port 22, username and the default method", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      type: "sftp",
      hostname: "sftp.example.com",
      port: 22,
      sshUsername: "deploy",
      sshAuthMethod: "password",
      sshPassword: "fixture-ssh-secret",
    });
    expect(stored(k, "sftp1").sshAuthMethod).toBe("password");
  });

  test("add --type sftp honors --port and --sftp-path", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--port",
        "2222",
        "--ssh-username",
        "deploy",
        "--sftp-path",
        "/srv/data",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "sftp1");
    expect(m.port).toBe(2222);
    expect(m.sftpPath).toBe("/srv/data");
  });

  // the picker's key-auth branch swaps the password field for a required
  // private key plus an optional passphrase
  test("add --type sftp with privateKey auth stores key and passphrase", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(
      f,
      JSON.stringify({
        sshAuthMethod: "privateKey",
        sshPrivateKey: "fixture-key-material",
        sshPassphrase: "fixture-key-pass",
      }),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "sftp1");
    expect(m.sshAuthMethod).toBe("privateKey");
    expect(m.sshPrivateKey).toBe("fixture-key-material");
    expect(m.sshPassphrase).toBe("fixture-key-pass");
    expect(m.sshPassword).toBeUndefined();
  });

  test("add --type sftp --ssh-auth-method privateKey needs no password secret", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPrivateKey: "fixture-key-material" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--ssh-auth-method",
        "privateKey",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "sftp1").sshAuthMethod).toBe("privateKey");
  });

  test("add --type sftp without --hostname exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "sftp", "--name", "sftp1", "--ssh-username", "deploy"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type sftp requires --hostname");
    expect(k.calls).toHaveLength(0);
  });

  test("add --type sftp without --ssh-username exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "sftp", "--name", "sftp1", "--hostname", "sftp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type sftp requires --ssh-username");
    expect(k.calls).toHaveLength(0);
  });

  // the password field is required="true" in the picker whenever the
  // method is not privateKey — the merged monitor is judged the same way
  test("add --type sftp without a credential exits 2 after connect", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshPassword must be a non-empty string");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type sftp --ssh-auth-method privateKey without a key exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--ssh-auth-method",
        "privateKey",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshPrivateKey must be a non-empty string");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set sshAuthMethod outside the picker's options exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--set",
        "sshAuthMethod=keyboard-interactive",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshAuthMethod must be one of password, privateKey");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set sshAuthMethod as a non-string exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--set",
        "sshAuthMethod=3",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshAuthMethod must be one of password, privateKey");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --set sftpPath as a non-string exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--set",
        "sftpPath=42",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sftpPath must be a string or null");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type sftp exits 2 on a 1.x server after connect", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "sftp" needs Uptime Kuma >= 2.5.4; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  // sftp.js first ships in 2.5.4 (upstream #7034): on 2.5.3 the row would
  // store fine but every check would throw "Unknown Monitor Type"
  test("add --type sftp exits 2 on a 2.5.3 server naming 2.5.4", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.5.3" } });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('type "sftp" needs Uptime Kuma >= 2.5.4; the server reports 2.5.3');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type sftp runs on 2.5.4, the first release with the type", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.5.4" } });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "sftp1").type).toBe("sftp");
  });

  test("monitors get redacts the sftp secrets", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(
      f,
      JSON.stringify({
        sshPassword: "fixture-hidden-pass",
        sshPrivateKey: "fixture-hidden-key",
      }),
    );
    const add = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(add.code).toBe(0);
    const id = add.json().id as number;
    const get = await run(sb, ["monitors", "get", String(id)], creds(k.url));
    expect(get.code).toBe(0);
    expect(get.stdout).not.toContain("fixture-hidden-pass");
    expect(get.stdout).not.toContain("fixture-hidden-key");
    expect(get.json().sshPassword).toBe("***");
    expect(get.json().sshPrivateKey).toBe("***");
  });

  test("edit --set type=sftp needs the new type's fields on the merged monitor", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=sftp",
        "--set",
        "hostname=sftp.example.com",
        "--set",
        "sshUsername=deploy",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshPassword must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=sftp stores the fields a config-file supplies", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=sftp",
        "--set",
        "hostname=sftp.example.com",
        "--set",
        "sshUsername=deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h1");
    expect(m.type).toBe("sftp");
    expect(m.hostname).toBe("sftp.example.com");
    expect(m.port).toBe(22);
    expect(m.sshUsername).toBe("deploy");
    expect(m.sshPassword).toBe("fixture-ssh-secret");
  });

  // switching the method on an existing monitor needs the new method's
  // credential in the merged monitor — the stored password does not count
  test("edit --set sshAuthMethod=privateKey on a password monitor exits 2 without a key", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "sftp1", "--set", "sshAuthMethod=privateKey"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("sshPrivateKey must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set sshAuthMethod=privateKey with a key via config-file stores it", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    const g = join(sb.dir, "sftp-key.json");
    writeFileSync(g, JSON.stringify({ sshPrivateKey: "fixture-key-material" }));
    const r = await run(
      sb,
      ["monitors", "edit", "sftp1", "--set", "sshAuthMethod=privateKey", "--config-file", g],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "sftp1");
    expect(m.sshAuthMethod).toBe("privateKey");
    expect(m.sshPrivateKey).toBe("fixture-key-material");
    // the stored password survives the switch, like the picker's hidden
    // fields do — sftp.js only reads the key under privateKey
    expect(m.sshPassword).toBe("fixture-ssh-secret");
  });

  // an unrelated edit keeps the stored credentials: the pairing is only
  // judged when an auth field or the type is touched
  test("edit of an unrelated field keeps the stored sftp credentials", async () => {
    const k = await useFake({ profile: "2.x" });
    const f = join(sb.dir, "sftp.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "fixture-ssh-secret" }));
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "sftp",
        "--name",
        "sftp1",
        "--hostname",
        "sftp.example.com",
        "--ssh-username",
        "deploy",
        "--config-file",
        f,
      ],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "sftp1", "--set", "interval=120"], creds(k.url));
    expect(r.code).toBe(0);
    const m = stored(k, "sftp1");
    expect(m.interval).toBe(120);
    expect(m.sshPassword).toBe("fixture-ssh-secret");
    expect(m.sshUsername).toBe("deploy");
  });

  test("edit --set type=sftp exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake();
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "h1", "--set", "type=sftp"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "sftp" needs Uptime Kuma >= 2.5.4; the server reports 1.23.17',
    );
    expect(editCalls(k)).toHaveLength(0);
  });
});

describe("globalping monitors", () => {
  // the picker's watcher chain on add: subtype defaults to ping, the
  // transient ping state leaves port 80, the first-selection protocol
  // pick is ICMP, location is monitorDefaults' "world" and the resolver
  // stays empty like the 2.x defaults (globalping.js only sets a
  // resolver for a truthy value)
  test("add --type globalping stores the picker's ping defaults", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      type: "globalping",
      subtype: "ping",
      location: "world",
      protocol: "ICMP",
      port: 80,
      hostname: "example.com",
      dns_resolve_server: "",
    });
    expect(stored(k, "gp1").subtype).toBe("ping");
  });

  // the dns subtype's watcher picks UDP and port 53, and its RR-type
  // select offers the wider globalping list (HTTPS is dns-type-invalid)
  test("add --type globalping --subtype dns picks UDP/53 and the GP RR list", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "dns",
        "--hostname",
        "example.com",
        "--dns-resolve-type",
        "HTTPS",
        "--location",
        "amazon+germany",
        "--ip-family",
        "ipv4",
        "--dns-resolve-server",
        "9.9.9.9",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m).toMatchObject({
      subtype: "dns",
      protocol: "UDP",
      port: 53,
      hostname: "example.com",
      dns_resolve_type: "HTTPS",
      dns_resolve_server: "9.9.9.9",
      location: "amazon+germany",
      ipFamily: "ipv4",
    });
  });

  // the http subtype reads url, not hostname; its protocol pick is the
  // null auto-select so the column stays unset, and port keeps the
  // transient ping state's 80 like the picker stores it
  test("add --type globalping --subtype http stores the url and no protocol", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "http",
        "--url",
        "https://example.com/health",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = addCalls(k)[0]!.args[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      subtype: "http",
      url: "https://example.com/health",
      port: 80,
      location: "world",
    });
    expect(sent.hostname).toBeUndefined();
    expect(sent.protocol).toBeUndefined();
  });

  test("add --type globalping --subtype http without --url exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--subtype", "http"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("url must be a non-empty string");
  });

  // the url input's https?://.+ pattern is the picker's only scheme gate
  test("add --type globalping --subtype http refuses a non-http url", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "http",
        "--url",
        "ftp://example.com/file",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("url must be a http:// or https:// url");
  });

  test("add --type globalping without --hostname exits 2 for the ping subtype", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname must be a non-empty string");
  });

  test("add --type globalping --subtype dns without --hostname exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--subtype", "dns"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("hostname must be a non-empty string");
  });

  // isInputValid refuses a comma — one probe region per monitor
  test("add --type globalping refuses a comma in --location", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--hostname",
        "example.com",
        "--location",
        "world,aws+eu-west",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("location cannot contain multiple locations");
  });

  test("add --type globalping --set subtype=bogus exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--hostname",
        "example.com",
        "--set",
        "subtype=bogus",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("subtype must be one of ping, http, dns");
    expect(k.calls).toHaveLength(0);
  });

  // the Protocol select offers ICMP/TCP for ping, UDP/TCP for dns and
  // only unset/HTTP2 for http — a value outside the merged subtype's
  // options is a monitor that can never check
  test("add --type globalping refuses a protocol its subtype does not offer", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "ping",
        "--hostname",
        "example.com",
        "--protocol",
        "UDP",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("protocol must be ICMP or TCP");
  });

  test("add --type globalping --subtype http accepts --protocol HTTP2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "http",
        "--url",
        "https://example.com",
        "--protocol",
        "HTTP2",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "gp1").protocol).toBe("HTTP2");
  });

  // expectedValue switches the http check to json-query, which reads
  // jsonPath — without one every beat can only fail
  test("add --type globalping --subtype http --expected-value without --json-path exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "http",
        "--url",
        "https://example.com",
        "--expected-value",
        "200",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("jsonPath must be a non-empty string");
  });

  // the dns subtype's RR select lacks CAA while the dns type's lacks
  // HTTPS — the merged monitor is judged against its own list
  test("add --type globalping --subtype dns refuses a dns-only RR type", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "dns",
        "--hostname",
        "example.com",
        "--dns-resolve-type",
        "CAA",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_type must be one of");
  });

  test("add --type dns refuses a globalping-only RR type", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "dns",
        "--name",
        "d1",
        "--hostname",
        "example.com",
        "--dns-resolve-type",
        "HTTPS",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_type must be one of");
  });

  // the port input is required for dns always and for ping only under
  // TCP; under ICMP a stored null port is as good as the picker's blank.
  // --set cannot write a null port (the hatch wants a number), so the
  // states come from a stored row like a pre-CLI monitor would have
  const gpSeed = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    type: "globalping",
    active: true,
    subtype: "ping",
    location: "world",
    protocol: "ICMP",
    hostname: "example.com",
    port: null,
    url: null,
    interval: 60,
    retryInterval: 60,
    timeout: 48,
    proxyId: null,
    docker_host: null,
    dns_resolve_server: "",
    parent: null,
    maxretries: 0,
    notificationIDList: {},
    accepted_statuscodes: ["200-299"],
    ...extra,
  });

  test("edit --set protocol=TCP on a port-less ping monitor exits 2", async () => {
    const k = await useFake({ profile: "2.x", monitors: [gpSeed(7, "gp")] });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", "protocol=TCP"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("port must be a port number");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set protocol=ICMP keeps a stored null port", async () => {
    const k = await useFake({ profile: "2.x", monitors: [gpSeed(7, "gp")] });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", "protocol=ICMP"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "gp").port).toBeNull();
  });

  test("add --type globalping exits 2 on a 1.x server before add", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "globalping" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  // globalping.js first ships in 2.1.0 — the patch-level gates the other
  // 2.x types use cannot express that, so the type map carries it
  test("add --type globalping exits 2 on a 2.0.x server naming 2.1.0", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.0.2" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "globalping" needs Uptime Kuma >= 2.1.0; the server reports 2.0.2',
    );
    expect(addCalls(k)).toHaveLength(0);
  });

  test("add --type globalping runs on a 2.1.0 server", async () => {
    const k = await useFake({ profile: "2.x", info: { version: "2.1.0" } });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "gp1").subtype).toBe("ping");
  });

  test("edit keeps the stored globalping fields on an unrelated change", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "dns",
        "--hostname",
        "example.com",
        "--dns-resolve-type",
        "MX",
        "--location",
        "aws+us-east",
      ],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "gp1", "--set", "interval=120"], creds(k.url));
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m.interval).toBe(120);
    expect(m).toMatchObject({
      subtype: "dns",
      protocol: "UDP",
      port: 53,
      hostname: "example.com",
      dns_resolve_type: "MX",
      location: "aws+us-east",
    });
  });

  // the subtype watcher's change branch re-picks protocol and port
  // unconditionally — a stored custom protocol or port does not survive
  // the subtype switch unless this edit sets it
  test("edit --set subtype=dns on a ping monitor re-picks UDP and 53", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--hostname",
        "example.com",
        "--set",
        "protocol=TCP",
        "--set",
        "port=8080",
      ],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "gp1", "--set", "subtype=dns"], creds(k.url));
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m.protocol).toBe("UDP");
    expect(m.port).toBe(53);
  });

  test("edit --set subtype=http keeps the stored port like the watcher", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "dns",
        "--hostname",
        "example.com",
        "--set",
        "port=5353",
      ],
      creds(k.url),
    );
    // the http subtype's url input appears required-empty like the
    // picker's, so the switch needs one supplied in the same edit
    const r = await run(
      sb,
      ["monitors", "edit", "gp1", "--set", "subtype=http", "--set", "url=https://example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m.subtype).toBe("http");
    expect(m.protocol).toBeNull();
    expect(m.port).toBe(5353);
  });

  // a value the same edit sets wins over the subtype watcher's pick
  test("edit --set subtype=dns --set protocol=TCP keeps the explicit protocol", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "gp1", "--set", "subtype=dns", "--set", "protocol=TCP"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m.protocol).toBe("TCP");
    expect(m.port).toBe(53);
  });

  // the picker shows an empty required location input on a type change —
  // the merged check refuses the same blank
  test("edit --set type=globalping without location exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "h1", "--set", "type=globalping", "--set", "hostname=example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("location must be a non-empty string");
  });

  test("edit --set type=globalping applies the ping defaults", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=globalping",
        "--set",
        "location=world",
        "--set",
        "hostname=example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h1");
    expect(m).toMatchObject({
      type: "globalping",
      subtype: "ping",
      protocol: "ICMP",
      port: 80,
      location: "world",
      hostname: "example.com",
    });
  });

  // the type watcher runs under the transient "ping" before the user
  // picks dns, whose own change-branch pick is unconditional — one edit
  // naming both lands on the dns picks
  test("edit --set type=globalping --set subtype=dns lands on the dns picks", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=globalping",
        "--set",
        "subtype=dns",
        "--set",
        "location=world",
        "--set",
        "hostname=example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h1");
    expect(m).toMatchObject({
      subtype: "dns",
      protocol: "UDP",
      port: 53,
    });
  });

  // a type or subtype switch re-judges a stored RR type the destination
  // cannot offer — the picker's select would show a value outside its
  // options, which the merged monitor refuses like every other field
  test("edit --set type=dns on a globalping dns monitor with a globalping-only RR type exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        gpSeed(7, "gp", {
          subtype: "dns",
          protocol: "UDP",
          port: 53,
          dns_resolve_server: "1.1.1.1",
          dns_resolve_type: "HTTPS",
        }),
      ],
    });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", "type=dns"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_type must be one of");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set type=globalping --set subtype=dns on a dns monitor with a dns-only RR type exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "d"),
          type: "dns",
          url: null,
          hostname: "dns.example.com",
          port: 53,
          location: "world",
          dns_resolve_server: "1.1.1.1",
          dns_resolve_type: "CAA",
        },
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "d", "--set", "type=globalping", "--set", "subtype=dns"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_type must be one of");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --set subtype=dns on a ping monitor with a dns-only RR type exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [gpSeed(7, "gp", { dns_resolve_type: "CAA" })],
    });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", "subtype=dns"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("dns_resolve_type must be one of");
    expect(editCalls(k)).toHaveLength(0);
  });

  // expectedValue switches the check to json-query, which reads jsonPath —
  // editing either side of the pair re-judges the merged combination
  test("edit --set jsonPath= on a globalping http monitor with expectedValue exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        gpSeed(7, "gp", {
          subtype: "http",
          url: "https://example.com",
          expectedValue: "ok",
          jsonPath: "$.status",
        }),
      ],
    });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", 'jsonPath=""'], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("jsonPath must be a non-empty string when expectedValue is set");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit clearing expectedValue and jsonPath together is allowed", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        gpSeed(7, "gp", {
          subtype: "http",
          url: "https://example.com",
          expectedValue: "ok",
          jsonPath: "$.status",
        }),
      ],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "gp", "--set", 'expectedValue=""', "--set", 'jsonPath=""'],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "gp");
    expect(m.expectedValue).toBe("");
    expect(m.jsonPath).toBe("");
  });

  // a numeric expectedValue is truthy to globalping.js's json-query
  // branch but is not the string the picker's field produces — refused
  // like json-query's needString rather than stored to fail every beat
  test("add --type globalping --subtype http --set expectedValue=200 exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "http",
        "--url",
        "https://example.com",
        "--set",
        "expectedValue=200",
        "--set",
        "jsonPath=$.status",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expectedValue must be a non-empty string");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set expectedValue=200 on a globalping http monitor exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        gpSeed(7, "gp", {
          subtype: "http",
          url: "https://example.com",
          expectedValue: "ok",
          jsonPath: "$.status",
        }),
      ],
    });
    const r = await run(sb, ["monitors", "edit", "gp", "--set", "expectedValue=200"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expectedValue must be a non-empty string");
    expect(editCalls(k)).toHaveLength(0);
  });

  // the UI can store port 0; the type-change branch treats it as empty
  // like every other type, so the globalping picks still apply
  test("edit --set type=globalping on a port-0 monitor picks the ping port", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), port: 0 }],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h",
        "--set",
        "type=globalping",
        "--set",
        "location=world",
        "--set",
        "hostname=example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({ type: "globalping", subtype: "ping", port: 80 });
  });

  test("edit --set type=globalping --set subtype=dns on a port-0 monitor picks 53", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), port: 0 }],
    });
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h",
        "--set",
        "type=globalping",
        "--set",
        "subtype=dns",
        "--set",
        "location=world",
        "--set",
        "hostname=example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h")).toMatchObject({ subtype: "dns", port: 53 });
  });

  // subtype persists through editMonitor on any type, so a dns monitor
  // that leaves globalping and comes back finds its stored "dns" — the
  // port branch must land on the subtype's own pick, not an empty port
  test("edit round-trip globalping dns to http and back keeps the dns picks", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "globalping",
        "--name",
        "gp1",
        "--subtype",
        "dns",
        "--hostname",
        "example.com",
      ],
      creds(k.url),
    );
    const away = await run(
      sb,
      ["monitors", "edit", "gp1", "--set", "type=http", "--set", "url=https://example.com"],
      creds(k.url),
    );
    expect(away.code).toBe(0);
    const r = await run(sb, ["monitors", "edit", "gp1", "--set", "type=globalping"], creds(k.url));
    expect(r.code).toBe(0);
    const m = stored(k, "gp1");
    expect(m).toMatchObject({
      type: "globalping",
      subtype: "dns",
      protocol: "UDP",
      port: 53,
      hostname: "example.com",
    });
  });

  // an explicit --set subtype plays the user's pick on a type change like
  // on add — a null is refused by the merged check, not rewritten to ping
  test("edit --set type=globalping --set subtype=null exits 2", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=globalping",
        "--set",
        "subtype=null",
        "--set",
        "location=world",
        "--set",
        "hostname=example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("subtype must be one of");
    expect(editCalls(k)).toHaveLength(0);
  });

  // globalping's pick stores port 80, which reads as another type's
  // default to the type-change watcher like the CLI's other stored picks
  test("edit --set type=ntp on a globalping monitor replaces the picked port 80", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "globalping", "--name", "gp1", "--hostname", "example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      ["monitors", "edit", "gp1", "--set", "type=ntp", "--set", "hostname=ntp.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "gp1")).toMatchObject({ type: "ntp", port: 123, interval: 300 });
  });

  test("edit --set type=globalping exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake();
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(sb, ["monitors", "edit", "h1", "--set", "type=globalping"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'type "globalping" needs Uptime Kuma >= 2.1.0; the server reports 1.23.17',
    );
    expect(editCalls(k)).toHaveLength(0);
  });

  // the http subtype's change pick nulls the protocol but leaves the port
  // the transient ping state stored — the picker's own leftovers
  test("edit --set type=globalping --set subtype=http keeps the transient port", async () => {
    const k = await useFake({ profile: "2.x" });
    await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h1", "--url", "https://h.example.com"],
      creds(k.url),
    );
    const r = await run(
      sb,
      [
        "monitors",
        "edit",
        "h1",
        "--set",
        "type=globalping",
        "--set",
        "subtype=http",
        "--set",
        "location=world",
        "--set",
        "url=https://probe.example.com",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const m = stored(k, "h1");
    expect(m).toMatchObject({
      subtype: "http",
      protocol: null,
      port: 80,
      location: "world",
      url: "https://probe.example.com",
    });
  });

  // ipFamily's select shows on the http family too, so the flag accepts
  // those types — a 2.x-only field, so a 1.x server refuses it after
  // connect like any other 2.x field
  test("add --type http --ip-family ipv4 stores it on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h1",
        "--url",
        "https://h.example.com",
        "--ip-family",
        "ipv4",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h1").ipFamily).toBe("ipv4");
  });

  test("add --type http --ip-family ipv4 exits 2 on a 1.x server", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h1",
        "--url",
        "https://h.example.com",
        "--ip-family",
        "ipv4",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"ipFamily" needs Uptime Kuma 2.x');
  });

  test("add --type dns --ip-family ipv4 exits 2 before connecting", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "dns",
        "--name",
        "d1",
        "--hostname",
        "example.com",
        "--ip-family",
        "ipv4",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--ip-family only applies to --type");
  });
});

describe("monitor timing on Kuma 2.x", () => {
  test("edit of a 2.x ping to a short interval keeps its timeout (no 80% cap)", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        {
          ...http(7, "pg"),
          type: "ping",
          hostname: "127.0.0.1",
          url: null,
          timeout: 10,
          ping_per_request_timeout: 2,
        },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=1"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "pg")).toMatchObject({ interval: 1, timeout: 10 });
  });

  test.each([
    [["--timeout", "1"], "(2)"],
    [["--timeout", "0.4"], "(2)"],
    [["--interval", "600", "--timeout", "400"], "(2)"],
    [["--timeout", "3", "--set", "ping_per_request_timeout=5"], "(5)"],
  ])("a 2.x ping add with %p exits 2 before add", async (extra, per) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "pp", "--hostname", "127.0.0.1", ...extra],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`at least ping_per_request_timeout ${per} on Uptime Kuma 2.x`);
    expect(addCalls(k)).toHaveLength(0);
  });

  test("a 2.x ping add with timeout 2 and the default per-request timeout is accepted", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "127.0.0.1",
        "--timeout",
        "2",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p2").timeout).toBe(2);
  });

  test("a 2.x edit turning an http monitor with timeout 400 into ping exits 2", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h", { timeout: 400, interval: 600 })],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ping", "--set", "hostname=127.0.0.1"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("a ping monitor's timeout must be between 1 and 300 seconds");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("a 2.x ping with a numeric-string ping_per_request_timeout compares it as a number", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "ps",
        "--hostname",
        "127.0.0.1",
        "--timeout",
        "1",
        "--set",
        'ping_per_request_timeout="1"',
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
  });

  test.each([
    [["--timeout", "0"], 0],
    [["--timeout", "300"], 300],
    // Kuma itself rounds this to 300 on save; the fake stores what was sent
    [["--timeout", "300.4"], undefined],
  ])("a 2.x ping add with %p is accepted like Kuma", async (extra, stored0) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "pk",
        "--hostname",
        "127.0.0.1",
        "--interval",
        "600",
        ...extra,
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    if (stored0 !== undefined) expect(stored(k, "pk").timeout).toBe(stored0);
  });

  test.each([
    [["--timeout", "1.4"]],
    [["--timeout", "0.4", "--set", "ping_per_request_timeout=0"]],
  ])("a 2.x ping add with %p exits 2 (rounds below 1 / the per-request floor)", async (extra) => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "pk", "--hostname", "127.0.0.1", ...extra],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(addCalls(k)).toHaveLength(0);
  });

  test("a 2.x ping timeout of 1.6 rounds to 2 like Kuma and is accepted", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "p16",
        "--hostname",
        "127.0.0.1",
        "--timeout",
        "1.6",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
  });

  test("retryInterval 1 is accepted on 2.x", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "r1", "--retry-interval", "1"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "r1").retryInterval).toBe(1);
  });

  test("a 2.x ping add with a short interval keeps the ping default timeout", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "p5",
        "--hostname",
        "127.0.0.1",
        "--interval",
        "5",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p5")).toMatchObject({ interval: 5, timeout: 10 });
  });

  test("a 2.x http add with a short interval is still capped at 80%", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "h5",
        "--url",
        "https://h.example.com",
        "--interval",
        "5",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h5").timeout).toBe(4);
  });

  test("edit fills a missing stored timeout with the 2.x default for the type", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [
        { ...http(7, "pg"), type: "ping", hostname: "127.0.0.1", url: null, timeout: null },
      ],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "interval=60"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "pg").timeout).toBe(10);
  });

  test("edit turning an http monitor with timeout 0 into ping keeps the stored 0", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "h"), timeout: 0 }],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=ping", "--set", "hostname=127.0.0.1"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("ping");
    expect(sent.timeout).toBe(0);
  });

  test("edit --set type with an explicit --set timeout=0 keeps 0", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [http(7, "h")],
    });
    const r = await run(
      sb,
      ["monitors", "edit", "7", "--set", "type=group", "--set", "timeout=0"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    const sent = editCalls(k)[0]!.args[0] as Record<string, any>;
    expect(sent.type).toBe("group");
    expect(sent.timeout).toBe(0);
  });

  test("--interval 5 is accepted and stored", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "5",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "x").interval).toBe(5);
  });

  test("--set interval=3000000 is accepted and stored", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "interval=3000000",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "x").interval).toBe(3000000);
  });

  test("--timeout 0 is accepted and stored as 0", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "--timeout",
        "0",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "x").timeout).toBe(0);
  });

  test("--retry-interval 0 exits 2 before connecting on 2.x too", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "--retry-interval",
        "0",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--retry-interval");
    expect(k.calls).toHaveLength(0);
  });

  test("--retry-interval 0.5 exits 2 after connect naming the integer rule", async () => {
    const k = await useFake({ profile: "2.x" });
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
        "--retry-interval",
        "0.5",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--retry-interval must be an integer");
    expect(addCalls(k)).toHaveLength(0);
  });

  test("ping add without --timeout stores the 2.x UI default 10", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "p", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p").timeout).toBe(10);
  });

  test("kafka-producer add without --timeout stores the 2.x UI default 1", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "kafka-producer",
        "--name",
        "k",
        "--kafka-producer-broker",
        "kafka.example.com:9092",
        "--kafka-producer-topic",
        "t",
        "--kafka-producer-message",
        "m",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "k").timeout).toBe(1);
  });

  test("http add without --timeout stores the 2.x UI default 48", async () => {
    const k = await useFake({ profile: "2.x" });
    const r = await run(
      sb,
      ["monitors", "add", "--type", "http", "--name", "h", "--url", "https://h.example.com"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "h").timeout).toBe(48);
  });

  test.each([
    [["--interval", "0"]],
    [["--interval", "0.5"]],
    [["--interval", "abc"]],
    [["--timeout", "-1"]],
  ])("add %p exits 2 before connecting", async (extra) => {
    const k = await useFake({ profile: "2.x" });
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
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(k.calls).toHaveLength(0);
  });
});

describe("monitor timing on Kuma 1.x", () => {
  test("a 1.x ping with timeout 1 is accepted (the 2.x ping rule does not apply)", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "p1",
        "--hostname",
        "127.0.0.1",
        "--timeout",
        "1",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p1").timeout).toBe(1);
  });

  test("interval 2073600 is accepted on 1.x", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "big", "--interval", "2073600"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "big").interval).toBe(2073600);
  });

  test.each([
    [["--interval", "5"], '--interval must be between 20 and 2073600 seconds, got "5"'],
    [["--set", "interval=5"], "interval must be between"],
    [["--timeout", "0"], '--timeout must be a positive number of seconds, got "0"'],
  ])("the 1.x refusal names the source %p", async (extra, msg) => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "push", "--name", "n", ...extra],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    if (extra[0] === "--set") expect(r.stderr).not.toContain("--interval");
  });

  test("a 1.x ping keeps the 80% cap like the 1.23 UI", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "p20",
        "--hostname",
        "127.0.0.1",
        "--interval",
        "20",
      ],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p20").timeout).toBe(16);
  });

  test("the checked interval is the one that is sent: --set beats --config-file", async () => {
    const k = await useFake();
    const f = join(sb.dir, "t.json");
    writeFileSync(f, JSON.stringify({ interval: 30 }));
    const r = await run(
      sb,
      [
        "monitors",
        "add",
        "--type",
        "push",
        "--name",
        "p",
        "--config-file",
        f,
        "--set",
        "interval=5",
      ],
      creds(k.url),
    );
    // the refused value is the --set one that would be sent, not the file's
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('interval must be between 20 and 2073600 seconds, got "5"');
    expect(addCalls(k)).toHaveLength(0);
  });

  test.each([
    [["--interval", "5"], "interval must be between 20 and 2073600"],
    [["--set", "interval=3000000"], "interval must be between 20 and 2073600"],
    [["--timeout", "0"], "Kuma 1.23 turns 0 into interval × 800 seconds"],
  ])("add %p exits 2 after connect with no add call", async (extra, msg) => {
    const k = await useFake();
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
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls.map((c) => c.event)).toContain("login");
    expect(addCalls(k)).toHaveLength(0);
  });

  test.each([
    [["--set", "interval=5"], "interval must be between 20 and 2073600"],
    [["--set", "interval=3000000"], "interval must be between 20 and 2073600"],
    [["--set", "timeout=0"], "Kuma 1.23 turns 0 into interval × 800 seconds"],
  ])("edit %p exits 2 after connect with no editMonitor call", async (extra, msg) => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const r = await run(sb, ["monitors", "edit", "7", ...extra], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(k.calls.map((c) => c.event)).toContain("login");
    expect(editCalls(k)).toHaveLength(0);
  });

  test("ping add without --timeout stores 48", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["monitors", "add", "--type", "ping", "--name", "p", "--hostname", "h"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(stored(k, "p").timeout).toBe(48);
  });
});
