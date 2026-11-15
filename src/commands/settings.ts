import { type Command } from "commander";
import { fail, parseSets, printJson, readJsonFile } from "../lib.ts";
import { connect, type KumaSession } from "../kuma.ts";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

// addStatusPage lower-cases the slug before checkSlug, so stored slugs are
// lowercase words joined by single hyphens (same pattern as status-pages.ts).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ENTRY_PAGE_PREFIX = "statusPage-";

const isIanaTimezone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// The keys the 1.23.17 settings components write through the shared `settings`
// object that saveSettings posts whole to setSettings: General.vue
// (serverTimezone, searchEngineIndex, entryPage, primaryBaseURL, steamAPIKey,
// nscd, dnsCache, chromeExecutable), About.vue (checkUpdate, checkBeta),
// ReverseProxy.vue (trustProxy), MonitorHistory.vue (keepDataPeriodDays),
// Notifications.vue (tlsExpiryNotifyDays) and Security.vue (disableAuth).
// cloudflaredTunnelToken is not one: it goes through the cloudflared_* events.
const SETTING_VALUE_CHECKS: Record<string, (value: unknown, key: string) => unknown> = {
  // General.vue offers UTC plus the IANA names timezoneList() returns
  serverTimezone: (value, key) => {
    if (typeof value !== "string" || value === "" || !isIanaTimezone(value)) {
      fail(2, `"${key}" must be an IANA timezone name`);
    }
    return value;
  },
  searchEngineIndex: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  // "dashboard" or "statusPage-<slug>"; the slug's existence in statusPageList
  // can only be checked after connecting
  entryPage: (value, key) => {
    if (value === "dashboard") return value;
    if (
      typeof value === "string" &&
      value.startsWith(ENTRY_PAGE_PREFIX) &&
      SLUG_PATTERN.test(value.slice(ENTRY_PAGE_PREFIX.length))
    ) {
      return value;
    }
    fail(2, `"${key}" must be "dashboard" or "statusPage-<slug>"`);
  },
  // the input's pattern is https?://.+ and it is not required, so "" is valid
  primaryBaseURL: (value, key) => {
    if (typeof value !== "string") fail(2, `"${key}" must be a string`);
    if (value !== "") {
      let protocol = "";
      try {
        protocol = new URL(value).protocol;
      } catch {
        // not a URL at all
      }
      if (protocol !== "http:" && protocol !== "https:") {
        fail(2, `"${key}" must be a URL starting with http:// or https://, or empty`);
      }
    }
    return value;
  },
  steamAPIKey: (value, key) => {
    if (typeof value !== "string") fail(2, `"${key}" must be a string`);
    return value;
  },
  nscd: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  dnsCache: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  chromeExecutable: (value, key) => {
    if (typeof value !== "string") fail(2, `"${key}" must be a string`);
    return value;
  },
  checkUpdate: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  checkBeta: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  trustProxy: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
  // MonitorHistory.vue: type=number min=0 step=1, and Settings.vue
  // validateSettings rejects < 0
  keepDataPeriodDays: (value, key) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      fail(2, `"${key}" must be an integer of 0 or more`);
    }
    return value;
  },
  // Notifications.vue accepts only positive integers and keeps the list
  // sorted and duplicate-free
  tlsExpiryNotifyDays: (value, key) => {
    if (
      !Array.isArray(value) ||
      value.some((d) => typeof d !== "number" || !Number.isInteger(d) || d <= 0)
    ) {
      fail(2, `"${key}" must be an array of positive integers`);
    }
    return [...new Set(value as number[])].sort((a, b) => a - b);
  },
  disableAuth: (value, key) => {
    if (typeof value !== "boolean") fail(2, `"${key}" must be a boolean`);
    return value;
  },
};

const SETTING_KEYS = new Set(Object.keys(SETTING_VALUE_CHECKS));

// Settings.vue loadSettings fills these into the fetched object before any
// save, so the object posted to setSettings always carries them. They are not
// cosmetic: with nscd absent the handler reads data.nscd as undefined, which
// differs from the stored null and stops the nscd service on containers.
const UI_DEFAULTS: Record<string, unknown> = {
  checkUpdate: true,
  searchEngineIndex: false,
  entryPage: "dashboard",
  nscd: true,
  dnsCache: false,
  keepDataPeriodDays: 180,
  tlsExpiryNotifyDays: [7, 14, 21],
  trustProxy: false,
};

