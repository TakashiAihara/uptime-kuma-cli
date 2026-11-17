import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "../helpers/run";
import { cliRun } from "./helpers";

// Runs only when scripts/integration.ts provides UPTIME_KUMA_IT_*; a plain
// `bun test` skips the whole file. The compose file mounts no docker socket,
// so testDockerHost exercises Kuma's real failure path against a daemon that
// does not exist inside the container.
describe.skipIf(!process.env.UPTIME_KUMA_IT_URL)("docker-hosts (real Kuma)", () => {
  let sb: Sandbox;
  let hostId = 0;

  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  test("add --name it-host --type socket --daemon /var/run/docker.sock", async () => {
    const r = await cliRun(sb, [
      "docker-hosts",
      "add",
      "--name",
      "it-host",
      "--type",
      "socket",
      "--daemon",
      "/var/run/docker.sock",
    ]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.id).toBeGreaterThan(0);
    expect(out).toEqual({
      id: out.id,
      name: "it-host",
      dockerType: "socket",
      dockerDaemon: "/var/run/docker.sock",
    });
    hostId = out.id;
  }, 120_000);

  test("list shows the row without userID", async () => {
    const r = await cliRun(sb, ["docker-hosts", "list"]);
    expect(r.code).toBe(0);
    const row = r.json().find((h: any) => h.id === hostId);
    expect(row).toEqual({
      id: hostId,
      name: "it-host",
      dockerType: "socket",
      dockerDaemon: "/var/run/docker.sock",
    });
  }, 120_000);

  test("edit --name renames it and keeps the stored fields", async () => {
    const r = await cliRun(sb, ["docker-hosts", "edit", String(hostId), "--name", "it-host-2"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      id: hostId,
      name: "it-host-2",
      dockerType: "socket",
      dockerDaemon: "/var/run/docker.sock",
    });
    const list = await cliRun(sb, ["docker-hosts", "list"]);
    expect(list.code).toBe(0);
    expect(list.json().find((h: any) => h.id === hostId)).toMatchObject({
      name: "it-host-2",
      dockerDaemon: "/var/run/docker.sock",
    });
  }, 180_000);

  test("test <id> exits 1 with Kuma's daemon error", async () => {
    const r = await cliRun(sb, ["docker-hosts", "test", String(hostId)]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  }, 120_000);

  test("test with ad-hoc flags takes the same failure path", async () => {
    const r = await cliRun(sb, [
      "docker-hosts",
      "test",
      "--type",
      "socket",
      "--daemon",
      "/var/run/docker.sock",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  }, 120_000);

  test("delete --yes removes it and a second delete exits 1", async () => {
    const r = await cliRun(sb, ["docker-hosts", "delete", String(hostId), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: hostId, deleted: true });
    const list = await cliRun(sb, ["docker-hosts", "list"]);
    expect(list.code).toBe(0);
    expect(list.json().find((h: any) => h.id === hostId)).toBeUndefined();
    const again = await cliRun(sb, ["docker-hosts", "delete", String(hostId), "--yes"]);
    expect(again.code).toBe(1);
  }, 240_000);
});
