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

  test("--json-path-operator is ignored on a non-json-query type", async () => {
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
    expect(r.code).toBe(0);
    expect(stored(k, "http-x").jsonPathOperator).toBeUndefined();
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
    expect(r.stderr).toContain('"sshPassword" needs Uptime Kuma 2.x');
    expect(r.stderr).toContain("1.23.17");
    expect(addCalls(k)).toHaveLength(0);
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
});
