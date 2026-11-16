import { describe, expect, test } from "bun:test";
import {
  GATE_CONTEXT,
  evaluate,
  gateState,
  latestCodeRabbitDescription,
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
});

describe("latestCodeRabbitDescription", () => {
  test("returns the newest CodeRabbit status description", () => {
    const statuses = [
      status({ id: 3, description: "Review completed", created_at: "2026-11-16T00:02:00Z" }),
      status({ id: 2, description: "Review in progress", created_at: "2026-11-16T00:01:00Z" }),
      status({ id: 1, description: "Review queued", created_at: "2026-11-16T00:00:00Z" }),
    ];
    expect(latestCodeRabbitDescription(statuses)).toBe("Review completed");
  });

  test("ignores other contexts and picks the newest on ties", () => {
    const statuses = [
      status({ id: 5, context: "ci/check", description: "other" }),
      status({ id: 4, description: "Review paused", created_at: "2026-11-16T00:01:00Z" }),
      status({ id: 3, description: "Review completed", created_at: "2026-11-16T00:01:00Z" }),
    ];
    // same created_at: the higher id wins
    expect(latestCodeRabbitDescription(statuses)).toBe("Review paused");
  });

  test("returns null when CodeRabbit never reported", () => {
    expect(latestCodeRabbitDescription([status({ context: "ci/check" })])).toBeNull();
    expect(latestCodeRabbitDescription([])).toBeNull();
  });
});

describe("gate context", () => {
  test("is the context branch protection will require", () => {
    expect(GATE_CONTEXT).toBe("coderabbit-review");
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
