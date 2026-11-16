import { describe, expect, test } from "bun:test";
import {
  CODERABBIT_CONTEXT,
  GATE_CONTEXT,
  evaluate,
  gateState,
  type CommitStatus,
} from "../scripts/coderabbit-gate.ts";

const status = (over: Partial<CommitStatus>): CommitStatus => ({
  id: 1,
  context: "CodeRabbit",
  state: "success",
  description: "Review completed",
  created_at: "2026-11-16T00:00:00Z",
  ...over,
});

describe("gateState", () => {
  test("passes only on Review completed", () => {
    expect(gateState("Review completed")).toEqual({
      state: "success",
      description: "CodeRabbit review completed",
    });
  });

  test("stays pending while CodeRabbit is queued, running or has not reported", () => {
    expect(gateState("Review queued").state).toBe("pending");
    expect(gateState("Review in progress").state).toBe("pending");
    expect(gateState(null).state).toBe("pending");
    expect(gateState(undefined).state).toBe("pending");
    expect(gateState("").state).toBe("pending");
  });

  test("tolerates detail CodeRabbit appends to a known outcome", () => {
    expect(gateState("Review completed — 3 files reviewed").state).toBe("success");
    expect(gateState("Review in progress: scripts/coderabbit-gate.ts").state).toBe("pending");
    expect(gateState("Review queued: waiting for a free slot").state).toBe("pending");
  });

  test("fails every other outcome and says what to do", () => {
    for (const description of [
      "Review paused",
      "Review skipped",
      "Review rate limited",
      "Review failed",
      "Review cancelled",
      "No files to review",
      "Too many files to review",
      "Incremental review skipped",
      "something CodeRabbit adds later",
    ]) {
      const gate = gateState(description);
      expect(gate.state).toBe("failure");
      expect(gate.description).toContain(description);
      expect(gate.description).toContain("@coderabbitai review");
      expect(gate.description.length).toBeLessThanOrEqual(140);
    }
  });

  test("keeps the remedy when CodeRabbit's description is too long to fit", () => {
    const gate = gateState(`Review skipped: ${"x".repeat(500)}`);
    expect(gate.state).toBe("failure");
    expect(gate.description.length).toBeLessThanOrEqual(140);
    expect(gate.description).toContain("@coderabbitai review");
    expect(gate.description).toContain("Review skipped");
  });
});

describe("gate context", () => {
  test("is the context branch protection will require", () => {
    expect(GATE_CONTEXT).toBe("coderabbit-review");
  });

  test("matches the context the script filters CodeRabbit statuses by", () => {
    expect(CODERABBIT_CONTEXT).toBe("CodeRabbit");
  });
});

