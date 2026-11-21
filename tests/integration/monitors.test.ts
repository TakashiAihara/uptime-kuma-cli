import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { sandbox, type Sandbox } from "../helpers/run";
import {
  cliRun,
  on21,
  on2x,
  onNtp,
  onOracleDb,
  onPm2,
  onSftp,
  onSnmpV3,
  onWsUpgrade,
  withKuma,
} from "./helpers";

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

  test("interval 5: 2.x stores it, 1.23 refuses it after connect", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "push",
      "--name",
      "it-fast",
      "--interval",
      "5",
      "--paused",
    ]);
    if (!on2x) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--interval must be between 20 and 2073600");
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({ interval: 5, retryInterval: 5, timeout: 4 });
    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 180_000);

  test.skipIf(!on2x)(
    "2.x: a ping with interval 1 keeps a valid timeout and can be edited",
    async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "ping",
        "--name",
        "it-ping1",
        "--hostname",
        "127.0.0.1",
        "--interval",
        "1",
        "--paused",
      ]);
      expect(r.code).toBe(0);
      const id = r.json().id;
      const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
      expect(e.code).toBe(0);
      expect(e.json()).toMatchObject({ interval: 1, timeout: 10, description: "it" });
      const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
      expect(del.code).toBe(0);
    },
    180_000,
  );

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

  test("json-query with the default operator goes up; 1.23 refuses --json-path-operator", async () => {
    // Kuma's own /api/entry-page answers {"type":"entryPage",...}; a 2.x
    // json-query without an operator would go DOWN on every beat
    const args = [
      "monitors",
      "add",
      "--type",
      "json-query",
      "--name",
      "it-jq",
      "--url",
      "http://localhost:3001/api/entry-page",
      "--json-path",
      "type",
      "--expected-value",
      "entryPage",
      "--interval",
      "20",
    ];
    if (!on2x) {
      const refused = await cliRun(sb, [...args, "--json-path-operator", "!="]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('"jsonPathOperator" needs Uptime Kuma 2.x');
    }
    const r = await cliRun(sb, args);
    expect(r.code).toBe(0);
    const id = r.json().id;

    let up = false;
    for (let i = 0; i < 12 && !up; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      up = b.json().some((beat: any) => beat.status === 1);
    }
    expect(up).toBe(true);

    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.code).toBe(0);
    if (on2x) {
      expect(g.json()).toMatchObject({ jsonPathOperator: "==", conditions: [], rabbitmqNodes: [] });
      const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
      expect(e.code).toBe(0);
      expect(e.json()).toMatchObject({ description: "it", jsonPathOperator: "==", conditions: [] });
      const op = await cliRun(sb, ["monitors", "edit", String(id), "--json-path-operator", "!="]);
      expect(op.code).toBe(0);
      expect(op.json().jsonPathOperator).toBe("!=");
    } else {
      expect(g.json()).not.toHaveProperty("jsonPathOperator");
    }
    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

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
      // uptime "1y" is pushed unconditionally since 2.0.0; domainInfo only
      // for a domain with a resolved RDAP expiry, which localhost lacks —
      // the keys are absent on both legs here
      if (on2x) {
        expect(typeof s.uptime1y).toBe("number");
        expect(s.uptime1y).toBeGreaterThanOrEqual(0);
        expect(s.uptime1y).toBeLessThanOrEqual(1);
      } else {
        expect("uptime1y" in s).toBe(false);
      }
      expect("domainExpiresAt" in s).toBe(false);
      expect("domainDaysRemaining" in s).toBe(false);
    }, 120_000);

    test("delete the stats monitor", async () => {
      const r = await cliRun(sb, ["monitors", "delete", String(statsId), "--yes"]);
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: statsId, deleted: true });
    }, 120_000);
  });

  describe("delete --children", () => {
    let groupId = 0;

    test("add a paused group with a paused child", async () => {
      const g = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "group",
        "--name",
        "it-grp",
        "--paused",
      ]);
      expect(g.code).toBe(0);
      groupId = g.json().id;
      const c = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "push",
        "--name",
        "it-grp-child",
        "--parent",
        String(groupId),
        "--paused",
      ]);
      expect(c.code).toBe(0);
    }, 240_000);

    test("--children: 2.1+ deletes the subtree, older servers refuse", async () => {
      const r = await cliRun(sb, ["monitors", "delete", String(groupId), "--yes", "--children"]);
      if (!on21) {
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("--children needs Uptime Kuma >= 2.1.0");
        // clean up the unlink way: the group goes, the child stays top-level
        const d = await cliRun(sb, ["monitors", "delete", String(groupId), "--yes"]);
        expect(d.code).toBe(0);
        const cd = await cliRun(sb, ["monitors", "delete", "it-grp-child", "--yes"]);
        expect(cd.code).toBe(0);
        return;
      }
      expect(r.code).toBe(0);
      expect(r.json()).toEqual({ id: groupId, deleted: true });
      const list = await cliRun(sb, ["monitors", "list"]);
      expect(list.code).toBe(0);
      const names = (list.json() as { name: string }[]).map((m) => m.name);
      expect(names).not.toContain("it-grp");
      expect(names).not.toContain("it-grp-child");
    }, 240_000);
  });

  describe("gamedig / tailscale-ping", () => {
    test("add a paused gamedig monitor with a game in the server's list", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "gamedig",
        "--name",
        "it-game",
        "--hostname",
        "127.0.0.1",
        "--port",
        "25565",
        "--game",
        "minecraft",
        "--paused",
      ]);
      expect(r.code).toBe(0);
      const id = r.json().id;
      const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
      expect(del.code).toBe(0);
    }, 120_000);

    test("a game outside the server's list exits 1 without creating a monitor", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "gamedig",
        "--name",
        "it-game-bad",
        "--hostname",
        "127.0.0.1",
        "--port",
        "25565",
        "--game",
        "not-a-real-game-xyz",
        "--paused",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not in the server's game list");
      const list = await cliRun(sb, ["monitors", "list", "--name", "it-game-bad"]);
      expect(list.json()).toEqual([]);
    }, 120_000);

    test("tailscale-ping exits 2 on a container server like the picker's hidden type", async () => {
      const r = await cliRun(sb, [
        "monitors",
        "add",
        "--type",
        "tailscale-ping",
        "--name",
        "it-ts",
        "--hostname",
        "127.0.0.1",
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no tailscale binary");
    }, 120_000);
  });

  test("manual: 2.x beats the set status and an edit keeps it, 1.x refuses the type", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "manual",
      "--name",
      "it-manual",
      "--set",
      "manual_status=1",
      "--interval",
      "20",
    ]);
    if (!on2x) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "manual" needs Uptime Kuma 2.x');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // a manual monitor's check copies manual_status into the beat
    const waitBeat = async (afterMs: number) => {
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 5_000));
        const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
        expect(b.code).toBe(0);
        const beat = b
          .json()
          .find(
            (x: any) =>
              typeof x.time === "string" && Date.parse(`${x.time.replace(" ", "T")}Z`) >= afterMs,
          );
        if (beat) return beat;
      }
      throw new Error("no fresh beat");
    };
    const first = await waitBeat(Date.now() - 60_000);
    expect(first).toMatchObject({ status: 1, msg: "Up" });

    // toJSON does not emit manual_status, so the edit payload's undefined key
    // is dropped from the UPDATE — the stored status survives the restart
    const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
    expect(e.code).toBe(0);
    expect(e.json()).not.toHaveProperty("manual_status");
    const after = await waitBeat(Date.now());
    expect(after).toMatchObject({ status: 1, msg: "Up" });

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  test("ntp: 2.5+ stores the thresholds and a down beat arrives; older servers refuse", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "ntp",
      "--name",
      "it-ntp",
      "--hostname",
      "127.0.0.1",
      "--set",
      "ntpStratumThreshold=10",
      "--set",
      "ntpTimeOffsetThreshold=2000",
      "--set",
      "ntpRootDispersionThreshold=100",
      "--interval",
      "20",
      "--timeout",
      "5",
    ]);
    if (!onNtp) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "ntp" needs Uptime Kuma >= 2.5.0');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // the camelCase wire keys land in the snake_case columns and toJSON
    // emits them back under the same names
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "ntp",
      hostname: "127.0.0.1",
      port: 123,
      ntpStratumThreshold: 10,
      ntpTimeOffsetThreshold: 2000,
      ntpRootDispersionThreshold: 100,
    });

    // nothing answers UDP 123 on the container's loopback — the check fails
    // (timeout at the 5 s bound) and the down beat proves the monitor runs
    let down = false;
    for (let i = 0; i < 12 && !down; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      down = b.json().some((beat: any) => beat.status === 0);
    }
    expect(down).toBe(true);

    // the thresholds ride the getMonitor -> editMonitor round trip, so an
    // unrelated edit leaves them alone
    const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
    expect(e.code).toBe(0);
    expect(e.json()).toMatchObject({
      description: "it",
      ntpStratumThreshold: 10,
      ntpTimeOffsetThreshold: 2000,
      ntpRootDispersionThreshold: 100,
    });

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  // the ntp_*_threshold columns ship with ntp.js in 2.5.0: below that
  // editMonitor would drop the key while answering ok, so the field gate
  // refuses it the same way it does on 1.x
  test("ntp thresholds: edit --set refuses the keys below 2.5", async () => {
    const a = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "http",
      "--name",
      "it-ntpf",
      "--url",
      "http://localhost:3001",
      "--paused",
    ]);
    expect(a.code).toBe(0);
    const id = a.json().id;

    const r = await cliRun(sb, ["monitors", "edit", String(id), "--set", "ntpStratumThreshold=10"]);
    if (onNtp) {
      expect(r.code).toBe(0);
      const g = await cliRun(sb, ["monitors", "get", String(id)]);
      expect(g.json().ntpStratumThreshold).toBe(10);
    } else {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"ntpStratumThreshold" needs Uptime Kuma >= 2.5.0');
    }

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);

  test("smtp: 2.x stores smtpSecurity and a down beat arrives; 1.x refuses the type", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "smtp",
      "--name",
      "it-smtp",
      "--hostname",
      "127.0.0.1",
      "--set",
      "smtpSecurity=nostarttls",
      "--interval",
      "20",
      "--timeout",
      "5",
    ]);
    if (!on2x) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "smtp" needs Uptime Kuma 2.x');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // no --port: the check's `port || 25` is the stored default
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "smtp",
      hostname: "127.0.0.1",
      port: 25,
      smtpSecurity: "nostarttls",
    });

    // nothing listens on the container's loopback port 25 — the connection
    // is refused and the down beat proves the monitor runs
    let down = false;
    for (let i = 0; i < 12 && !down; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      down = b.json().some((beat: any) => beat.status === 0);
    }
    expect(down).toBe(true);

    // toJSON emits smtpSecurity, so an unrelated edit leaves it alone
    const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
    expect(e.code).toBe(0);
    expect(e.json()).toMatchObject({ description: "it", smtpSecurity: "nostarttls" });

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  test("snmp: 2.x stores the picker defaults and a down beat arrives; 1.x refuses the type", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "snmp",
      "--name",
      "it-snmp",
      "--hostname",
      "127.0.0.1",
      "--snmp-oid",
      "1.3.6.1.2.1.1.1.0",
      "--json-path",
      "$",
      "--expected-value",
      "up",
      "--interval",
      "20",
    ]);
    if (!on2x) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "snmp" needs Uptime Kuma 2.x');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // no --port / --snmp-version: the watcher's picks are the stored defaults
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "snmp",
      hostname: "127.0.0.1",
      port: 161,
      timeout: 5,
      snmpOid: "1.3.6.1.2.1.1.1.0",
      snmpVersion: "2c",
      jsonPath: "$",
      expectedValue: "up",
      jsonPathOperator: "==",
    });

    // nothing answers SNMP on the container's loopback — the session.get
    // times out and the down beat proves the monitor runs
    let down = false;
    for (let i = 0; i < 12 && !down; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      down = b.json().some((beat: any) => beat.status === 0);
    }
    expect(down).toBe(true);

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  // the snmp_v3_username column ships with snmp.js's v3 branch in 2.1.0: the
  // field gate refuses the add below it, and editMonitor never reads the key
  // on any release, so it can only be set on add
  test("snmp v3: the username is add-only and gated at 2.1.0", async () => {
    const v3args = [
      "monitors",
      "add",
      "--type",
      "snmp",
      "--name",
      "it-snmpv3",
      "--hostname",
      "127.0.0.1",
      "--snmp-oid",
      "1.3.6.1.2.1.1.1.0",
      "--json-path",
      "$",
      "--expected-value",
      "up",
      "--snmp-version",
      "3",
      "--snmp-v3-username",
      "ituser",
      "--paused",
    ];
    const r = await cliRun(sb, v3args);
    if (!on2x) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "snmp" needs Uptime Kuma 2.x');
      return;
    }
    if (!onSnmpV3) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"snmpV3Username" needs Uptime Kuma >= 2.1.0');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // the add persisted the row; toJSON emits snmpVersion but not the
    // username (2.5.11 monitor.js toJSON lists snmpOid/snmpVersion only —
    // like manual_status, the column is stored but never read back)
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({ type: "snmp", snmpVersion: "3" });
    expect(g.json()).not.toHaveProperty("snmpV3Username");

    // no release's editMonitor reads the column — a set of it exits 2
    // instead of silently doing nothing, like `active`
    const u = await cliRun(sb, ["monitors", "edit", String(id), "--set", "snmpV3Username=other"]);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain('cannot set "snmpV3Username"');

    // an unrelated edit leaves the v3 monitor editable and stored
    const e = await cliRun(sb, ["monitors", "edit", String(id), "--set", "description=it"]);
    expect(e.code).toBe(0);
    const g2 = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g2.json()).toMatchObject({ description: "it", snmpVersion: "3" });

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);

  test("snmp v3: a v2c monitor cannot become v3 on edit", async () => {
    if (!onSnmpV3) return;
    const a = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "snmp",
      "--name",
      "it-snmpv2",
      "--hostname",
      "127.0.0.1",
      "--snmp-oid",
      "1.3.6.1.2.1.1.1.0",
      "--json-path",
      "$",
      "--expected-value",
      "up",
      "--paused",
    ]);
    expect(a.code).toBe(0);
    const id = a.json().id;

    // the monitor would be dead without a username no edit could supply
    const r = await cliRun(sb, ["monitors", "edit", String(id), "--set", "snmpVersion=3"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot set snmpVersion "3" on a monitor that is not already v3');

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);

  // the username column survives a type change away (no editMonitor writes
  // it), and toJSON keeps emitting snmpVersion "3" — so a v3 monitor that
  // left snmp can come back: it is still a v3 row with its username
  test("snmp v3: a v3 monitor can leave snmp and come back", async () => {
    if (!onSnmpV3) return;
    const a = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "snmp",
      "--name",
      "it-snmpv3rt",
      "--hostname",
      "127.0.0.1",
      "--snmp-oid",
      "1.3.6.1.2.1.1.1.0",
      "--json-path",
      "$",
      "--expected-value",
      "up",
      "--snmp-version",
      "3",
      "--snmp-v3-username",
      "ituser",
      "--paused",
    ]);
    expect(a.code).toBe(0);
    const id = a.json().id;

    const away = await cliRun(sb, [
      "monitors",
      "edit",
      String(id),
      "--set",
      "type=http",
      "--set",
      "url=https://example.com",
    ]);
    expect(away.code).toBe(0);

    const back = await cliRun(sb, ["monitors", "edit", String(id), "--set", "type=snmp"]);
    expect(back.code).toBe(0);
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({ type: "snmp", snmpVersion: "3" });

    // get/list cannot see the username — a beat is the only observable
    // proof it survived: snmp.js throws "SNMPv3 username is required" at
    // check time when the column is empty, so any other beat msg means the
    // column is still there (loopback answers nothing, so it is a down
    // beat with a net-snmp error, not that message)
    const res = await cliRun(sb, ["monitors", "resume", String(id)]);
    expect(res.code).toBe(0);
    let beat: any;
    for (let i = 0; i < 12 && !beat; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      beat = b.json().find((x: any) => x.status === 0);
    }
    expect(beat).toBeDefined();
    expect(beat.msg).not.toContain("SNMPv3 username is required");

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  // websocket-upgrade.js and its ws_* columns first ship in 2.1.0 — the
  // type gate names the real minimum on both older lines
  test("websocket-upgrade: 2.1+ stores the ws fields and a down beat arrives; older servers refuse", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "websocket-upgrade",
      "--name",
      "it-ws",
      "--url",
      "ws://127.0.0.1:1/socket",
      "--set",
      "wsSubprotocol=soap",
      "--set",
      "wsIgnoreSecWebsocketAcceptHeader=true",
      "--interval",
      "20",
    ]);
    if (!onWsUpgrade) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "websocket-upgrade" needs Uptime Kuma >= 2.1.0');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    // the picker's picks are the stored defaults: close-code 1000, and the
    // generic 48s timeout capped to 80% of the 20s interval — the only way
    // a beat still lands inside the polling window
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "websocket-upgrade",
      url: "ws://127.0.0.1:1/socket",
      accepted_statuscodes: ["1000"],
      wsSubprotocol: "soap",
      wsIgnoreSecWebsocketAcceptHeader: true,
      timeout: 16,
    });

    // nothing answers on port 1 — the socket fails to connect and the down
    // beat proves the monitor runs
    let down = false;
    for (let i = 0; i < 12 && !down; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      down = b.json().some((beat: any) => beat.status === 0);
    }
    expect(down).toBe(true);

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  // oracledb.js first ships in 2.3.0 (upstream #7156) — the type gate
  // names the real minimum on both older lines
  test("oracledb: 2.3+ stores the credentials and a down beat arrives; older servers refuse", async () => {
    const f = join(sb.dir, "ora-it.json");
    writeFileSync(
      f,
      JSON.stringify({
        databaseConnectionString: "127.0.0.1:1/FREEPDB1",
        basic_auth_pass: "oracle-pw",
      }),
    );
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "oracledb",
      "--name",
      "it-ora",
      "--set",
      "basic_auth_user=scott",
      "--config-file",
      f,
      "--interval",
      "20",
    ]);
    if (!onOracleDb) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "oracledb" needs Uptime Kuma >= 2.3.0');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;

    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "oracledb",
      databaseConnectionString: "***",
      basic_auth_user: "scott",
      basic_auth_pass: "***",
    });

    // nothing answers on port 1 — the driver fails to connect and the
    // down beat proves the monitor runs; the beat message must come from
    // the driver's connect attempt, not a TypeError from the .trim() on
    // the credential fields (an unread field would beat down the same way)
    let downMsg = "";
    for (let i = 0; i < 12 && !downMsg; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const b = await cliRun(sb, ["beats", String(id), "--hours", "1"]);
      expect(b.code).toBe(0);
      downMsg = b.json().find((beat: any) => beat.status === 0)?.msg ?? "";
    }
    expect(downMsg).toContain("Database connection/query failed");
    expect(downMsg).not.toContain("trim");

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 300_000);

  // add and editMonitor both JSON.stringify kafkaProducerSaslOptions
  // unconditionally; a monitor whose column never got a value (a row from
  // before the field existed, or a write that stored "null") reports null
  // through getMonitor, and an edit that turns it into kafka-producer must
  // send the same { mechanism: "None" } add defaults to — left null, the
  // kafka check's JSON.parse(...).mechanism throws on every beat. The CLI's
  // own add always sends the default, so the corrupted column is written
  // through a raw editMonitor the way the bug itself leaves it. The monitor
  // stays paused, so no broker ever has to answer.
  test("edit --set type=kafka-producer heals a stored null kafkaProducerSaslOptions", async () => {
    const a = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "http",
      "--name",
      "it-kafka-sw",
      "--url",
      "http://localhost:3001",
      "--paused",
    ]);
    expect(a.code).toBe(0);
    const id = a.json().id;

    await withKuma(async (call) => {
      const got = await call<{ ok?: boolean; monitor?: Record<string, unknown> }>("getMonitor", [
        id,
      ]);
      expect(got.ok).toBe(true);
      const m = got.monitor!;
      m.kafkaProducerSaslOptions = null;
      const res = await call<{ ok?: boolean; msg?: string }>("editMonitor", [m]);
      expect(res.ok).toBe(true);
    });

    const before = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(before.json().kafkaProducerSaslOptions).toBeNull();

    const e = await cliRun(sb, [
      "monitors",
      "edit",
      String(id),
      "--set",
      "type=kafka-producer",
      "--set",
      "kafkaProducerTopic=t",
      "--set",
      "kafkaProducerMessage=m",
      "--set",
      'kafkaProducerBrokers=["127.0.0.1:9092"]',
    ]);
    expect(e.code).toBe(0);

    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.json()).toMatchObject({
      type: "kafka-producer",
      kafkaProducerSaslOptions: { mechanism: "None" },
    });

    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);

  // system-service.js first ships in 2.1.0 and the picker only offers the
  // type on a linux/win32 host outside a container — the integration server
  // is the official image, so a 2.x leg takes the availability refusal
  // while an older leg takes the type gate
  test("system-service exits 2 like the picker's container-hidden type", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "system-service",
      "--name",
      "it-svc",
      "--system-service-name",
      "nginx",
    ]);
    expect(r.code).toBe(2);
    if (!on21) {
      expect(r.stderr).toContain('type "system-service" needs Uptime Kuma >= 2.1.0');
    } else {
      expect(r.stderr).toContain("system-service is not available");
    }
  }, 120_000);

  // pm2.js first ships in 2.5.0; the official image has no pm2 install, so
  // getPM2ProcessList answers ok:false and the picker-equivalent free-text
  // path stores the name unverified — older legs take the type gate
  test("pm2 stores the process name unverified when the server has no pm2", async () => {
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "pm2",
      "--name",
      "it-pm2",
      "--system-service-name",
      "it-pm2-proc",
    ]);
    if (!onPm2) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "pm2" needs Uptime Kuma >= 2.5.0');
      return;
    }
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("could not list PM2 processes");
    const id = r.json().id;
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.code).toBe(0);
    expect(g.json().system_service_name).toBe("it-pm2-proc");
    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);

  // sftp.js first ships in 2.5.4; add only stores the row, so a paused
  // monitor needs no reachable SSH server — older legs take the type gate
  test("sftp stores the ssh fields with the secret redacted on get", async () => {
    const f = join(sb.dir, "sftp-it.json");
    writeFileSync(f, JSON.stringify({ sshPassword: "it-sftp-secret" }));
    const r = await cliRun(sb, [
      "monitors",
      "add",
      "--type",
      "sftp",
      "--name",
      "it-sftp",
      "--hostname",
      "localhost",
      "--ssh-username",
      "it-sftp-user",
      "--sftp-path",
      "/tmp",
      "--config-file",
      f,
      "--paused",
    ]);
    if (!onSftp) {
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('type "sftp" needs Uptime Kuma >= 2.5.4');
      return;
    }
    expect(r.code).toBe(0);
    const id = r.json().id;
    const g = await cliRun(sb, ["monitors", "get", String(id)]);
    expect(g.code).toBe(0);
    expect(g.json()).toMatchObject({
      type: "sftp",
      hostname: "localhost",
      port: 22,
      sshUsername: "it-sftp-user",
      sftpPath: "/tmp",
      sshPassword: "***",
    });
    const del = await cliRun(sb, ["monitors", "delete", String(id), "--yes"]);
    expect(del.code).toBe(0);
  }, 120_000);
});
