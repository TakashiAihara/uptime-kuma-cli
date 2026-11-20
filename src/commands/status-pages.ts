import { Option, type Command } from "commander";
import {
  CliError,
  fail,
  printJson,
  readJsonFile,
  redactUrl as redactMonitorUrl,
  socketTimeoutMs,
} from "../lib.ts";
import { connect, type KumaSession, type StatusPageRow } from "../kuma.ts";

// The six styles the StatusPage.vue incident picker offers; createIncident
// starts a new incident at "primary".
const INCIDENT_STYLES = ["info", "warning", "danger", "primary", "light", "dark"] as const;

// addStatusPage of Kuma 1.23.17 trims title and slug, lower-cases the slug
// and runs checkSlug; after the lower-casing the accepted set is lowercase
// words joined by single hyphens.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The theme select of StatusPage.vue offers auto/light/dark.
const SAVE_THEMES = ["auto", "light", "dark"] as const;

// saveStatusPage overwrites every config column it reads, so the CLI merges
// the file over the fetched toJSON like the UI does. The file may only carry
// the writable keys — id, icon and published are refused (the icon changes
// through "logo", published is not touched by the handler at all). The set
// is the union of both versions: googleAnalyticsId is 1.x-only and the six
// refresh/analytics keys are 2.x-only; the version-specific half is refused
// after connect() like the 2.x monitor fields.
const SAVE_FILE_KEYS = new Set([
  "slug",
  "title",
  "description",
  "theme",
  "showTags",
  "footerText",
  "customCSS",
  "showPoweredBy",
  "showCertificateExpiry",
  "googleAnalyticsId",
  "autoRefreshInterval",
  "rssTitle",
  "showOnlyLastHeartbeat",
  "analyticsId",
  "analyticsScriptUrl",
  "analyticsType",
  "domainNameList",
  "logo",
  "publicGroupList",
]);

// The config keys only 2.5.11's saveStatusPage reads; a 1.x server never
// stores them, so they exit 2 once the version is known.
const SAVE_2X_KEYS = [
  "autoRefreshInterval",
  "rssTitle",
  "showOnlyLastHeartbeat",
  "analyticsId",
  "analyticsScriptUrl",
  "analyticsType",
] as const;

// 2.5.11 validates analyticsType against this enum; null means no analytics.
const ANALYTICS_TYPES = ["google", "umami", "plausible", "matomo", "rybbit"] as const;

const PNG_DATA_URL = "data:image/png;base64,";

// The reduced shapes saveStatusPage reads: groups keep only id/name and
// monitors id/sendUrl, plus url on the auto-fetched 2.x path when the public
// url is a custom one (toSaveGroup). A file's publicGroupList cannot express
// custom URLs — its monitor url is ignored like every other extra key a
// `get` output carries (weight, type, url, tags, ...).
type SaveMonitor = { id: number; sendUrl?: boolean | 0 | 1; url?: string };
type SaveGroup = { id?: number; name: string; monitorList: SaveMonitor[] };
type SaveFile = {
  overrides: Record<string, unknown>;
  logo: string | undefined;
  groups: SaveGroup[] | undefined;
};

const isPosInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const byTitle = (a: StatusPageRow, b: StatusPageRow): number =>
  a.title < b.title ? -1 : a.title > b.title ? 1 : 0;

function statusPageBySlug(s: KumaSession, slug: string): StatusPageRow | undefined {
  return s.statusPages().find((p) => p.slug === slug);
}

function parseAddSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    fail(2, `--slug must match ^[a-z0-9]+(?:-[a-z0-9]+)*$, got "${value}"`);
  }
  return slug;
}

async function fetchStatusPageConfig(
  s: KumaSession,
  slug: string,
): Promise<Record<string, unknown>> {
  const res = await s.request("getStatusPage", [slug]);
  const config = res?.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail(70, "unexpected getStatusPage response");
  }
  return config as Record<string, unknown>;
}

// The configured url can carry userinfo; messages name the URL without it
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

