import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { io as ioc } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeKuma, type StatusPageRow, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

// statusPageList row; entryPage=statusPage-<slug> must name one of these
const STATUS_PAGE: StatusPageRow = { id: 7, slug: "status", title: "Status page" };

const callsOf = (event: string) => kuma.calls.filter((c) => c.event === event);

const writeJson = (name: string, value: Record<string, unknown>) => {
  const path = join(sb.dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const sentSettings = (): Record<string, unknown> =>
  callsOf("setSettings")[0]!.args[0] as Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A second logged-in socket like a browser session; resolves with the first
// of "refresh" / "disconnect" the fake sends it
const otherClient = async () => {
  const socket = ioc(kuma.url, { transports: ["websocket"], reconnection: false });
  const seen = new Promise<string>((resolve) => {
    socket.once("refresh", () => resolve("refresh"));
    socket.once("disconnect", () => resolve("disconnect"));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect_error", reject);
    socket.once("connect", () => {
      socket.emit(
        "login",
        { username: "admin", password: "pw-from-test", token: "" },
        (res: { ok?: boolean }) =>
          res?.ok === true ? resolve() : reject(new Error("login failed")),
      );
    });
  });
  return { socket, seen };
};

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({ statusPages: [structuredClone(STATUS_PAGE)] });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("settings get", () => {
  test("prints the stored general settings", async () => {
    kuma.state.settings = {
      serverTimezone: "Asia/Tokyo",
      primaryBaseURL: "https://kuma.example.com",
      keepDataPeriodDays: 30,
      trustProxy: true,
    };
    const r = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      serverTimezone: "Asia/Tokyo",
      primaryBaseURL: "https://kuma.example.com",
      keepDataPeriodDays: 30,
      trustProxy: true,
    });
  });

  test("prints the serverTimezone fill when it is not stored", async () => {
    kuma.state.settings = { primaryBaseURL: "https://kuma.example.com" };
    const r = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      primaryBaseURL: "https://kuma.example.com",
      serverTimezone: "UTC",
    });
  });

  test("steamAPIKey prints as *** when it holds a value", async () => {
    kuma.state.settings = { steamAPIKey: "steam-secret-value" };
    const r = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().steamAPIKey).toBe("***");
    expect(r.stdout).not.toContain("steam-secret-value");
  });

  test("an empty steamAPIKey prints as empty", async () => {
    kuma.state.settings = { steamAPIKey: "" };
    const r = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json().steamAPIKey).toBe("");
  });

  test("getSettings ok:false exits 1 with Kuma's message", async () => {
    kuma.state.fail.getSettings = "You are not logged in.";
    const r = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("You are not logged in.");
  });

  test("a malformed getSettings response exits 70", async () => {
    kuma.state.getSettingsResult = { ok: true };
    const r1 = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r1.code).toBe(70);
    expect(r1.stderr).toContain("unexpected getSettings response");
    kuma.state.getSettingsResult = { ok: true, data: [1, 2] };
    const r2 = await run(sb, ["settings", "get"], creds(kuma.url));
    expect(r2.code).toBe(70);
  });
});

