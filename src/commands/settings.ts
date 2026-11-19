import { type Command } from "commander";
import { CliError, fail, parseSets, printJson, readJsonFile } from "../lib.ts";
import { connect, type KumaSession } from "../kuma.ts";
import { KUMA_2X_TIMEZONES, KUMA_TIMEZONES } from "../timezones.ts";
import { redactUrl, urlCarriesCredentials } from "./monitors.ts";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

// addStatusPage lower-cases the slug before checkSlug, so stored slugs are
// lowercase words joined by single hyphens (same pattern as status-pages.ts).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ENTRY_PAGE_PREFIX = "statusPage-";

// Kuma stores the whole settings object before checkTimezone refuses a bad
// serverTimezone, so the CLI checks the name before connecting — against the
// union of the names either version's UI offers that Kuma also takes
// (src/timezones.ts), compared case-sensitively — and against the connected
// server's own list after connect(). Kuma itself would also take some names
// the UI does not offer (Japan, Etc/GMT+5).
const TIMEZONES_ANY = new Set([...KUMA_TIMEZONES, ...KUMA_2X_TIMEZONES]);
const TIMEZONES_1X = new Set(KUMA_TIMEZONES);
const TIMEZONES_2X = new Set(KUMA_2X_TIMEZONES);

// dnsCache is 1.x-only: 2.x dropped it from the UI and no server code reads
// it. domainExpiryNotifyDays and globalpingApiToken are 2.x-only: 1.23's
// settings components do not write them.
const KUMA_1X_ONLY_SETTING_KEYS = new Set(["dnsCache"]);
const KUMA_2X_ONLY_SETTING_KEYS = new Set(["domainExpiryNotifyDays", "globalpingApiToken"]);

// get prints a stored secret as "***"; feeding that output back through
// --config-file would store the placeholder itself
function secretString(value: unknown, key: string): unknown {
  if (typeof value !== "string") fail(2, `"${key}" must be a string`);
  if (value === "***") {
    fail(
      2,
      `"${key}" is the redacted placeholder from settings get output; omit the key to keep the stored value`,
    );
  }
  return value;
}

