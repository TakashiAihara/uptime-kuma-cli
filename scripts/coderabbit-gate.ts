#!/usr/bin/env bun
/**
 * Publish the `coderabbit-review` commit status that branch protection requires.
 *
 *   bun scripts/coderabbit-gate.ts --sha <commit> [--repo o/r] [--dry-run]
 *
 * CodeRabbit reports through a commit status whose state is always `success` —
 * the outcome lives in the description ("Review completed", "Review paused",
 * "Review rate limited", ...), so that status cannot be required as is. This
 * script maps the description onto our own context: `success` only for
 * "Review completed", `pending` while a review is queued or running or has not
 * reported yet, `failure` for every other terminal outcome, with a pointer to
 * `@coderabbitai review`. The workflow re-runs on every CodeRabbit status change
 * and on pull_request_target, so the gate follows the review without polling.
 */

export const GATE_CONTEXT = "coderabbit-review";
export const CODERABBIT_CONTEXT = "CodeRabbit";
// anyone with statuses: write can post under the CodeRabbit context, so the
// actor matters as much as the text
const CODERABBIT_BOT = "coderabbitai[bot]";
// commit status descriptions are capped at 140 chars by the API
const DESCRIPTION_LIMIT = 140;
const REMEDY = "comment `@coderabbitai review` on the PR";

export type CommitStatus = {
  id: number;
  context: string;
  state: string;
  description: string | null;
  created_at: string;
  creator: { login: string } | null;
};

export type GateState = "success" | "failure" | "pending";

export function gateState(description: string | null | undefined): {
  state: GateState;
  description: string;
} {
  // CodeRabbit's description is free text — match the known outcomes by prefix
  // so added detail cannot wedge the gate; anything unrecognized still fails.
  if (description?.startsWith("Review completed")) {
    return { state: "success", description: "CodeRabbit review completed" };
  }
  if (description?.startsWith("Review queued")) {
    return { state: "pending", description: "CodeRabbit review queued" };
  }
  if (description?.startsWith("Review in progress")) {
    return { state: "pending", description: "CodeRabbit review in progress" };
  }
  if (description === undefined || description === null || description === "") {
    return { state: "pending", description: "waiting for the CodeRabbit review" };
  }
  // the remedy must survive truncation — it is the only guidance on the status
  const prefix = "CodeRabbit: ";
  const remedy = ` — ${REMEDY}`;
  const room = DESCRIPTION_LIMIT - prefix.length - remedy.length;
  const detail = description.length > room ? `${description.slice(0, room - 1)}…` : description;
  return { state: "failure", description: `${prefix}${detail}${remedy}` };
}

type Fetch = typeof fetch;

// The gate is a required check and no event may come after a failed run, so a
// transient API failure must not strand it: retry server errors, rate limits
// (GitHub answers secondary limits with 403 + Retry-After, not just 429), and
// network failures a few times before giving up.
const MAX_ATTEMPTS = 3;
// long enough to outlast a secondary rate-limit window, short enough that two
// waits plus the API calls still fit the job's timeout
const MAX_DELAY_MS = 120_000;

function isRetryable(res: Response): boolean {
  if (res.status >= 500 || res.status === 429) return true;
  if (res.status !== 403) return false;
  return (
    res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"
  );
}

function retryAfterMs(res: Response): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  }
  // primary rate limits answer 403 + x-ratelimit-remaining: 0 + a reset epoch
  // instead of Retry-After; wait for the window when it reopens soon
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_DELAY_MS);
  }
  return 0;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: Fetch,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let delay = 500 * 2 ** (attempt - 1);
    try {
      const res = await fetchImpl(url, init);
      if (res.ok || attempt === MAX_ATTEMPTS || !isRetryable(res)) return res;
      delay = Math.max(delay, retryAfterMs(res));
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "uptime-kuma-cli-coderabbit-gate",
  };
}

// The statuses endpoint returns newest first, so the first CodeRabbit entry on
// the first page that has one is the latest review outcome — paginate only
// until it is found. When CodeRabbit never reported, every page is read and the
// result is still the correct pending; the cap only bounds a pathological
// commit, where the newest statuses sit on the early pages anyway.
const STATUS_PAGE_LIMIT = 10;

function nextPageUrl(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match !== null) return match[1]!;
  }
  return null;
}

async function coderabbitDescription(
  token: string,
  repo: string,
  sha: string,
  fetchImpl: Fetch,
): Promise<string | null> {
  let url: string | null =
    `https://api.github.com/repos/${repo}/commits/${sha}/statuses?per_page=100`;
  for (let page = 0; page < STATUS_PAGE_LIMIT && url !== null; page++) {
    const res = await fetchWithRetry(url, { headers: apiHeaders(token) }, fetchImpl);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`GET ${url} failed: ${res.status} ${body}`);
    }
    const statuses = (await res.json()) as CommitStatus[];
    const latest = statuses.find(
      (s) => s.context === CODERABBIT_CONTEXT && s.creator?.login === CODERABBIT_BOT,
    );
    if (latest !== undefined) return latest.description;
    url = nextPageUrl(res.headers.get("link"));
  }
  return null;
}

async function publishStatus(
  token: string,
  repo: string,
  sha: string,
  state: GateState,
  description: string,
  targetUrl: string | undefined,
  dryRun: boolean,
  fetchImpl: Fetch,
): Promise<void> {
  const body = JSON.stringify({
    state,
    context: GATE_CONTEXT,
    description,
    ...(targetUrl === undefined ? {} : { target_url: targetUrl }),
  });
  if (dryRun) {
    console.log(`[dry-run] POST /repos/${repo}/statuses/${sha} ${body}`);
    return;
  }
  const res = await fetchWithRetry(
    `https://api.github.com/repos/${repo}/statuses/${sha}`,
    {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body,
    },
    fetchImpl,
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`POST /repos/${repo}/statuses/${sha} failed: ${res.status} ${text}`);
  }
}

// Evaluate one head SHA and publish the gate status for it.
export async function evaluate(
  token: string,
  repo: string,
  sha: string,
  targetUrl: string | undefined,
  dryRun: boolean,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const description = await coderabbitDescription(token, repo, sha, fetchImpl);
  const gate = gateState(description);
  console.log(
    `${sha}: CodeRabbit ${JSON.stringify(description)} -> ${GATE_CONTEXT} ${gate.state} (${gate.description})`,
  );
  await publishStatus(token, repo, sha, gate.state, gate.description, targetUrl, dryRun, fetchImpl);
}

function usage(): never {
  console.error(
    "usage: bun scripts/coderabbit-gate.ts --sha <commit> [--repo owner/name] [--dry-run]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let sha: string | undefined;
  let repo = process.env.GITHUB_REPOSITORY;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--sha") sha = args[++i];
    else if (arg === "--repo") repo = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else usage();
  }
  // the concurrency group and the statuses POST both key on the full sha — a
  // short sha or ref would silently escape serialization and fail the POST
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha) || repo === undefined || repo === "") {
    usage();
  }

  const token = process.env.GH_TOKEN;
  if (token === undefined || token === "") {
    console.error("GH_TOKEN is not set");
    process.exit(2);
  }

  const targetUrl =
    process.env.GITHUB_RUN_ID === undefined
      ? undefined
      : `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

  await evaluate(token, repo, sha, targetUrl, dryRun);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