// 2.x's public route returns every pinned and active incident as `incidents`,
// ordered created_date DESC; `incident` reports the newest pinned one so
// output written for 1.23's single `incident` keeps working. The pick does
// not lean on that order: a dated incident only loses to a later one when
// its createdDate proves it older, an undated one never beats a dated one,
// a tied createdDate goes to the higher id (the route does not order ties),
// and missing dates fall back to position — the last element wins.
function newestIncident(incidents: Record<string, unknown>[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  for (const inc of incidents) {
    if (inc.pin === false) continue;
    if (best === null) {
      best = inc;
      continue;
    }
    const bd = best.createdDate;
    const cd = inc.createdDate;
    if (typeof bd === "string" && typeof cd === "string" && bd === cd) {
      // uncomparable ids make the comparison false, keeping the positional pick
      if (Number(inc.id) < Number(best.id)) continue;
      best = inc;
      continue;
    }
    if (typeof bd === "string" && (typeof cd !== "string" || cd < bd)) continue;
    best = inc;
  }
  return best;
}

// GET /api/status-page/:slug is the unauthenticated public route; on 1.x it
// answers { config, incident, publicGroupList, maintenanceList } and on 2.x
// { config, incidents, publicGroupList, maintenanceList }. The CLI merges
// the socket config with the public groups and prints `incidents` next to
// `incident` on both versions. Kuma caches the route for 5 minutes keyed on
// the full URL including the query string; which events clear it differs
// (1.x: saveStatusPage and deleteMonitor; 2.x adds deleteStatusPage) but
// addStatusPage, postIncident and unpinIncident clear it on neither — the
// unique query makes every read a cache miss.
async function fetchPublicStatusPage(
  s: KumaSession,
  slug: string,
  opts: { redactUrls?: boolean } = {},
): Promise<{ publicGroupList: unknown[]; incident: unknown; incidents: unknown[] }> {
  // slug is one from statusPageList, so Kuma's checkSlug charset needs no encoding
  const cacheBust = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const url = `${s.url}/api/status-page/${slug}?_=${cacheBust}`;
  const shown = redactUrl(url);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(socketTimeoutMs()) });
  } catch (e) {
    // a network error or timeout, not a Kuma answer: exit 2 like the socket's
    fail(2, `GET ${shown} failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { msg?: unknown } | null;
      if (typeof body?.msg === "string" && body.msg !== "") detail = `: ${body.msg}`;
    } catch {
      // the error body is not JSON
    }
    fail(1, `GET ${shown} failed with HTTP ${res.status}${detail}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    fail(1, `GET ${shown} did not return JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail(70, "unexpected /api/status-page response");
  }
  const body = data as Record<string, unknown>;
  if (!Array.isArray(body.publicGroupList)) {
    fail(70, "unexpected /api/status-page response");
  }
  let incident: unknown;
  let incidents: unknown[];
  if (s.majorVersion >= 2) {
    const raw = body.incidents;
    if (!Array.isArray(raw)) fail(70, "unexpected /api/status-page response");
    for (const i of raw) {
      if (i === null || typeof i !== "object" || Array.isArray(i)) {
        fail(70, "unexpected /api/status-page response");
      }
    }
    incidents = raw;
    incident = newestIncident(raw as Record<string, unknown>[]);
  } else {
    // the 1.x route always emits `incident` — null or the pinned one — so a
    // missing key means the body is not the status-page payload
    if (!("incident" in body)) fail(70, "unexpected /api/status-page response");
    incident = body.incident;
    if (incident !== null && (typeof incident !== "object" || Array.isArray(incident))) {
      fail(70, "unexpected /api/status-page response");
    }
    incidents = incident === null ? [] : [incident];
  }
  // redactUrls is for internal callers that compare or echo the urls back to
  // Kuma (status-pages save); anything printed keeps the redacted form
  return {
    publicGroupList:
      opts.redactUrls === false ? body.publicGroupList : redactGroupUrls(body.publicGroupList),
    incident,
    incidents,
  };
}

// Monitor.toPublicJSON adds the monitor url when sendUrl is on; a password in
// it prints as *** like `monitors get`
function redactGroupUrls(groups: unknown[]): unknown[] {
  return groups.map((g) => {
    const group = g as Record<string, unknown> | null;
    if (group === null || typeof group !== "object" || !Array.isArray(group.monitorList)) return g;
    return {
      ...group,
      monitorList: group.monitorList.map((m) => {
        const mon = m as Record<string, unknown> | null;
        if (mon === null || typeof mon !== "object" || mon.url === undefined) return m;
        return { ...mon, url: redactMonitorUrl(mon.url) };
      }),
    };
  });
}

function parseSaveMonitor(raw: unknown, at: string): SaveMonitor {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(2, `${at} must be an object`);
  }
  const m = raw as Record<string, unknown>;
  if (!isPosInt(m.id)) fail(2, `${at}.id must be a positive integer`);
  const monitor: SaveMonitor = { id: m.id };
  if (m.sendUrl !== undefined) {
    const v = m.sendUrl;
    // monitor_group.send_url is a SQLite BOOLEAN: the public JSON carries 0/1,
    // so both spellings round-trip through a `get` output
    if (typeof v !== "boolean" && v !== 0 && v !== 1) {
      fail(2, `${at}.sendUrl must be a boolean`);
    }
    monitor.sendUrl = v as boolean | 0 | 1;
  }
  return monitor;
}

function parseSaveGroup(raw: unknown, index: number): SaveGroup {
  const at = `publicGroupList[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(2, `${at} must be an object`);
  }
  const g = raw as Record<string, unknown>;
  if (typeof g.name !== "string" || g.name === "") {
    fail(2, `${at}.name must be a non-empty string`);
  }
  if (!Array.isArray(g.monitorList)) fail(2, `${at}.monitorList must be an array`);
  const group: SaveGroup = { name: g.name, monitorList: [] };
  if (g.id !== undefined) {
    if (!isPosInt(g.id)) fail(2, `${at}.id must be a positive integer`);
    group.id = g.id;
  }
  group.monitorList = g.monitorList.map((m, j) => parseSaveMonitor(m, `${at}.monitorList[${j}]`));
  return group;
}

// Validates the --config-file object before connecting; returns the config
// overrides, the logo and the reduced group list.
function parseSaveFile(file: Record<string, unknown>): SaveFile {
  for (const key of Object.keys(file)) {
    if (!SAVE_FILE_KEYS.has(key)) fail(2, `unknown status page field "${key}"`);
  }
  const overrides: Record<string, unknown> = {};
  if (file.slug !== undefined) {
    if (typeof file.slug !== "string") fail(2, '"slug" must be a string');
    // StatusPage.vue save() sends config.slug.trim().toLowerCase() and
    // addStatusPage lower-cases too, so stored slugs are always lowercase;
    // checkSlug's A-Z acceptance is covered by lower-casing first
    const slug = file.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      fail(2, `"slug" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$, got "${file.slug}"`);
    }
    overrides.slug = slug;
  }
  if (file.title !== undefined) {
    // same rule as add: non-empty after trim; the value itself is kept as given
    if (typeof file.title !== "string" || file.title.trim() === "") {
      fail(2, '"title" must be a non-empty string');
    }
    overrides.title = file.title;
  }
  for (const key of [
    "description",
    "footerText",
    "customCSS",
    "googleAnalyticsId",
    "rssTitle",
    "analyticsId",
    "analyticsScriptUrl",
  ] as const) {
    const v = file[key];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") fail(2, `"${key}" must be a string or null`);
    overrides[key] = v;
  }
  if (file.theme !== undefined) {
    if (
      typeof file.theme !== "string" ||
      !(SAVE_THEMES as readonly string[]).includes(file.theme)
    ) {
      fail(2, `"theme" must be one of ${SAVE_THEMES.join(", ")}`);
    }
    overrides.theme = file.theme;
  }
  for (const key of [
    "showTags",
    "showPoweredBy",
    "showCertificateExpiry",
    "showOnlyLastHeartbeat",
  ] as const) {
    const v = file[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") fail(2, `"${key}" must be a boolean`);
    overrides[key] = v;
  }
  if (file.autoRefreshInterval !== undefined) {
    const v = file.autoRefreshInterval;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      fail(2, '"autoRefreshInterval" must be a non-negative integer');
    }
    overrides.autoRefreshInterval = v;
  }
  if (file.analyticsType !== undefined) {
    const v = file.analyticsType;
    const ok =
      v === null || (typeof v === "string" && (ANALYTICS_TYPES as readonly string[]).includes(v));
    if (!ok) {
      fail(2, `"analyticsType" must be one of ${ANALYTICS_TYPES.join(", ")} or null`);
    }
    overrides.analyticsType = v;
  }
  if (file.domainNameList !== undefined) {
    if (
      !Array.isArray(file.domainNameList) ||
      file.domainNameList.some((d) => typeof d !== "string")
    ) {
      fail(2, '"domainNameList" must be an array of strings');
    }
    overrides.domainNameList = file.domainNameList;
  }
  let logo: string | undefined;
  if (file.logo !== undefined) {
    if (typeof file.logo !== "string") fail(2, '"logo" must be a string');
    // saveStatusPage stores a non-data value as the icon URL verbatim; a data:
    // URL must be PNG ("Only allowed PNG logo.")
    if (file.logo.startsWith("data:") && !file.logo.startsWith(PNG_DATA_URL)) {
      fail(2, '"logo" data URLs must be PNG ("data:image/png;base64,")');
    }
    logo = file.logo;
  }
  let groups: SaveGroup[] | undefined;
  if (file.publicGroupList !== undefined) {
    if (!Array.isArray(file.publicGroupList)) fail(2, '"publicGroupList" must be an array');
    groups = file.publicGroupList.map(parseSaveGroup);
  }
  return { overrides, logo, groups };
}

// The public route's groups are Group.toPublicJSON rows; only id, name and
// the monitor id/sendUrl pairs survive the reduction saveStatusPage reads.
// On 2.x the public monitor url is customUrl ?? the monitor's own url, and
// saveStatusPage rewrites monitor_group on every save: a url that differs
// from the monitor's own is a stored custom_url and goes back or the save
// clears it, while an equal one is not sent — storing it would pin the
// monitor url as a custom url. A sendUrl-off monitor has no public url, so
// a custom_url on it cannot be detected and is cleared; the UI cannot
// preserve it either.
function toSaveGroup(raw: unknown, s: KumaSession): SaveGroup {
  const g = raw as Record<string, unknown> | null;
  if (g === null || typeof g !== "object" || !Array.isArray(g.monitorList)) {
    fail(70, "unexpected /api/status-page response");
  }
  if (typeof g.name !== "string") fail(70, "unexpected /api/status-page response");
  const group: SaveGroup = { name: g.name, monitorList: [] };
  if (g.id !== undefined) {
    const id = Number(g.id);
    if (!Number.isInteger(id)) fail(70, "unexpected /api/status-page response");
    group.id = id;
  }
  group.monitorList = (g.monitorList as unknown[]).map((m) => {
    const mon = m as Record<string, unknown> | null;
    const id = Number(mon?.id);
    if (!Number.isInteger(id)) fail(70, "unexpected /api/status-page response");
    const out: SaveMonitor = { id };
    if (mon?.sendUrl !== undefined) {
      out.sendUrl = mon.sendUrl as boolean | 0 | 1;
    }
    const url = mon?.url;
    if (s.majorVersion >= 2 && typeof url === "string" && url !== s.monitorById(id)?.url) {
      out.url = url;
    }
    return out;
  });
  return group;
}

// The version-specific save keys can only be refused once the version is
// known: 1.23's saveStatusPage never reads the six 2.x keys, and 2.x no
// longer reads googleAnalyticsId. Like the monitor fields, the refusal
// exits 2 before anything is sent.
function checkSaveVersionKeys(s: KumaSession, overrides: Record<string, unknown>): void {
  if (s.majorVersion >= 2) {
    if (overrides.googleAnalyticsId !== undefined) {
      fail(
        2,
        `"googleAnalyticsId" is not read on Uptime Kuma 2.x; the server reports ${s.serverVersion} — set "analyticsId" / "analyticsType" instead`,
      );
    }
    return;
  }
  for (const key of SAVE_2X_KEYS) {
    if (overrides[key] !== undefined) {
      fail(
        2,
        s.serverVersion === undefined
          ? `"${key}" needs Uptime Kuma 2.x; the server sent no version, so 1.x was assumed`
          : `"${key}" needs Uptime Kuma 2.x; the server reports ${s.serverVersion}`,
      );
    }
  }
}

export function registerStatusPages(program: Command): void {
  const statusPages = program.command("status-pages").description("Manage status pages");

  statusPages
    .command("list")
    .description("List status pages")
    .action(async () => {
      const s = await connect(["statusPageList"]);
      // sendStatusPageList orders by title; the pushed object's numeric keys
      // would enumerate by id, so the title order is restored here
      printJson(s.statusPages().sort(byTitle));
    });

  statusPages
    .command("get <slug>")
    .description("Show one status page with its public groups and pinned incident")
    .action(async (slug) => {
      const s = await connect(["statusPageList"]);
      // getStatusPage of an unknown slug answers "No slug?"; the pushed list
      // gives the CLI's own not-found first
      if (!statusPageBySlug(s, slug)) fail(1, `status page ${slug} not found`);
      const config = await fetchStatusPageConfig(s, slug);
      const { publicGroupList, incident, incidents } = await fetchPublicStatusPage(s, slug);
      printJson({ ...config, publicGroupList, incident, incidents });
    });

  statusPages
    .command("add")
    .description("Add a status page")
    .requiredOption("--slug <slug>", "status page slug")
    .requiredOption("--title <title>", "status page title")
    .action(async (opts) => {
      const slug = parseAddSlug(opts.slug as string);
      const title = (opts.title as string).trim();
      if (title === "") fail(2, "--title must not be empty");
      const s = await connect(["statusPageList"]);
      const existing = statusPageBySlug(s, slug);
      if (existing) {
        printJson({ id: existing.id, slug, title: existing.title, skipped: true });
        fail(3, "");
      }
      await s.request("addStatusPage", [title, slug]);
      // addStatusPage answers only { ok, msg } and does not re-push
      // statusPageList, so the new page's toJSON comes from getStatusPage
      printJson(await fetchStatusPageConfig(s, slug));
    });

  statusPages
    .command("save <slug>")
    .description("Update a status page from a JSON file")
    .requiredOption("--config-file <path>", "JSON file of status page fields")
    .action(async (slug, opts) => {
      const file = parseSaveFile(readJsonFile(opts.configFile, "--config-file"));
      const s = await connect(["statusPageList"]);
      checkSaveVersionKeys(s, file.overrides);
      const page = statusPageBySlug(s, slug);
      if (page === undefined) fail(1, `status page ${slug} not found`);
      const fetchedConfig = await fetchStatusPageConfig(s, slug);
      // this read feeds the save payload only, never stdout: it stays
      // unredacted so toSaveGroup can tell a custom_url from the monitor's
      // own url and send it back on 2.x
      const { publicGroupList: fetchedGroups } = await fetchPublicStatusPage(s, slug, {
        redactUrls: false,
      });
      // saveStatusPage overwrites every column it reads, so the fetched
      // toJSON goes back with the file merged over it — like the UI, which
      // edits the fetched config and posts it whole
      const merged: Record<string, unknown> = { ...fetchedConfig, ...file.overrides };
      if (typeof merged.slug !== "string") fail(70, "unexpected getStatusPage response");
      const newSlug = merged.slug;
      // a slug rename onto another page is refused before saving, with exit 3
      // like `add` refuses a duplicate slug
      const conflict = s.statusPages().find((p) => p.id !== page.id && p.slug === newSlug);
      if (conflict !== undefined) {
        printJson({
          id: conflict.id,
          slug: conflict.slug,
          title: conflict.title,
          skipped: true,
        });
        fail(3, "");
      }
      const groups = file.groups ?? fetchedGroups.map((g) => toSaveGroup(g, s));
      const fetchedGroupIds = new Set(
        fetchedGroups.map((g) => Number((g as { id?: unknown })?.id)),
      );
      for (const g of groups) {
        // an id that is not a public group of this page makes R.findOne return
        // null and the handler throws after the page row was already stored
        if (g.id !== undefined && !fetchedGroupIds.has(g.id)) {
          fail(1, `status page group ${g.id} not found`);
        }
        for (const m of g.monitorList) {
          if (s.monitorById(m.id) === undefined) fail(1, `monitor ${m.id} not found`);
        }
      }
      const icon = fetchedConfig.icon;
      if (typeof icon !== "string") fail(70, "unexpected getStatusPage response");
      // the UI sends the fetched icon as imgDataUrl; a file "logo" replaces it
      const res = await s.request("saveStatusPage", [slug, merged, file.logo ?? icon, groups]);
      const savedGroups = res?.publicGroupList;
      if (!Array.isArray(savedGroups)) fail(70, "unexpected saveStatusPage response");
      // printed like `get`, under the new slug when it changed. The save
      // already happened, so a failed read-back degrades to the sent config
      // and the response's groups (which carry the new ids) plus a warning
      // on stderr, rather than a nonzero exit
      try {
        const config = await fetchStatusPageConfig(s, newSlug);
        const { publicGroupList, incident, incidents } = await fetchPublicStatusPage(s, newSlug);
        printJson({ ...config, publicGroupList, incident, incidents });
      } catch (e) {
        // exit 70 is an unexpected response shape, not a failed read: keep it loud
        if (!(e instanceof CliError) || e.exitCode === 70) throw e;
        printJson({
          ...merged,
          publicGroupList: redactGroupUrls(savedGroups),
          incident: null,
          incidents: [],
        });
        console.error(
          `warning: status page ${newSlug} was saved, but reading it back failed: ${e.message}`,
        );
      }
    });

  statusPages
    .command("delete <slug>")
    .description("Delete a status page")
    .option("--yes", "confirm deletion")
    .action(async (slug, opts) => {
      if (!opts.yes) fail(2, `would delete status page ${slug}; pass --yes to delete`);
      const s = await connect(["statusPageList"]);
      // deleteStatusPage answers ok:false "Status Page is not found" for an
      // unknown slug; the pushed list gives the CLI's own message first
      if (!statusPageBySlug(s, slug)) fail(1, `status page ${slug} not found`);
      await s.request("deleteStatusPage", [slug]);
      printJson({ slug, deleted: true });
    });

  statusPages
    .command("incident <slug>")
    .description("Post an incident to a status page (unpins the pinned one first)")
    .requiredOption("--title <title>", "incident title")
    .requiredOption("--content <content>", "incident content")
    .addOption(
      new Option("--style <style>", "incident style")
        .choices([...INCIDENT_STYLES])
        .default("primary"),
    )
    .action(async (slug, opts) => {
      const title = opts.title as string;
      const content = opts.content as string;
      if (title === "") fail(2, "--title must not be empty");
      if (content === "") fail(2, "--content must not be empty");
      const s = await connect(["statusPageList"]);
      // postIncident of an unknown slug answers "slug is not found"; the
      // pushed list gives the CLI's own not-found first
      if (!statusPageBySlug(s, slug)) fail(1, `status page ${slug} not found`);
      // 1.x's postIncident unpins the page's incidents itself; 2.x's does not,
      // so the one-pinned behaviour needs the explicit unpinIncident first
      const unpinned = s.majorVersion >= 2;
      if (unpinned) await s.request("unpinIncident", [slug]);
      let incident: unknown;
      try {
        const res = await s.request("postIncident", [
          slug,
          { title, content, style: opts.style as string },
        ]);
        incident = res?.incident;
      } catch (e) {
        // the unpin already ran, so a failed post can leave the page with
        // nothing pinned — Kuma's own message does not say that
        if (unpinned && e instanceof CliError) {
          fail(
            e.exitCode,
            `${e.message} — the page's incidents were unpinned first; re-run to post a new one`,
          );
        }
        throw e;
      }
      if (incident === null || typeof incident !== "object" || Array.isArray(incident)) {
        fail(70, "unexpected postIncident response");
      }
      printJson(incident);
    });

  statusPages
    .command("unpin <slug>")
    .description("Unpin the incidents shown on a status page")
    .action(async (slug) => {
      const s = await connect(["statusPageList"]);
      // unpinIncident runs the UPDATE with a NULL page id for an unknown slug
      // and still answers ok, so the pushed list is the only check
      if (!statusPageBySlug(s, slug)) fail(1, `status page ${slug} not found`);
      await s.request("unpinIncident", [slug]);
      printJson({ slug, unpinned: true });
    });
}