async function fetchSettings(s: KumaSession): Promise<Record<string, unknown>> {
  const res = await s.request("getSettings");
  const data = res?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail(70, "unexpected getSettings response");
  }
  return data as Record<string, unknown>;
}

// steamAPIKey is the only secret among the general settings; it prints as
// "***" whenever it holds a value, like the monitor secret fields.
function redactSettings(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  if (out.steamAPIKey) out.steamAPIKey = "***";
  return out;
}

function checkSettingKeys(fields: Record<string, unknown>, source: string): void {
  for (const key of Object.keys(fields)) {
    if (!SETTING_KEYS.has(key)) {
      fail(2, `${source} key "${key}" is not a setting the Uptime Kuma UI edits`);
    }
  }
}

// Runs before connecting so a bad value exits 2 with nothing sent; the
// normalized result (tlsExpiryNotifyDays sorted/deduped) is written back.
function validateSettingValues(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    const check = SETTING_VALUE_CHECKS[key];
    if (check === undefined) fail(70, `no validator for setting "${key}"`);
    fields[key] = check(value, key);
  }
}

// The fetched object goes back with the UI's defaults filled in and the
// overrides merged, like the settings form does: setSettings stores only the
// keys present but the handler also reads disableAuth, entryPage,
// chromeExecutable, nscd and serverTimezone unconditionally, so a partial
// object would reset entryPage, restart Chrome, toggle nscd and could
// disconnect every other client.
function mergeSettings(
  fetched: Record<string, unknown>,
  fileConfig: Record<string, unknown>,
  sets: Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...fetched };
  for (const [key, value] of Object.entries(UI_DEFAULTS)) {
    if (base[key] === undefined) base[key] = structuredClone(value);
  }
  return { ...base, ...fileConfig, ...sets };
}

export function registerSettings(program: Command): void {
  const settings = program.command("settings").description("Manage general settings");

  settings
    .command("get")
    .description("Show the general settings")
    .action(async () => {
      const s = await connect();
      printJson(redactSettings(await fetchSettings(s)));
    });

  settings
    .command("set")
    .description("Update general settings")
    .option("--set <key=value>", "set a setting (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file of settings")
    .action(async (opts) => {
      const sets = parseSets(opts.set as string[] | undefined);
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      if (Object.keys(sets).length === 0 && Object.keys(fileConfig).length === 0) {
        fail(2, "settings set requires at least one --set key=value or --config-file");
      }
      checkSettingKeys(sets, "--set");
      checkSettingKeys(fileConfig, "--config-file");
      // --set lands in argv; the Steam key only goes through --config-file
      if (sets.steamAPIKey !== undefined) {
        fail(
          2,
          "--set steamAPIKey=... would put a secret in the command line; use --config-file instead",
        );
      }
      validateSettingValues(sets);
      validateSettingValues(fileConfig);

      // Only an entryPage override can point at a status page; the pushed
      // list is waited for just then, like the other commands that need it.
      const entryPageOverride =
        sets.entryPage !== undefined ? sets.entryPage : fileConfig.entryPage;
      const entryPageSlug =
        typeof entryPageOverride === "string" && entryPageOverride.startsWith(ENTRY_PAGE_PREFIX)
          ? entryPageOverride.slice(ENTRY_PAGE_PREFIX.length)
          : undefined;
      const s = await connect(entryPageSlug === undefined ? [] : ["statusPageList"]);
      const merged = mergeSettings(await fetchSettings(s), fileConfig, sets);

      // entryPage=statusPage-<slug> redirects / to /status/<slug>; a slug with
      // no page would 404, so it is refused before saving like `status-pages`
      // refuses an unknown slug
      if (entryPageSlug !== undefined && !s.statusPages().some((p) => p.slug === entryPageSlug)) {
        fail(1, `status page ${entryPageSlug} not found`);
      }

      // currentPassword is the login password; the server checks it only when
      // the request turns auth off while it is currently on
      await s.request("setSettings", [merged, s.loginPassword]);
      printJson(redactSettings(await fetchSettings(s)));
    });
}
