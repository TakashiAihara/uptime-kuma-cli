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
    expect(r.stderr).toContain('"sshPassword" needs Uptime Kuma 2.x');
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
    expect(r.stderr).toContain('"saveResponse" needs Uptime Kuma 2.x; the server reports 1.23.17');
    expect(addCalls(k)).toHaveLength(0);
  });

  test("edit --set with a non-secret 2.x key exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "saveResponse=true"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"saveResponse" needs Uptime Kuma 2.x');
    expect(editCalls(k)).toHaveLength(0);
  });

  test("edit --config-file with a 2.x key exits 2 on a 1.x server before editMonitor", async () => {
    const k = await useFake({ monitors: [http(7, "Taba")] });
    const f = join(sb.dir, "e.json");
    writeFileSync(f, JSON.stringify({ responseMaxLength: 100 }));
    const r = await run(sb, ["monitors", "edit", "7", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"responseMaxLength" needs Uptime Kuma 2.x');
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

  test.each([["manual_status=4"], ["manual_status=1.5"], ['manual_status="up"']])(
    "add --set %s exits 2 before connecting",
    async (set) => {
      const k = await useFake({ profile: "2.x" });
      const r = await run(
        sb,
        ["monitors", "add", "--type", "manual", "--name", "m1", "--set", set],
        creds(k.url),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("manual_status must be null or a heartbeat status integer 0..3");
      expect(k.calls).toHaveLength(0);
    },
  );

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

  test("edit --set manual_status stores it on 2.x", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "manual_status=0"], creds(k.url));
    expect(r.code).toBe(0);
    expect(stored(k, "m").manual_status).toBe(0);
  });

  test("edit --set manual_status=5 exits 2 before editMonitor", async () => {
    const k = await useFake({
      profile: "2.x",
      monitors: [{ ...http(7, "m"), type: "manual", url: null }],
    });
    const r = await run(sb, ["monitors", "edit", "7", "--set", "manual_status=5"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("manual_status must be null or a heartbeat status integer 0..3");
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
