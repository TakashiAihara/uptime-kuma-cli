import { Option, type Command } from "commander";
import { fail, printJson, socketTimeoutMs } from "../lib.ts";
import { connect, type KumaSession, type StatusPageRow } from "../kuma.ts";

// The six styles the StatusPage.vue incident picker offers; createIncident
// starts a new incident at "primary".
const INCIDENT_STYLES = ["info", "warning", "danger", "primary", "light", "dark"] as const;

// addStatusPage of Kuma 1.23.17 trims title and slug, lower-cases the slug
// and runs checkSlug; after the lower-casing the accepted set is lowercase
// words joined by single hyphens.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
): Promise<{ publicGroupList: unknown; incident: unknown }> {
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
  return { publicGroupList: body.publicGroupList, incident };
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