// Notifications.vue accepts only positive integers and keeps the list sorted
// and duplicate-free
function expiryNotifyDays(value: unknown, key: string): unknown {
  if (
    !Array.isArray(value) ||
    value.some((d) => typeof d !== "number" || !Number.isInteger(d) || d <= 0)
  ) {
    fail(2, `"${key}" must be an array of positive integers`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

// The keys the settings components write through the shared `settings` object
// that saveSettings posts whole to setSettings. 1.23.17: General.vue
// (serverTimezone, searchEngineIndex, entryPage, primaryBaseURL, steamAPIKey,
// nscd, dnsCache, chromeExecutable), About.vue (checkUpdate, checkBeta),
// ReverseProxy.vue (trustProxy), MonitorHistory.vue (keepDataPeriodDays),
// Notifications.vue (tlsExpiryNotifyDays) and Security.vue (disableAuth).
// 2.x drops dnsCache and adds domainExpiryNotifyDays (Notifications.vue) and
// globalpingApiToken (General.vue). cloudflaredTunnelToken is not one: it
// goes through the cloudflared_* events.
const SETTING_VALUE_CHECKS: Record<string, (value: unknown, key: string) => unknown> = {
  serverTimezone: (value, key) => {
    if (typeof value !== "string" || !TIMEZONES_ANY.has(value)) {
      fail(
        2,
        `"${key}" must be a timezone name the Uptime Kuma UI offers and Kuma accepts (case-sensitive)`,
      );
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
      // get masks the whole userinfo as ***; feeding that output
      // back would store the mask
      if (url.username === "***" || url.password === "***") {
        fail(
          2,
          `"${key}" carries the masked credentials from settings get output; give the real URL through --config-file or omit the key`,
        );
      }
    }
    return value;
  },
  steamAPIKey: secretString,
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
  // sorted and duplicate-free; the 2.x domainExpiryNotifyDays input has the
  // same rules
  tlsExpiryNotifyDays: expiryNotifyDays,
  domainExpiryNotifyDays: expiryNotifyDays,
  // the second masked secret; same "***" placeholder refusal as steamAPIKey
  globalpingApiToken: secretString,
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
// dnsCache is 1.x-only and domainExpiryNotifyDays is 2.x-only, so each major
// version gets its own set.
const UI_DEFAULTS_COMMON: Record<string, unknown> = {
  checkUpdate: true,
  searchEngineIndex: false,
  entryPage: "dashboard",
  nscd: true,
  keepDataPeriodDays: 180,
  tlsExpiryNotifyDays: [7, 14, 21],
  trustProxy: false,
};
const UI_DEFAULTS_1X: Record<string, unknown> = { ...UI_DEFAULTS_COMMON, dnsCache: false };
const UI_DEFAULTS_2X: Record<string, unknown> = {
  ...UI_DEFAULTS_COMMON,
  domainExpiryNotifyDays: [7, 14, 21],
};

async function fetchSettings(s: KumaSession): Promise<Record<string, unknown>> {
  const res = await s.request("getSettings");
  const data = res?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail(70, "unexpected getSettings response");
  }
  return data as Record<string, unknown>;
}

// The general settings hold three secrets: steamAPIKey and globalpingApiToken
// print as "***" whenever they hold a value, and a password inside
// primaryBaseURL is masked like a monitor url.
function redactSettings(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...data,
    primaryBaseURL: redactUrl(data.primaryBaseURL),
  };
  if (out.steamAPIKey) out.steamAPIKey = "***";
  if (out.globalpingApiToken) out.globalpingApiToken = "***";
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
// normalized result (the notify-day lists sorted/deduped) is written back.
function validateSettingValues(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    // checkSettingKeys ran on this object first, so the lookup cannot miss
    fields[key] = SETTING_VALUE_CHECKS[key]!(value, key);
  }
}

// Which keys a version edits can only be refused once the version is known:
// 1.23's setSettings would store dnsCache as a dead key and the two 2.x keys
// as unknown ones, and 2.x stores dnsCache the same dead way. Like the
// monitor fields, the refusal exits 2 before anything is sent.
function checkSettingVersionKeys(s: KumaSession, fields: Record<string, unknown>): void {
  if (s.majorVersion >= 2) {
    for (const key of Object.keys(fields)) {
      if (KUMA_1X_ONLY_SETTING_KEYS.has(key)) {
        fail(2, `"${key}" is not read on Uptime Kuma 2.x; the server reports ${s.serverVersion}`);
      }
    }
    return;
  }
  for (const key of Object.keys(fields)) {
    if (KUMA_2X_ONLY_SETTING_KEYS.has(key)) {
      fail(
        2,
        s.serverVersion === undefined
          ? `"${key}" needs Uptime Kuma 2.x; the server sent no version, so 1.x was assumed`
          : `"${key}" needs Uptime Kuma 2.x; the server reports ${s.serverVersion}`,
      );
    }
  }
}

// The pre-connect check only knows the union of both versions' lists; the
// connected server's own list decides, like the version key check above.
function checkServerTimezone(s: KumaSession, value: unknown): void {
  const accepted = s.majorVersion >= 2 ? TIMEZONES_2X : TIMEZONES_1X;
  if (typeof value !== "string" || !accepted.has(value)) {
    fail(
      2,
      `"serverTimezone" must be a timezone name the Uptime Kuma ${s.serverVersion ?? "1.x"} UI offers and Kuma accepts (case-sensitive)`,
    );
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
  s: KumaSession,
): Record<string, unknown> {
  const base = { ...fetched };
  const defaults = s.majorVersion >= 2 ? UI_DEFAULTS_2X : UI_DEFAULTS_1X;
  for (const [key, value] of Object.entries(defaults)) {
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
      // --set lands in argv; the secret keys only go through --config-file
      for (const key of ["steamAPIKey", "globalpingApiToken"] as const) {
        if (sets[key] !== undefined) {
          fail(
            2,
            `--set ${key}=... would put a secret in the command line; use --config-file instead`,
          );
        }
      }
      validateSettingValues(sets);
      validateSettingValues(fileConfig);
      // any userinfo inside primaryBaseURL is a secret too: argv is no
      // place for it — the username slot can hold a token on its own
      if (typeof sets.primaryBaseURL === "string" && sets.primaryBaseURL !== "") {
        if (urlCarriesCredentials(sets.primaryBaseURL)) {
          fail(
            2,
            "--set primaryBaseURL with credentials would put a secret in the command line; use --config-file instead",
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
      // the version decides which keys are editable and which timezone list
      // applies; both refusals exit 2 before the settings are even read
      checkSettingVersionKeys(s, { ...fileConfig, ...sets });
      const timezoneOverride =
        sets.serverTimezone !== undefined ? sets.serverTimezone : fileConfig.serverTimezone;
      if (timezoneOverride !== undefined) checkServerTimezone(s, timezoneOverride);
      const merged = mergeSettings(await fetchSettings(s), fileConfig, sets, s);

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
