import { type Command } from "commander";
import { CliError, fail, parseSets, printJson, readJsonFile } from "../lib.ts";
import { connect, type KumaSession } from "../kuma.ts";
import { redactUrl } from "./monitors.ts";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

// addStatusPage lower-cases the slug before checkSlug, so stored slugs are
// lowercase words joined by single hyphens (same pattern as status-pages.ts).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ENTRY_PAGE_PREFIX = "statusPage-";

// General.vue offers "UTC" plus the tzCode names of the timezones-list
// package (3.0.3 in Kuma 1.23.17). The CLI accepts the canonical names of
// Bun's ICU (Intl.supportedValuesOf) plus the legacy names that list still
// offers and ICU dropped, compared case-sensitively: aliases like "Japan",
// lowercase names and offsets like "+09:00" are refused (Kuma stores
// "+09:00" and then answers "Invalid timezone"). The ICU set also accepts
// some names the UI lacks (Etc/GMT±N, America/Nuuk), which Kuma runs fine.
const UI_LEGACY_TIMEZONES = [
  "America/Yellowknife",
  "America/Rainy_River",
  "America/Nipigon",
  "America/Pangnirtung",
  "America/Thunder_Bay",
  "America/Godthab",
  "Europe/Uzhgorod",
  "Europe/Zaporizhzhia",
  "Asia/Choibalsan",
  "Australia/Currie",
  "Pacific/Enderbury",
];
const TIMEZONES = new Set(["UTC", ...UI_LEGACY_TIMEZONES, ...Intl.supportedValuesOf("timeZone")]);

// The keys the 1.23.17 settings components write through the shared `settings`
// object that saveSettings posts whole to setSettings: General.vue
// (serverTimezone, searchEngineIndex, entryPage, primaryBaseURL, steamAPIKey,
// nscd, dnsCache, chromeExecutable), About.vue (checkUpdate, checkBeta),
// ReverseProxy.vue (trustProxy), MonitorHistory.vue (keepDataPeriodDays),
// Notifications.vue (tlsExpiryNotifyDays) and Security.vue (disableAuth).
// cloudflaredTunnelToken is not one: it goes through the cloudflared_* events.
const SETTING_VALUE_CHECKS: Record<string, (value: unknown, key: string) => unknown> = {
  serverTimezone: (value, key) => {
    if (typeof value !== "string" || !TIMEZONES.has(value)) {
      fail(2, `"${key}" must be "UTC" or a canonical IANA timezone name (case-sensitive)`);
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
  // the input's pattern is https?://.+ and it is not required, so "" is
  // valid; a query or fragment would break the /api/push/<token> URL that
  // monitors add --type push builds on it
  primaryBaseURL: (value, key) => {
    if (typeof value !== "string") fail(2, `"${key}" must be a string`);
    if (value !== "") {
      let url: URL | null = null;
      try {
        url = new URL(value);
      } catch {
        // not a URL at all
      }
      if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
        fail(2, `"${key}" must be a URL starting with http:// or https://, or empty`);
      }
      // URL.search / URL.hash are "" for a bare trailing ? or #, so the
      // separators themselves are looked for
      if (value.includes("?") || value.includes("#")) {
        fail(2, `"${key}" must not contain a query string or fragment`);
      }
      // get masks the password as ***; feeding that output back would store it
      if (url.password === "***") {
        fail(
          2,
          `"${key}" carries the masked password from settings get output; give the real URL or omit the key`,
        );
      }
    }
    return value;
  },
  steamAPIKey: (value, key) => {
    if (typeof value !== "string") fail(2, `"${key}" must be a string`);
    // get prints a stored key as "***"; feeding that output back through
    // --config-file would store the placeholder itself
    if (value === "***") {
      fail(
        2,
        `"${key}" is the redacted placeholder from settings get output; omit the key to keep the stored value`,
      );
    }
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

// The general settings hold two secrets: steamAPIKey prints as "***"
// whenever it holds a value, and a password inside primaryBaseURL is masked
// like a monitor url.
function redactSettings(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...data,
    primaryBaseURL: redactUrl(data.primaryBaseURL),
  };
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
    // checkSettingKeys ran on this object first, so the lookup cannot miss
    fields[key] = SETTING_VALUE_CHECKS[key]!(value, key);
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
      // a password inside primaryBaseURL is a secret too: argv is no place for it
      if (typeof sets.primaryBaseURL === "string" && sets.primaryBaseURL !== "") {
        if (new URL(sets.primaryBaseURL).password !== "") {
          fail(
            2,
            "--set primaryBaseURL with a password would put a secret in the command line; use --config-file instead",
          );
        }
      }

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
      // the save already happened, so a failed re-read degrades to the sent
      // object plus a warning on stderr rather than a nonzero exit; exit 70
      // is an unexpected response shape, not a failed read, and stays loud —
      // same contract as `status-pages save`
      try {
        printJson(redactSettings(await fetchSettings(s)));
      } catch (e) {
        if (!(e instanceof CliError) || e.exitCode === 70) throw e;
        printJson(redactSettings(merged));
        console.error(`warning: settings were saved, but reading them back failed: ${e.message}`);
      }
    });
}
