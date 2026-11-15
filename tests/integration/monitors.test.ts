import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("monitors (real Kuma)", () => {
  let sb: Sandbox;
  let pushId = 0;
  let pushToken = "";
  let httpId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add --type push --paused prints pushToken and pushUrl", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-push",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-push", type: "push", active: false });
    expect(out.id).toBeGreaterThan(0);
    expect(out.pushToken).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(out.pushUrl).toContain(`/api/push/${out.pushToken}?status=up&msg=OK&ping=`);
    pushId = out.id;
    pushToken = out.pushToken;
  }, 120_000);

  test("add --type http --paused creates a paused http monitor", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "http",
      "--name",
      "it-http",
      "--url",
      "http://localhost:3001",
      "--paused",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ name: "it-http", type: "http", active: false });
    httpId = out.id;
  }, 120_000);

  test("add with the same name exits 3 without creating a second monitor", async () => {
    const r = await cliRun(sb, ["monitors", "add", "--type", "push", "--name", "it-push"]);
    expect(r.code).toBe(3);
    expect(r.json()).toEqual({ id: pushId, name: "it-push", skipped: true });
  }, 120_000);

  test("list --name it- shows the monitors created above", async () => {
    const r = await cliRun(sb, ["monitors", "list", "--name", "it-"]);
    expect(r.code).toBe(0);
    const names = r.json().map((m: any) => m.name);
    expect(names).toEqual(expect.arrayContaining(["it-push", "it-http"]));
  }, 120_000);

  test("get returns the push monitor with its stored pushToken", async () => {
    const r = await cliRun(sb, ["monitors", "get", String(pushId)]);
    expect(r.code).toBe(0);
    const m = r.json();
    expect(m.id).toBe(pushId);
    expect(m.name).toBe("it-push");
    expect(m.type).toBe("push");
    expect(m.pushToken).toBe(pushToken);
  }, 120_000);

  test("edit --set maxretries=2 is saved", async () => {
    const r = await cliRun(sb, ["monitors", "edit", String(pushId), "--set", "maxretries=2"]);
    expect(r.code).toBe(0);
    expect(r.json().maxretries).toBe(2);
  }, 120_000);

  test("get shows the edited maxretries", async () => {
    const r = await cliRun(sb, ["monitors", "get", String(pushId)]);
    expect(r.code).toBe(0);
    expect(r.json().maxretries).toBe(2);
  }, 120_000);

  test("resume then pause the push monitor", async () => {
    const resumed = await cliRun(sb, ["monitors", "resume", String(pushId)]);
    expect(resumed.code).toBe(0);
    expect(resumed.json()).toEqual({ id: pushId, active: true });
    const paused = await cliRun(sb, ["monitors", "pause", String(pushId)]);
    expect(paused.code).toBe(0);
    expect(paused.json()).toEqual({ id: pushId, active: false });
  }, 180_000);

  test("delete --yes removes the http monitor and get then exits 1", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(httpId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: httpId, deleted: true });
    const g = await cliRun(sb, ["monitors", "get", String(httpId)]);
    expect(g.code).toBe(1);
  }, 180_000);

  test("delete --yes removes the push monitor", async () => {
    const r = await cliRun(sb, ["monitors", "delete", String(pushId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: pushId, deleted: true });
  }, 120_000);

  describe("group / ping / dns", () => {
    let groupId = 0;
    let pingId = 0;
    let dnsId = 0;

    test("add a paused group monitor", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "group",
        "--name",
        "it-group",
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-group", type: "group", active: false });
      groupId = r.json().id;
    }, 120_000);

    test("add a paused ping monitor to 127.0.0.1 with --parent", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "it-ping",
        "--hostname",
        "127.0.0.1",
        "--parent",
        String(groupId),
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-ping", type: "ping", active: false });
      pingId = r.json().id;
    }, 120_000);

    test("get shows the parent on the ping monitor", async () => {
      const r = await cliRun(sb, ["monitors", "get", String(pingId)]);
      expect(r.code).toBe(0);
      expect(r.json().parent).toBe(groupId);
    }, 120_000);

    test("add a paused dns monitor with --set dns_resolve_type", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "dns",
        "--name",
        "it-dns",
        "--hostname",
        "localhost",
        "--set",
        'dns_resolve_type="AAAA"',
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-dns", type: "dns", active: false });
      dnsId = r.json().id;
    }, 120_000);

    test("get shows the dns_resolve_type set through --set", async () => {
      const r = await cliRun(sb, ["monitors", "get", String(dnsId)]);
      expect(r.code).toBe(0);
      expect(r.json().dns_resolve_type).toBe("AAAA");
    }, 120_000);

    test("delete the group, ping and dns monitors", async () => {
      for (const id of [groupId, pingId, dnsId]) {
        const r = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
        expect(r.code).toBe(0);
        expect(r.json()).toEqual({ id, deleted: true });
      }
    }, 300_000);
  });

  describe("mqtt / radius", () => {
    let mqttId = 0;
    let radiusId = 0;

    test("add a paused mqtt monitor with mqttPassword via --config-file", async () => {
      const f = join(sb.dir, "mqtt.json");
      writeFileSync(f, JSON.stringify({ mqttPassword: "it-mqtt-secret" }));
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "mqtt",
        "--name",
        "it-mqtt",
        "--hostname",
        "localhost",
        "--port",
        "1883",
        "--mqtt-topic",
        "it/topic",
        "--config-file",
        f,
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-mqtt", type: "mqtt", active: false });
      mqttId = r.json().id;
    }, 120_000);

    test("add a paused radius monitor with radiusPassword/radiusSecret via --config-file", async () => {
      const f = join(sb.dir, "radius.json");
      writeFileSync(
        f,
        JSON.stringify({ radiusPassword: "it-radius-pw", radiusSecret: "it-radius-secret" }),
      );
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "radius",
        "--name",
        "it-radius",
        "--hostname",
        "localhost",
        "--radius-username",
        "it-user",
        "--radius-called-station-id",
        "it-called",
        "--radius-calling-station-id",
        "it-calling",
        "--config-file",
        f,
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-radius", type: "radius", active: false });
      radiusId = r.json().id;
    }, 120_000);

    test("get shows the mqtt monitor with its secret redacted", async () => {
      const r = await cliRun(sb, ["monitors", "get", String(mqttId)]);
      expect(r.code).toBe(0);
      const m = r.json();
      expect(m.type).toBe("mqtt");
      expect(m.mqttTopic).toBe("it/topic");
      expect(m.mqttPassword).toBe("***");
    }, 120_000);

    test("get shows the radius monitor with its secrets redacted", async () => {
      const r = await cliRun(sb, ["monitors", "get", String(radiusId)]);
      expect(r.code).toBe(0);
      const m = r.json();
      expect(m.type).toBe("radius");
      expect(m.port).toBe(1812);
      expect(m.radiusUsername).toBe("it-user");
      expect(m.radiusPassword).toBe("***");
      expect(m.radiusSecret).toBe("***");
    }, 120_000);

    test("delete the mqtt and radius monitors", async () => {
      for (const id of [mqttId, radiusId]) {
        const r = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
        expect(r.code).toBe(0);
        expect(r.json()).toEqual({ id, deleted: true });
      }
    }, 180_000);
  });

  describe("postgres", () => {
    let pgId = 0;

    test("add a paused postgres monitor with databaseConnectionString via --config-file", async () => {
      const f = join(sb.dir, "postgres.json");
      writeFileSync(
        f,
        JSON.stringify({ databaseConnectionString: "postgres://u:p@127.0.0.1:5432/x" }),
      );
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "postgres",
        "--name",
        "it-postgres",
        "--config-file",
        f,
        "--paused",
      ]);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ name: "it-postgres", type: "postgres", active: false });
      pgId = r.json().id;
    }, 120_000);

    test("get shows type postgres and the connection string redacted", async () => {
      const r = await cliRun(sb, ["monitors", "get", String(pgId)]);
      expect(r.code).toBe(0);
      const m = r.json();
      expect(m.type).toBe("postgres");
      expect(m.databaseConnectionString).toBe("***");
      expect(r.stdout).not.toContain("postgres://u:p@127.0.0.1:5432/x");
    }, 120_000);

    test("delete the postgres monitor", async () => {
      const r = await cliRun(sb, ["monitors", "delete", String(pgId), "--yes"]);
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: pgId, deleted: true });
    }, 120_000);
  });

  describe("stats", () => {
    let statsId = 0;

    test("add a paused http monitor for the stats check", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "http",
        "--name",
        "it-stats",
        "--url",
        "http://localhost:3001",
        "--paused",
      ]);
      expect(r.code).toBe(0);
      statsId = r.json().id;
    }, 120_000);

    test("stats returns the documented field types", async () => {
      const r = await cliRun(sb, ["monitors", "stats", String(statsId)]);
      expect(r.code).toBe(0);
      const s = r.json();
      expect(s.id).toBe(statsId);
      expect(s.name).toBe("it-stats");
      expect(typeof s.uptime24h).toBe("number");
      expect(typeof s.uptime30d).toBe("number");
      expect(s.uptime24h).toBeGreaterThanOrEqual(0);
      expect(s.uptime24h).toBeLessThanOrEqual(1);
      expect(s.uptime30d).toBeGreaterThanOrEqual(0);
      expect(s.uptime30d).toBeLessThanOrEqual(1);
      expect(s.avgPing === null || typeof s.avgPing === "number").toBe(true);
      expect(s.certExpiresAt === null || typeof s.certExpiresAt === "string").toBe(true);
      expect(s.certDaysRemaining === null || typeof s.certDaysRemaining === "number").toBe(true);
    }, 120_000);

    test("delete the stats monitor", async () => {
      const r = await cliRun(sb, ["monitors", "delete", String(statsId), "--yes"]);
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: statsId, deleted: true });
    }, 120_000);
  });
});
