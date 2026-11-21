import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma | undefined;
let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await kuma?.close();
  kuma = undefined;
  sb.cleanup();
});

// Every test here runs the 2.5.11 profile unless it overrides init.
async function useFake(init: Parameters<typeof startFakeKuma>[0] = {}): Promise<FakeKuma> {
  kuma = await startFakeKuma({ profile: "2.x", ...init });
  return kuma;
}

const callsOf = (k: FakeKuma, event: string) => k.calls.filter((c) => c.event === event);

const sentSettings = (k: FakeKuma): Record<string, unknown> =>
  callsOf(k, "setSettings")[0]!.args[0] as Record<string, unknown>;

const writeJson = (name: string, value: Record<string, unknown>) => {
  const path = join(sb.dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

describe("settings set on Kuma 2.x", () => {
  test("domainExpiryNotifyDays is sorted and de-duplicated like tlsExpiryNotifyDays", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["settings", "set", "--set", "domainExpiryNotifyDays=[30,7,14,7]"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings(k).domainExpiryNotifyDays).toEqual([7, 14, 30]);
    expect(r.json().domainExpiryNotifyDays).toEqual([7, 14, 30]);
  });

  test.each([
    "domainExpiryNotifyDays=7",
    "domainExpiryNotifyDays=[0]",
    "domainExpiryNotifyDays=[-3]",
    'domainExpiryNotifyDays=["7"]',
  ])("settings set --set %s exits 2 before connecting", async (set) => {
    const k = await useFake();
    const r = await run(sb, ["settings", "set", "--set", set], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"domainExpiryNotifyDays" must be an array of positive integers');
    expect(k.calls).toHaveLength(0);
  });

  test("globalpingApiToken via --config-file is sent raw and printed as ***", async () => {
    const k = await useFake();
    const token = ["fixture", "globalping", "token"].join("-");
    const f = writeJson("gp.json", { globalpingApiToken: token });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(k.url));
    expect(r.code).toBe(0);
    // the raw value goes on the wire; only the printed output is redacted
    expect(sentSettings(k).globalpingApiToken).toBe(token);
    expect(r.json().globalpingApiToken).toBe("***");
    expect(r.stdout).not.toContain(token);
    expect(r.stderr).not.toContain(token);
    expect(k.state.settings.globalpingApiToken).toBe(token);
  });

  test('globalpingApiToken "***" via --config-file exits 2 and stores nothing', async () => {
    // the placeholder a `settings get` result carries; feeding it back must
    // not overwrite the stored key
    const k = await useFake({ settings: { globalpingApiToken: "stored-real-token" } });
    const f = writeJson("gp.json", { globalpingApiToken: "***" });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("redacted placeholder");
    expect(r.stderr).toContain("omit the key");
    expect(k.calls).toHaveLength(0);
    expect(k.state.settings.globalpingApiToken).toBe("stored-real-token");
  });

  test("globalpingApiToken in --set exits 2 pointing at --config-file", async () => {
    const k = await useFake();
    const r = await run(sb, ["settings", "set", "--set", "globalpingApiToken=x"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("use --config-file instead");
    expect(k.calls).toHaveLength(0);
  });

  test("dnsCache exits 2 on a 2.x server after connecting", async () => {
    const k = await useFake();
    const r = await run(sb, ["settings", "set", "--set", "dnsCache=true"], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"dnsCache" is not read on Uptime Kuma 2.x');
    expect(r.stderr).toContain("2.5.11");
    // the refusal lands after connect but before the settings are read or sent
    expect(callsOf(k, "getSettings")).toHaveLength(0);
    expect(callsOf(k, "setSettings")).toHaveLength(0);
  });

  test("a stored dnsCache round-trips untouched on 2.x", async () => {
    // setSettings upserts only the keys sent, so a stored 1.x-era dnsCache
    // stays in the fetched object and goes back whole like any other key
    const k = await useFake({
      settings: { dnsCache: true, someFutureKey: "keep-me" },
    });
    const r = await run(sb, ["settings", "set", "--set", "trustProxy=true"], creds(k.url));
    expect(r.code).toBe(0);
    expect(sentSettings(k)).toMatchObject({ dnsCache: true, someFutureKey: "keep-me" });
  });

  test("the 2.x UI defaults are filled and dnsCache is not injected", async () => {
    const k = await useFake({ settings: { primaryBaseURL: "https://kuma.example.com" } });
    const r = await run(sb, ["settings", "set", "--set", "chromeExecutable="], creds(k.url));
    expect(r.code).toBe(0);
    const sent = sentSettings(k);
    expect(sent).toMatchObject({
      checkUpdate: true,
      searchEngineIndex: false,
      entryPage: "dashboard",
      nscd: true,
      keepDataPeriodDays: 180,
      tlsExpiryNotifyDays: [7, 14, 21],
      domainExpiryNotifyDays: [7, 14, 21],
      trustProxy: false,
      // the fetched serverTimezone fill and stored values are kept
      serverTimezone: "UTC",
      primaryBaseURL: "https://kuma.example.com",
      chromeExecutable: "",
    });
    expect(sent).not.toHaveProperty("dnsCache");
  });

  test("the 2.x UI defaults do not overwrite stored values", async () => {
    const k = await useFake({
      settings: {
        checkUpdate: false,
        searchEngineIndex: true,
        entryPage: "dashboard",
        nscd: false,
        keepDataPeriodDays: 365,
        tlsExpiryNotifyDays: [3],
        domainExpiryNotifyDays: [5],
        trustProxy: true,
      },
    });
    const r = await run(
      sb,
      ["settings", "set", "--set", "chromeExecutable=/bin/chromium"],
      creds(k.url),
    );
    expect(r.code).toBe(0);
    expect(sentSettings(k)).toMatchObject({
      checkUpdate: false,
      searchEngineIndex: true,
      entryPage: "dashboard",
      nscd: false,
      keepDataPeriodDays: 365,
      tlsExpiryNotifyDays: [3],
      domainExpiryNotifyDays: [5],
      trustProxy: true,
      chromeExecutable: "/bin/chromium",
    });
  });
});

describe("serverTimezone on Kuma 2.x", () => {
  // these names are in the 2.x UI list but not the 1.23.17 one
  test.each(["America/Nuuk", "America/Ciudad_Juarez", "Pacific/Kanton"])(
    "serverTimezone %p is accepted",
    async (tz) => {
      const k = await useFake();
      const r = await run(sb, ["settings", "set", "--set", `serverTimezone=${tz}`], creds(k.url));
      expect(r.code).toBe(0);
      expect(sentSettings(k).serverTimezone).toBe(tz);
    },
  );

  // in the 1.23.17 UI list but not the 2.x one: passes the pre-connect union
  // check and is refused once the version is known
  test.each(["America/Rainy_River", "America/Godthab"])(
    "serverTimezone %p exits 2 after connecting",
    async (tz) => {
      const k = await useFake();
      const r = await run(sb, ["settings", "set", "--set", `serverTimezone=${tz}`], creds(k.url));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('"serverTimezone" must be a timezone name');
      expect(r.stderr).toContain("2.5.11");
      expect(callsOf(k, "getSettings")).toHaveLength(0);
      expect(callsOf(k, "setSettings")).toHaveLength(0);
    },
  );

  test("a serverTimezone from --config-file is checked against the 2.x list too", async () => {
    const k = await useFake();
    const f = writeJson("tz.json", { serverTimezone: "America/Rainy_River" });
    const r = await run(sb, ["settings", "set", "--config-file", f], creds(k.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("2.5.11");
    expect(callsOf(k, "setSettings")).toHaveLength(0);
  });

  test("a name in neither list still exits 2 before connecting", async () => {
    const k = await useFake();
    const r = await run(
      sb,
      ["settings", "set", "--set", "serverTimezone=Europe/Zaporizhzhia"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"serverTimezone" must be a timezone name');
    expect(k.calls).toHaveLength(0);
  });
});

describe("version fallbacks on Kuma 2.x profile", () => {
  test("with no version from the server the 2.x keys are refused as 1.x", async () => {
    const k = await useFake({ info: null });
    const r = await run(
      sb,
      ["settings", "set", "--set", "domainExpiryNotifyDays=[7]"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the server sent no version, so 1.x was assumed");
    expect(callsOf(k, "setSettings")).toHaveLength(0);
  });

  test("with no version a 2.x-only timezone is refused against the 1.x list", async () => {
    const k = await useFake({ info: null });
    const r = await run(
      sb,
      ["settings", "set", "--set", "serverTimezone=America/Nuuk"],
      creds(k.url),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the Uptime Kuma 1.x UI offers");
    expect(callsOf(k, "setSettings")).toHaveLength(0);
  });
});
