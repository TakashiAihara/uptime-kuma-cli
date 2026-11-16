#!/usr/bin/env bun
/**
 * Publish the `coderabbit-review` commit status that branch protection requires.
 *
 *   bun scripts/coderabbit-gate.ts (--pr <number> | --sha <commit>) [--repo o/r] [--dry-run]
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
const CODERABBIT_CONTEXT = "CodeRabbit";
// commit status descriptions are capped at 140 chars by the API
const DESCRIPTION_LIMIT = 140;
const REMEDY = "comment `@coderabbitai review` on the PR";

export type CommitStatus = {
  id: number;
  context: string;
  state: string;
  description: string | null;
  created_at: string;
};

export type PullRequest = {
  number: number;
  state: string;
  head: { sha: string };
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

// The statuses endpoint lists newest first, but order is not part of the
// contract — pick by created_at/id so a reordered response cannot resurrect an
// older outcome.
export function latestCodeRabbitDescription(statuses: CommitStatus[]): string | null {
  const latest = statuses
    .filter((s) => s.context === CODERABBIT_CONTEXT)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
  return latest?.description ?? null;
}

type Fetch = typeof fetch;

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "uptime-kuma-cli-coderabbit-gate",
  };
}

async function api(token: string, path: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: apiHeaders(token),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`GET ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function pullRequest(
  token: string,
  repo: string,
  number: number,
  fetchImpl: Fetch,
): Promise<PullRequest | null> {
  const pr = (await api(token, `/repos/${repo}/pulls/${number}`, fetchImpl)) as PullRequest;
  return pr.state === "open" ? pr : null;
}

// The statuses endpoint pages at 100 and a busy PR can push the CodeRabbit
// status past page one, so follow Link rel="next". The cap only bounds the
// requests; pages arrive newest first, so the latest CodeRabbit status is in
// the pages already fetched even if the cap is hit.
const STATUS_PAGE_LIMIT = 10;

function nextPageUrl(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match !== null) return match[1]!;
  }
  return null;
}

async function statusesFor(
  token: string,
  repo: string,
  sha: string,
  fetchImpl: Fetch,
): Promise<CommitStatus[]> {
  const statuses: CommitStatus[] = [];
  let url: string | null =
    `https://api.github.com/repos/${repo}/commits/${sha}/statuses?per_page=100`;
  for (let page = 0; page < STATUS_PAGE_LIMIT && url !== null; page++) {
    const res = await fetchImpl(url, { headers: apiHeaders(token) });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`GET ${url} failed: ${res.status} ${body}`);
    }
    statuses.push(...((await res.json()) as CommitStatus[]));
    url = nextPageUrl(res.headers.get("link"));
  }
  return statuses;
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
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body,
  });
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
  const statuses = await statusesFor(token, repo, sha, fetchImpl);
  const description = latestCodeRabbitDescription(statuses);
  const gate = gateState(description);
  console.log(
    `${sha}: CodeRabbit ${JSON.stringify(description)} -> ${GATE_CONTEXT} ${gate.state} (${gate.description})`,
  );
  await publishStatus(token, repo, sha, gate.state, gate.description, targetUrl, dryRun, fetchImpl);
}

// The head SHAs a run must evaluate. --pr resolves the open PR's current head
// (manual dispatch). --sha evaluates the commit itself: the workflow keys its
// concurrency group on that same sha, so every writer of a commit's gate status
// is serialized, and the status lands on the commit the triggering event
// pointed at — on a stale or merged commit it is inert, on an open PR head it
// is the required check.
export async function resolveHeads(
  token: string,
  repo: string,
  target: { pr: number } | { sha: string },
  fetchImpl: Fetch = fetch,
): Promise<string[]> {
  if ("pr" in target) {
    const pull = await pullRequest(token, repo, target.pr, fetchImpl);
    return pull === null ? [] : [pull.head.sha];
  }
  return [target.sha];
}

function usage(): never {
  console.error(
    "usage: bun scripts/coderabbit-gate.ts (--pr <number> | --sha <commit>) [--repo owner/name] [--dry-run]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let pr: number | undefined;
  let sha: string | undefined;
  let repo = process.env.GITHUB_REPOSITORY;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--pr") pr = Number(args[++i]);
    else if (arg === "--sha") sha = args[++i];
    else if (arg === "--repo") repo = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else usage();
  }
  if ((pr === undefined) === (sha === undefined) || repo === undefined || repo === "") usage();
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) usage();

  const token = process.env.GH_TOKEN;
  if (token === undefined || token === "") {
    console.error("GH_TOKEN is not set");
    process.exit(2);
  }

  const targetUrl =
    process.env.GITHUB_RUN_ID === undefined
      ? undefined
      : `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

  const target = pr !== undefined ? { pr } : { sha: sha! };
  const heads = await resolveHeads(token, repo, target, fetch);
  if (heads.length === 0) {
    console.log(`PR #${pr} is not open; nothing to do`);
    return;
  }
  for (const head of heads) {
    await evaluate(token, repo, head, targetUrl, dryRun);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
