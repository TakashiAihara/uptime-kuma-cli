import { Option, type Command } from "commander";
import { fail, printJson, readJsonFile, socketTimeoutMs } from "../lib.ts";
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
// through "logo", published is not touched by the handler at all).
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
  "domainNameList",
  "logo",
  "publicGroupList",
]);

const PNG_DATA_URL = "data:image/png;base64,";

// The reduced shapes saveStatusPage reads: groups keep only id/name and
// monitors only id/sendUrl; extra keys a `get` output carries (weight, type,
// url, tags, ...) are allowed in the file and ignored.
type SaveMonitor = { id: number; sendUrl?: boolean | 0 | 1 };
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
  if (slug === "") fail(2, "--slug must not be empty");
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

// GET /api/status-page/:slug is the unauthenticated public route; it answers
// { config, incident, publicGroupList, maintenanceList } and the CLI merges
// the socket config with the public groups and the pinned incident. Kuma
// caches the route for 5 minutes (apicache), so a just-posted incident can
// be missing from the answer.
async function fetchPublicStatusPage(
  s: KumaSession,
  slug: string,
): Promise<{ publicGroupList: unknown[]; incident: unknown }> {
  // slug is one from statusPageList, so Kuma's checkSlug charset needs no encoding
  const url = `${s.url}/api/status-page/${slug}`;
  const shown = redactUrl(url);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(socketTimeoutMs()) });
  } catch (e) {
    fail(1, `GET ${shown} failed: ${(e as Error).message}`);
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
  const incident = body.incident ?? null;
  if (incident !== null && (typeof incident !== "object" || Array.isArray(incident))) {
    fail(70, "unexpected /api/status-page response");
  }
  return { publicGroupList: body.publicGroupList as unknown[], incident };
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
    if (slug === "") fail(2, '"slug" must not be empty');
    if (!SLUG_PATTERN.test(slug)) {
      fail(2, `"slug" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$, got "${file.slug}"`);
    }
    overrides.slug = slug;
  }
  if (file.title !== undefined) {
    if (typeof file.title !== "string" || file.title === "") {
      fail(2, '"title" must be a non-empty string');
    }
    overrides.title = file.title;
  }
  for (const key of ["description", "footerText", "customCSS", "googleAnalyticsId"] as const) {
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
  for (const key of ["showTags", "showPoweredBy", "showCertificateExpiry"] as const) {
    const v = file[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") fail(2, `"${key}" must be a boolean`);
    overrides[key] = v;
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
function toSaveGroup(raw: unknown): SaveGroup {
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
    return out;
  });
  return group;
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
      const { publicGroupList, incident } = await fetchPublicStatusPage(s, slug);
      printJson({ ...config, publicGroupList, incident });
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
      const page = statusPageBySlug(s, slug);
      if (page === undefined) fail(1, `status page ${slug} not found`);
      const fetchedConfig = await fetchStatusPageConfig(s, slug);
      const { publicGroupList: fetchedGroups } = await fetchPublicStatusPage(s, slug);
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
      const groups = file.groups ?? fetchedGroups.map(toSaveGroup);
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
      // printed like `get`, under the new slug when it changed; the save
      // response carries the groups with their (new) ids
      const config = await fetchStatusPageConfig(s, newSlug);
      const { incident } = await fetchPublicStatusPage(s, newSlug);
      printJson({ ...config, publicGroupList: savedGroups, incident });
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
    .description("Post an incident to a status page (replaces the pinned one)")
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
      const res = await s.request("postIncident", [
        slug,
        { title, content, style: opts.style as string },
      ]);
      const incident = res?.incident;
      if (incident === null || typeof incident !== "object" || Array.isArray(incident)) {
        fail(70, "unexpected postIncident response");
      }
      printJson(incident);
    });

  statusPages
    .command("unpin <slug>")
    .description("Unpin the incident shown on a status page")
    .action(async (slug) => {
      const s = await connect(["statusPageList"]);
      // unpinIncident runs the UPDATE with a NULL page id for an unknown slug
      // and still answers ok, so the pushed list is the only check
      if (!statusPageBySlug(s, slug)) fail(1, `status page ${slug} not found`);
      await s.request("unpinIncident", [slug]);
      printJson({ slug, unpinned: true });
    });
}