describe("evaluate", () => {
  const SHA = "d1198426c550f14248c057ddd949ee40296b01c7";
  const REPO = "o/r";

  // a fetch that answers the statuses GET with `statuses` and records every
  // request; the POST reply is a canned 201
  const fakeFetch = (statuses: CommitStatus[]) => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body });
      if (method === "GET") {
        return new Response(JSON.stringify(statuses), { status: 200 });
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    return { calls, impl };
  };

  test("posts a success status when CodeRabbit completed the review", async () => {
    const { calls, impl } = fakeFetch([status({ description: "Review completed" })]);
    await evaluate("tok", REPO, SHA, "https://example.test/run/1", false, impl);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      `https://api.github.com/repos/${REPO}/commits/${SHA}/statuses?per_page=100`,
    );
    const post = calls[1]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`https://api.github.com/repos/${REPO}/statuses/${SHA}`);
    expect(JSON.parse(String(post.body))).toEqual({
      state: "success",
      context: GATE_CONTEXT,
      description: "CodeRabbit review completed",
      target_url: "https://example.test/run/1",
    });
  });

  test("posts a failure status naming the remedy when the review was skipped", async () => {
    const { calls, impl } = fakeFetch([status({ description: "Review rate limited" })]);
    await evaluate("tok", REPO, SHA, undefined, false, impl);

    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body.state).toBe("failure");
    expect(body.context).toBe(GATE_CONTEXT);
    expect(body.description).toContain("Review rate limited");
    expect(body.description).toContain("@coderabbitai review");
    expect(body).not.toHaveProperty("target_url");
  });

  test("posts pending when CodeRabbit has not reported yet", async () => {
    const { calls, impl } = fakeFetch([]);
    await evaluate("tok", REPO, SHA, undefined, false, impl);

    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body.state).toBe("pending");
  });

  test("uses the first CodeRabbit entry, which the API documents as newest", async () => {
    const { calls, impl } = fakeFetch([
      status({ id: 9, description: "Review completed", created_at: "2026-11-16T00:09:00Z" }),
      status({ id: 8, description: "Review paused", created_at: "2026-11-16T00:08:00Z" }),
    ]);
    await evaluate("tok", REPO, SHA, undefined, false, impl);

    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body.state).toBe("success");
  });

  test("stops paging once a CodeRabbit status is found", async () => {
    const page2 = `https://api.github.com/repos/${REPO}/commits/${SHA}/statuses?per_page=100&page=2`;
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request, _init?: RequestInit) => {
      calls.push(String(url));
      return new Response(JSON.stringify([status({ description: "Review completed" })]), {
        status: 200,
        headers: { link: `<${page2}>; rel="next"` },
      });
    }) as typeof fetch;

    await evaluate("tok", REPO, SHA, undefined, false, impl);

    expect(calls).toHaveLength(2); // one statuses GET + the POST, no page 2
    expect(calls[1]).toBe(`https://api.github.com/repos/${REPO}/statuses/${SHA}`);
  });

  test("follows Link pagination until the CodeRabbit status is found", async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      status({ id: i + 1, context: "ci/check", description: "build" }),
    );
    const page2 = `https://api.github.com/repos/${REPO}/commits/${SHA}/statuses?per_page=100&page=2`;
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body });
      if (u === page2) {
        return new Response(JSON.stringify([status({ description: "Review completed" })]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(filler), {
        status: 200,
        headers: {
          link: `<${page2}>; rel="next", <https://api.github.com/repos/${REPO}/commits/${SHA}/statuses?per_page=100&page=3>; rel="last"`,
        },
      });
    }) as typeof fetch;

    await evaluate("tok", REPO, SHA, undefined, false, impl);

    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[1]!.url).toBe(page2);
    expect(JSON.parse(String(calls[2]!.body))).toMatchObject({ state: "success" });
  });

  test("retries a transient API failure instead of stranding the check", async () => {
    // no event may come after the last CodeRabbit status, so one 500 must not
    // leave the required check pending forever
    let gets = 0;
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") {
        gets++;
        if (gets === 1) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify([status({ description: "Review completed" })]), {
          status: 200,
        });
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await evaluate("tok", REPO, SHA, undefined, false, impl);

    expect(calls).toEqual(["GET", "GET", "POST"]);
  });

  test("retries a rate-limit 403 and waits out Retry-After", async () => {
    // GitHub answers secondary rate limits with 403 + Retry-After, not 429
    let gets = 0;
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") {
        gets++;
        if (gets === 1) {
          return new Response("rate limited", {
            status: 403,
            headers: { "retry-after": "1" },
          });
        }
        return new Response(JSON.stringify([status({ description: "Review completed" })]), {
          status: 200,
        });
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await evaluate("tok", REPO, SHA, undefined, false, impl);

    expect(calls).toEqual(["GET", "GET", "POST"]);
  });

  test("waits out a primary rate-limit window announced by x-ratelimit-reset", async () => {
    // primary limits answer 403 + x-ratelimit-remaining: 0 + a reset epoch,
    // without Retry-After — the wait must come from the reset timestamp
    let gets = 0;
    const calls: string[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") {
        gets++;
        if (gets === 1) {
          return new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1),
            },
          });
        }
        return new Response(JSON.stringify([status({ description: "Review completed" })]), {
          status: 200,
        });
      }
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await evaluate("tok", REPO, SHA, undefined, false, impl);

    expect(calls).toEqual(["GET", "GET", "POST"]);
  });

  test("does not retry a plain client error", async () => {
    let calls = 0;
    const impl = (async (_url: string | URL | Request, _init?: RequestInit) => {
      calls++;
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    await expect(evaluate("tok", REPO, SHA, undefined, false, impl)).rejects.toThrow("404");
    expect(calls).toBe(1);
  });

  test("dry-run prints the status it would post without calling the API for it", async () => {
    const { calls, impl } = fakeFetch([status({ description: "Review paused" })]);
    const logs: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg));
    try {
      await evaluate("tok", REPO, SHA, undefined, true, impl);
    } finally {
      console.log = original;
    }

    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("[dry-run] POST");
    expect(logs.join("\n")).toContain('"state":"failure"');
  });
});
