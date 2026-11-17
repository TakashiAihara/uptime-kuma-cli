import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

const TCP_PW = "fixture-hidden-dh";
const TCP_URL = `https://u1:${TCP_PW}@tcp-daemon.example.com:2375`;

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    dockerHosts: [
      {
        id: 2,
        userID: 1,
        name: "build host",
        dockerType: "socket",
        dockerDaemon: "/var/run/docker.sock",
      },
      { id: 5, userID: 1, name: "ci tcp", dockerType: "tcp", dockerDaemon: TCP_URL },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("docker-hosts", () => {
  test("list prints the pushed rows sorted by id", async () => {
    const r = await run(sb, ["docker-hosts", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      {
        id: 2,
        name: "build host",
        dockerType: "socket",
        dockerDaemon: "/var/run/docker.sock",
      },
      {
        id: 5,
        name: "ci tcp",
        dockerType: "tcp",
        dockerDaemon: "https://u1:***@tcp-daemon.example.com:2375/",
      },
    ]);
  });

  test("list redacts userinfo inside the daemon url", async () => {
    const r = await run(sb, ["docker-hosts", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()[1].dockerDaemon).not.toContain(TCP_PW);
    expect(r.stdout).not.toContain(TCP_PW);
  });

  test("list hides a schemeless userinfo daemon entirely", async () => {
    kuma.state.dockerHosts = [
      {
        id: 3,
        name: "bare",
        dockerType: "tcp",
        dockerDaemon: `u1:${TCP_PW}@docker.example.com:2375`,
      },
    ];
    const r = await run(sb, ["docker-hosts", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()[0].dockerDaemon).toBe("***");
    expect(r.stdout).not.toContain(TCP_PW);
  });

  test("list prints null for missing fields", async () => {
    kuma.state.dockerHosts = [{ id: 7 }];
    const r = await run(sb, ["docker-hosts", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([{ id: 7, name: null, dockerType: null, dockerDaemon: null }]);
  });

  test("add sends addDockerHost with a null id and prints the new row", async () => {
    const r = await run(
      sb,
      [
        "docker-hosts",
        "add",
        "--name",
        "new host",
        "--type",
        "tcp",
        "--daemon",
        "tcp://ci-daemon.example.com:2376",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 6,
      name: "new host",
      dockerType: "tcp",
      dockerDaemon: "tcp://ci-daemon.example.com:2376",
    });
    const call = kuma.calls.find((c) => c.event === "addDockerHost")!;
    expect(call.args).toEqual([
      { name: "new host", dockerType: "tcp", dockerDaemon: "tcp://ci-daemon.example.com:2376" },
      null,
    ]);
    expect(kuma.state.dockerHosts.find((h) => h.id === 6)).toMatchObject({
      name: "new host",
      dockerType: "tcp",
      dockerDaemon: "tcp://ci-daemon.example.com:2376",
      userID: 1,
    });
  });

  test("add redacts userinfo inside --daemon in the output", async () => {
    const r = await run(
      sb,
      [
        "docker-hosts",
        "add",
        "--name",
        "n",
        "--type",
        "tcp",
        "--daemon",
        TCP_URL.replace("tcp-daemon", "ci-daemon"),
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json().dockerDaemon).not.toContain(TCP_PW);
    expect(r.stdout).not.toContain(TCP_PW);
  });

  test("add with an empty --name exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "add", "--name", "", "--type", "socket", "--daemon", "/tmp/d.sock"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name must not be empty");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add with an empty --daemon exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "add", "--name", "n", "--type", "socket", "--daemon", ""],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--daemon must not be empty");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add with an unknown --type exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "add", "--name", "n", "--type", "ssh", "--daemon", "h"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("add without --type exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "add", "--name", "n", "--daemon", "h"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit merges flags over the stored row and sends the id", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "edit", "2", "--name", "renamed", "--daemon", "/run/docker.sock"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 2,
      name: "renamed",
      dockerType: "socket",
      dockerDaemon: "/run/docker.sock",
    });
    const call = kuma.calls.find((c) => c.event === "addDockerHost")!;
    expect(call.args).toEqual([
      { name: "renamed", dockerType: "socket", dockerDaemon: "/run/docker.sock" },
      2,
    ]);
    expect(kuma.state.dockerHosts.find((h) => h.id === 2)).toMatchObject({
      name: "renamed",
      dockerType: "socket",
      dockerDaemon: "/run/docker.sock",
    });
  });

  test("edit --type alone keeps the stored name and daemon", async () => {
    const r = await run(sb, ["docker-hosts", "edit", "5", "--type", "socket"], creds(kuma.url));
    expect(r.code).toBe(0);
    const call = kuma.calls.find((c) => c.event === "addDockerHost")!;
    expect(call.args[0]).toEqual({
      name: "ci tcp",
      dockerType: "socket",
      dockerDaemon: TCP_URL,
    });
    expect(call.args[1]).toBe(5);
  });

  test("edit without flags exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "edit", "2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docker-hosts edit requires");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit of an unknown id exits 1", async () => {
    const r = await run(sb, ["docker-hosts", "edit", "9", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host 9 not found");
  });

  test("edit with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "edit", "abc", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit with an empty --name exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "edit", "2", "--name", ""], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name must not be empty");
    expect(kuma.calls).toHaveLength(0);
  });

  test("test <id> sends the stored host fields and prints Kuma's msg", async () => {
    const r = await run(sb, ["docker-hosts", "test", "2"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      id: 2,
      ok: true,
      msg: "Connected Successfully. Amount of containers: 2",
    });
    const call = kuma.calls.find((c) => c.event === "testDockerHost")!;
    expect(call.args).toEqual([
      { name: "build host", dockerType: "socket", dockerDaemon: "/var/run/docker.sock" },
    ]);
  });

  test("test of an unknown id exits 1", async () => {
    const r = await run(sb, ["docker-hosts", "test", "9"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host 9 not found");
  });

  test("test with --type/--daemon sends an ad-hoc host", async () => {
    const r = await run(
      sb,
      [
        "docker-hosts",
        "test",
        "--name",
        "probe",
        "--type",
        "tcp",
        "--daemon",
        "tcp://ci-daemon.example.com:2375",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      msg: "Connected Successfully. Amount of containers: 2",
    });
    const call = kuma.calls.find((c) => c.event === "testDockerHost")!;
    expect(call.args).toEqual([
      { name: "probe", dockerType: "tcp", dockerDaemon: "tcp://ci-daemon.example.com:2375" },
    ]);
  });

  test("test flags without --name send an empty name", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "test", "--type", "socket", "--daemon", "/tmp/d.sock"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    const call = kuma.calls.find((c) => c.event === "testDockerHost")!;
    expect(call.args).toEqual([{ name: "", dockerType: "socket", dockerDaemon: "/tmp/d.sock" }]);
  });

  test("test with an id and flags exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "test", "2", "--type", "socket", "--daemon", "/tmp/d.sock"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("either a host id or --name/--type/--daemon");
    expect(kuma.calls).toHaveLength(0);
  });

  test("test without id, --type or --daemon exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "test"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires --type and --daemon");
    expect(kuma.calls).toHaveLength(0);
  });

  test("test flags missing --daemon exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "test", "--type", "socket"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("test flags missing --type exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "test", "--daemon", "/tmp/d.sock"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("test with an empty --daemon exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["docker-hosts", "test", "--type", "socket", "--daemon", ""],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--daemon must not be empty");
    expect(kuma.calls).toHaveLength(0);
  });

  test("test: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.testDockerHost = "connect ENOENT /var/run/docker.sock";
    const r = await run(sb, ["docker-hosts", "test", "2"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("connect ENOENT /var/run/docker.sock");
  });

  test("delete removes the host and prints { id, deleted: true }", async () => {
    const r = await run(sb, ["docker-hosts", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2, deleted: true });
    expect(kuma.state.dockerHosts.map((h) => h.id)).toEqual([5]);
    expect(kuma.calls.find((c) => c.event === "deleteDockerHost")!.args).toEqual([2]);
  });

  test("fake: deleteDockerHost nulls docker_host on monitors like Kuma", async () => {
    kuma.state.monitors.push({ id: 5, name: "docker mon", docker_host: 2 });
    const r = await run(sb, ["docker-hosts", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(kuma.state.monitors[0]!.docker_host).toBeNull();
  });

  test("delete without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "delete", "2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would delete docker host 2");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["docker-hosts", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete of an unknown id exits 1 with Kuma's 'docker host not found'", async () => {
    const r = await run(sb, ["docker-hosts", "delete", "9", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("docker host not found");
    expect(kuma.state.dockerHosts).toHaveLength(2);
  });
});
