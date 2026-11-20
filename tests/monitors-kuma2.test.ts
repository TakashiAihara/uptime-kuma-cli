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