describe("settings set", () => {
  test("without --set or --config-file exits 2 before connecting", async () => {
    const r = await run(sb, ["settings", "set"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires at least one --set key=value or --config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an empty --config-file object exits 2 before connecting", async () => {
    const f = writeJson("empty.json", {});
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires at least one");
    expect(kuma.calls).toHaveLength(0);
  });

  test("a malformed --set exits 2 before connecting", async () => {
    const r = await run(sb, ["settings", "set", "--set", "trustProxy"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--set expects key=value");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an unknown --set key exits 2 naming it before connecting", async () => {
    const r = await run(sb, ["settings", "set", "--set", "bogus=1"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"bogus"');
    expect(r.stderr).toContain("--set");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an unknown --config-file key exits 2 naming it before connecting", async () => {
    const f = writeJson("s.json", { entryPage: "dashboard", bogus: 1 });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"bogus"');
    expect(r.stderr).toContain("--config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("steamAPIKey in --set exits 2 pointing at --config-file", async () => {
    const r = await run(sb, ["settings", "set", "--set", "steamAPIKey=abc"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("use --config-file instead");
    expect(kuma.calls).toHaveLength(0);
  });

  test("a missing --config-file exits 2 before connecting", async () => {
    const r = await run(
      sb,
      ["settings", "set", "--config-file", join(sb.dir, "none.json")],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config-file");
    expect(kuma.calls).toHaveLength(0);
  });

  test("an invalid JSON --config-file exits 2 before connecting", async () => {
    const path = join(sb.dir, "bad.json");
    writeFileSync(path, "{not json");
    const r = await run(sb, ["settings", "set", "--config-file", path], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
    expect(kuma.calls).toHaveLength(0);
  });

  test("a non-object --config-file exits 2 before connecting", async () => {
    const path = join(sb.dir, "arr.json");
    writeFileSync(path, "[1,2]");
    const r = await run(sb, ["settings", "set", "--config-file", path], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must contain a JSON object");
    expect(kuma.calls).toHaveLength(0);
  });

  test.each([
    ["serverTimezone=Not/AZone", '"serverTimezone" must be an IANA timezone name'],
    ["serverTimezone=", '"serverTimezone" must be an IANA timezone name'],
    ["searchEngineIndex=yes", '"searchEngineIndex" must be a boolean'],
    ["entryPage=foo", '"entryPage" must be "dashboard" or "statusPage-<slug>"'],
    ["entryPage=statusPage-", '"entryPage" must be "dashboard" or "statusPage-<slug>"'],
    ["entryPage=statusPage-Bad_Slug", '"entryPage" must be "dashboard" or "statusPage-<slug>"'],
    ["entryPage=123", '"entryPage" must be "dashboard" or "statusPage-<slug>"'],
    [
      "primaryBaseURL=notaurl",
      '"primaryBaseURL" must be a URL starting with http:// or https://, or empty',
    ],
    [
      "primaryBaseURL=ftp://example.com",
      '"primaryBaseURL" must be a URL starting with http:// or https://, or empty',
    ],
    ["primaryBaseURL=123", '"primaryBaseURL" must be a string'],
    ["nscd=yes", '"nscd" must be a boolean'],
    ["dnsCache=1", '"dnsCache" must be a boolean'],
    ["chromeExecutable=123", '"chromeExecutable" must be a string'],
    ["checkUpdate=yes", '"checkUpdate" must be a boolean'],
    ["checkBeta=1", '"checkBeta" must be a boolean'],
    ["trustProxy=yes", '"trustProxy" must be a boolean'],
    ["keepDataPeriodDays=-1", '"keepDataPeriodDays" must be an integer of 0 or more'],
    ["keepDataPeriodDays=1.5", '"keepDataPeriodDays" must be an integer of 0 or more'],
    ["keepDataPeriodDays=abc", '"keepDataPeriodDays" must be an integer of 0 or more'],
    ["tlsExpiryNotifyDays=7", '"tlsExpiryNotifyDays" must be an array of positive integers'],
    ["tlsExpiryNotifyDays=[0]", '"tlsExpiryNotifyDays" must be an array of positive integers'],
    ["tlsExpiryNotifyDays=[-3]", '"tlsExpiryNotifyDays" must be an array of positive integers'],
    ["tlsExpiryNotifyDays=[1.5]", '"tlsExpiryNotifyDays" must be an array of positive integers'],
    ['tlsExpiryNotifyDays=["7"]', '"tlsExpiryNotifyDays" must be an array of positive integers'],
    ["disableAuth=yes", '"disableAuth" must be a boolean'],
  ])("settings set --set %s exits 2 before connecting", async (set, msg) => {
    const r = await run(sb, ["settings", "set", "--set", set], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(msg);
    expect(kuma.calls).toHaveLength(0);
  });

  const badFileCases: [Record<string, unknown>, string][] = [
    [{ trustProxy: "yes" }, '"trustProxy" must be a boolean'],
    [{ steamAPIKey: 123 }, '"steamAPIKey" must be a string'],
    [{ keepDataPeriodDays: -1 }, '"keepDataPeriodDays" must be an integer of 0 or more'],
    [
      { entryPage: "statusPage-Bad_Slug" },
      '"entryPage" must be "dashboard" or "statusPage-<slug>"',
    ],
  ];
  test.each(badFileCases)(
    "a bad --config-file value %j exits 2 before connecting",
    async (obj, msg) => {
      const f = writeJson("s.json", obj);
      const r = await run(sb, ["settings", "set", "--config-file", f], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(msg);
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("every editable key accepts a valid value", async () => {
    const r = await run(
      sb,
      [
        "settings",
        "set",
        "--set",
        "serverTimezone=Asia/Tokyo",
        "--set",
        "searchEngineIndex=true",
        "--set",
        "entryPage=dashboard",
        "--set",
        "primaryBaseURL=",
        "--set",
        "nscd=false",
        "--set",
        "dnsCache=true",
        "--set",
        "chromeExecutable=",
        "--set",
        "checkUpdate=false",
        "--set",
        "checkBeta=true",
        "--set",
        "trustProxy=true",
        "--set",
        "keepDataPeriodDays=0",
        "--set",
        "tlsExpiryNotifyDays=[]",
        "--set",
        "disableAuth=false",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings()).toMatchObject({
      serverTimezone: "Asia/Tokyo",
      searchEngineIndex: true,
      entryPage: "dashboard",
      primaryBaseURL: "",
      nscd: false,
      dnsCache: true,
      chromeExecutable: "",
      checkUpdate: false,
      checkBeta: true,
      trustProxy: true,
      keepDataPeriodDays: 0,
      tlsExpiryNotifyDays: [],
      disableAuth: false,
    });
  });

  test("set merges fetched < config-file < --set and prints the re-read settings", async () => {
    kuma.state.settings = {
      primaryBaseURL: "https://old.example.com",
      steamAPIKey: "old-steam-secret",
      keepDataPeriodDays: 100,
      serverTimezone: "Europe/Berlin",
      someFutureKey: "keep-me",
    };
    const f = writeJson("settings.json", {
      primaryBaseURL: "https://file.example.com",
      keepDataPeriodDays: 50,
      chromeExecutable: "/usr/bin/chromium",
    });
    const r = await run(
      sb,
      [
        "settings",
        "set",
        "--config-file",
        f,
        "--set",
        "keepDataPeriodDays=30",
        "--set",
        "trustProxy=true",
        "--set",
        "tlsExpiryNotifyDays=[30,7,14,7]",
      ],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    // one fetch to merge, one after the save for the printed result
    expect(callsOf("getSettings")).toHaveLength(2);
    const sent = sentSettings();
    expect(callsOf("setSettings")[0]!.args[1]).toBe("pw-from-test");
    expect(sent).toMatchObject({
      // --set beats --config-file beats the fetched value
      keepDataPeriodDays: 30,
      primaryBaseURL: "https://file.example.com",
      trustProxy: true,
      // from --config-file
      chromeExecutable: "/usr/bin/chromium",
      // sorted and de-duplicated like the UI keeps the list
      tlsExpiryNotifyDays: [7, 14, 30],
      // untouched fetched values go back whole, secrets raw on the wire
      steamAPIKey: "old-steam-secret",
      serverTimezone: "Europe/Berlin",
      someFutureKey: "keep-me",
    });
    const j = r.json();
    expect(j.keepDataPeriodDays).toBe(30);
    expect(j.primaryBaseURL).toBe("https://file.example.com");
    expect(j.tlsExpiryNotifyDays).toEqual([7, 14, 30]);
    expect(j.steamAPIKey).toBe("***");
    expect(r.stdout).not.toContain("old-steam-secret");
    expect(kuma.state.settings.steamAPIKey).toBe("old-steam-secret");
    expect(kuma.state.settings.someFutureKey).toBe("keep-me");
  });

  test("the UI defaults are filled for keys the fetched object lacks", async () => {
    kuma.state.settings = { primaryBaseURL: "https://kuma.example.com" };
    const r = await run(sb, ["settings", "set", "--set", "chromeExecutable="], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(sentSettings()).toMatchObject({
      checkUpdate: true,
      searchEngineIndex: false,
      entryPage: "dashboard",
      nscd: true,
      dnsCache: false,
      keepDataPeriodDays: 180,
      tlsExpiryNotifyDays: [7, 14, 21],
      trustProxy: false,
      // the fetched serverTimezone fill and stored values are kept
      serverTimezone: "UTC",
      primaryBaseURL: "https://kuma.example.com",
      chromeExecutable: "",
    });
  });

  test("the UI defaults do not overwrite stored values", async () => {
    kuma.state.settings = {
      checkUpdate: false,
      searchEngineIndex: true,
      entryPage: "dashboard",
      nscd: false,
      dnsCache: true,
      keepDataPeriodDays: 365,
      tlsExpiryNotifyDays: [3],
      trustProxy: true,
    };
    const r = await run(
      sb,
      ["settings", "set", "--set", "chromeExecutable=/bin/chromium"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings()).toMatchObject({
      checkUpdate: false,
      searchEngineIndex: true,
      entryPage: "dashboard",
      nscd: false,
      dnsCache: true,
      keepDataPeriodDays: 365,
      tlsExpiryNotifyDays: [3],
      trustProxy: true,
      chromeExecutable: "/bin/chromium",
    });
  });

  test("tlsExpiryNotifyDays is sorted and de-duplicated like the UI", async () => {
    const r = await run(
      sb,
      ["settings", "set", "--set", "tlsExpiryNotifyDays=[30,7,14,7]"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings().tlsExpiryNotifyDays).toEqual([7, 14, 30]);
  });

  test("steamAPIKey via --config-file is sent raw and printed as ***", async () => {
    const f = writeJson("s.json", { steamAPIKey: "brand-new-steam-key" });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(sentSettings().steamAPIKey).toBe("brand-new-steam-key");
    expect(r.json().steamAPIKey).toBe("***");
    expect(r.stdout).not.toContain("brand-new-steam-key");
    expect(r.stderr).not.toContain("brand-new-steam-key");
    expect(kuma.state.settings.steamAPIKey).toBe("brand-new-steam-key");
  });

  test("entryPage=statusPage-<slug> is sent when the page exists", async () => {
    const r = await run(
      sb,
      ["settings", "set", "--set", "entryPage=statusPage-status"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings().entryPage).toBe("statusPage-status");
  });

  test("entryPage=statusPage-<unknown> exits 1 before setSettings", async () => {
    const r = await run(
      sb,
      ["settings", "set", "--set", "entryPage=statusPage-ghost"],
      creds(kuma.url),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("status page ghost not found");
    expect(callsOf("setSettings")).toHaveLength(0);
    // the settings were still fetched for the merge
    expect(callsOf("getSettings")).toHaveLength(1);
  });

  test("an entryPage slug from --config-file is checked too", async () => {
    const f = writeJson("s.json", { entryPage: "statusPage-ghost" });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("status page ghost not found");
    expect(callsOf("setSettings")).toHaveLength(0);
  });

  test("a statusPage entryPage waits for the statusPageList push", async () => {
    kuma.state.skipLists = ["statusPageList"];
    const r = await run(
      sb,
      ["settings", "set", "--set", "entryPage=statusPage-status"],
      creds(kuma.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("statusPageList");
    expect(callsOf("setSettings")).toHaveLength(0);
  });

  test("other settings do not wait for the statusPageList push", async () => {
    kuma.state.skipLists = ["statusPageList"];
    const r = await run(sb, ["settings", "set", "--set", "keepDataPeriodDays=90"], creds(kuma.url));
    expect(r.code).toBe(0);
  });

  test("setSettings ok:false exits 1 with Kuma's message", async () => {
    kuma.state.fail.setSettings = "Incorrect current password";
    const r = await run(sb, ["settings", "set", "--set", "trustProxy=true"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Incorrect current password");
    expect(kuma.state.settings.trustProxy).toBeUndefined();
  });

  test("a getSettings failure exits 1 before setSettings", async () => {
    kuma.state.fail.getSettings = "settings read failed";
    const r = await run(sb, ["settings", "set", "--set", "trustProxy=true"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("settings read failed");
    expect(callsOf("setSettings")).toHaveLength(0);
  });

  test("a malformed getSettings response exits 70 before setSettings", async () => {
    kuma.state.getSettingsResult = { ok: true };
    const r = await run(sb, ["settings", "set", "--set", "trustProxy=true"], creds(kuma.url));
    expect(r.code).toBe(70);
    expect(callsOf("setSettings")).toHaveLength(0);
  });

  test("a failure on the post-save read exits 1 after the write", async () => {
    kuma.state.fail.getSettings = [null, "second read failed"];
    const r = await run(sb, ["settings", "set", "--set", "trustProxy=true"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("second read failed");
    expect(kuma.state.settings.trustProxy).toBe(true);
  });

  test("disableAuth=true while auth is on verifies the login password", async () => {
    const r = await run(sb, ["settings", "set", "--set", "disableAuth=true"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(callsOf("setSettings")[0]!.args[1]).toBe("pw-from-test");
    expect(kuma.state.settings.disableAuth).toBe(true);
  });

  test("disableAuth=true while already disabled skips the password check", async () => {
    kuma.state.settings = { disableAuth: true };
    kuma.state.settingsPassword = "rotated-after-login";
    const r = await run(sb, ["settings", "set", "--set", "disableAuth=true"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(kuma.state.settings.disableAuth).toBe(true);
  });

  test("a rotated password fails the disableAuth check with Kuma's message", async () => {
    kuma.state.settingsPassword = "rotated-after-login";
    const r = await run(sb, ["settings", "set", "--set", "disableAuth=true"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Incorrect current password");
    expect(kuma.state.settings.disableAuth).toBeUndefined();
  });

  test("re-enabling auth disconnects the user's other clients", async () => {
    kuma.state.settings = { disableAuth: true };
    const other = await otherClient();
    try {
      const r = await run(sb, ["settings", "set", "--set", "disableAuth=false"], creds(kuma.url));
      expect(r.code).toBe(0);
      // refresh arrives before the disconnect, like the real server sends
      expect(await other.seen).toBe("refresh");
      expect(kuma.state.settings.disableAuth).toBe(false);
    } finally {
      other.socket.close();
    }
  });

  test("an unrelated edit while auth is disabled does not disconnect clients", async () => {
    kuma.state.settings = { disableAuth: true };
    const other = await otherClient();
    try {
      let dropped = false;
      other.socket.on("disconnect", () => {
        dropped = true;
      });
      const r = await run(
        sb,
        ["settings", "set", "--set", "keepDataPeriodDays=90"],
        creds(kuma.url),
      );
      expect(r.code).toBe(0);
      // give a wrongly-sent disconnect packet time to arrive before judging
      await sleep(150);
      expect(dropped).toBe(false);
      expect(other.socket.connected).toBe(true);
      expect(kuma.state.settings.disableAuth).toBe(true);
    } finally {
      other.socket.close();
    }
  });
});
