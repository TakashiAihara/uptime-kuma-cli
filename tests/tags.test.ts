import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type FakeKuma, startFakeKuma } from "./helpers/fake-kuma";
import { creds, run, type Sandbox, sandbox } from "./helpers/run";

let kuma: FakeKuma;
let sb: Sandbox;

beforeEach(async () => {
  sb = sandbox();
  kuma = await startFakeKuma({
    tags: [
      { id: 2, name: "prod", color: "#ff0000" },
      { id: 1, name: "staging", color: "#00ff00" },
    ],
  });
});
afterEach(async () => {
  await kuma.close();
  sb.cleanup();
});

describe("tags", () => {
  test("list prints { id, name, color } sorted by id", async () => {
    const r = await run(sb, ["tags", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([
      { id: 1, name: "staging", color: "#00ff00" },
      { id: 2, name: "prod", color: "#ff0000" },
    ]);
  });

  test("list prints an empty array when Kuma has no tags", async () => {
    kuma.state.tags = [];
    const r = await run(sb, ["tags", "list"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual([]);
  });

  test("list exits 1 with Kuma's message when getTags fails", async () => {
    kuma.state.fail.getTags = "db is gone";
    const r = await run(sb, ["tags", "list"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("db is gone");
  });

  test("add sends addTag and prints the new tag", async () => {
    const r = await run(
      sb,
      ["tags", "add", "--name", "edge", "--color", "#ABCDEF"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, name: "edge", color: "#ABCDEF" });
    expect(kuma.calls.find((c) => c.event === "addTag")!.args).toEqual([
      { name: "edge", color: "#ABCDEF" },
    ]);
    expect(kuma.state.tags.find((t) => t.id === 3)).toEqual({
      id: 3,
      name: "edge",
      color: "#ABCDEF",
    });
  });

  test("add with the same name exits 3 without sending addTag", async () => {
    const r = await run(
      sb,
      ["tags", "add", "--name", "prod", "--color", "#123456"],
      creds(kuma.url),
    );
    expect(r.code).toBe(3);
    expect(r.json()).toEqual({ id: 2, name: "prod", skipped: true });
    expect(kuma.calls.find((c) => c.event === "addTag")).toBeUndefined();
    expect(kuma.state.tags).toHaveLength(2);
  });

  test("add matches the existing name exactly, not case-insensitively", async () => {
    const r = await run(
      sb,
      ["tags", "add", "--name", "PROD", "--color", "#123456"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(kuma.calls.find((c) => c.event === "addTag")).toBeDefined();
  });

  test.each(["red", "#1234", "#12345g", "#1234567", "ff0000", " #ff0000"])(
    "add rejects --color %p with exit 2 before connecting",
    async (color) => {
      const r = await run(sb, ["tags", "add", "--name", "x", "--color", color], creds(kuma.url));
      expect(r.code).toBe(2);
      expect(kuma.calls).toHaveLength(0);
    },
  );

  test("add accepts a #rgb color and stores it verbatim", async () => {
    const r = await run(sb, ["tags", "add", "--name", "edge", "--color", "#aBc"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 3, name: "edge", color: "#aBc" });
    expect(kuma.calls.find((c) => c.event === "addTag")!.args).toEqual([
      { name: "edge", color: "#aBc" },
    ]);
  });

  test("add without --name exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "add", "--color", "#ff0000"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("add with an empty --name exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "add", "--name", "", "--color", "#ff0000"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name");
    expect(kuma.calls).toHaveLength(0);
  });

  test("add: an addTag answer without tag.id exits 70", async () => {
    kuma.state.addTagResult = { ok: true, tag: { name: "ghost", color: "#ff0000" } };
    const r = await run(
      sb,
      ["tags", "add", "--name", "ghost", "--color", "#ff0000"],
      creds(kuma.url),
    );
    expect(r.code).toBe(70);
    expect(r.stderr).toContain("unexpected addTag response");
  });

  test("add without --color exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "add", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit --name keeps the stored color", async () => {
    const r = await run(sb, ["tags", "edit", "2", "--name", "prod-eu"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2, name: "prod-eu", color: "#ff0000" });
    expect(kuma.calls.find((c) => c.event === "editTag")!.args).toEqual([
      { id: 2, name: "prod-eu", color: "#ff0000" },
    ]);
    expect(kuma.state.tags.find((t) => t.id === 2)).toEqual({
      id: 2,
      name: "prod-eu",
      color: "#ff0000",
    });
  });

  test("edit --color keeps the stored name", async () => {
    const r = await run(sb, ["tags", "edit", "1", "--color", "#0000FF"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, name: "staging", color: "#0000FF" });
    expect(kuma.calls.find((c) => c.event === "editTag")!.args).toEqual([
      { id: 1, name: "staging", color: "#0000FF" },
    ]);
  });

  test("edit with --name and --color sends both", async () => {
    const r = await run(
      sb,
      ["tags", "edit", "1", "--name", "stg", "--color", "#010203"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, name: "stg", color: "#010203" });
    expect(kuma.calls.find((c) => c.event === "editTag")!.args).toEqual([
      { id: 1, name: "stg", color: "#010203" },
    ]);
  });

  test("edit accepts a #rgb color", async () => {
    const r = await run(sb, ["tags", "edit", "1", "--color", "#0f0"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, name: "staging", color: "#0f0" });
    expect(kuma.calls.find((c) => c.event === "editTag")!.args).toEqual([
      { id: 1, name: "staging", color: "#0f0" },
    ]);
  });

  test("edit --name to a name another tag uses exits 1 naming that tag", async () => {
    const r = await run(sb, ["tags", "edit", "1", "--name", "prod"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('tag name "prod" is already used by tag 2');
    expect(kuma.calls.find((c) => c.event === "editTag")).toBeUndefined();
    expect(kuma.state.tags.find((t) => t.id === 1)!.name).toBe("staging");
  });

  test("edit --name to the tag's own current name is allowed", async () => {
    const r = await run(sb, ["tags", "edit", "2", "--name", "prod"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2, name: "prod", color: "#ff0000" });
  });

  test("edit keeping a duplicated name alongside --color is allowed", async () => {
    kuma.state.tags.find((t) => t.id === 1)!.name = "prod";
    const r = await run(
      sb,
      ["tags", "edit", "1", "--name", "prod", "--color", "#abc"],
      creds(kuma.url),
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 1, name: "prod", color: "#abc" });
    expect(kuma.calls.find((c) => c.event === "editTag")!.args).toEqual([
      { id: 1, name: "prod", color: "#abc" },
    ]);
  });

  test("edit with an empty --name exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "edit", "1", "--name", ""], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit without --name or --color exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "edit", "1"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--name");
    expect(r.stderr).toContain("--color");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit with an invalid color exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "edit", "1", "--color", "blue"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "edit", "abc", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("edit of an unknown id exits 1 without sending editTag", async () => {
    const r = await run(sb, ["tags", "edit", "9", "--name", "x"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tag 9 not found");
    expect(kuma.calls.find((c) => c.event === "editTag")).toBeUndefined();
  });

  test("delete removes the tag and prints { id, deleted: true }", async () => {
    const r = await run(sb, ["tags", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 2, deleted: true });
    expect(kuma.state.tags.map((t) => t.id)).toEqual([1]);
    expect(kuma.calls.find((c) => c.event === "deleteTag")!.args).toEqual([2]);
  });

  test("delete without --yes exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "delete", "2"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("would delete tag 2");
    expect(r.stderr).toContain("--yes");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete with an invalid id exits 2 before connecting", async () => {
    const r = await run(sb, ["tags", "delete", "abc", "--yes"], creds(kuma.url));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("positive integer");
    expect(kuma.calls).toHaveLength(0);
  });

  test("delete of an unknown id exits 1 without sending deleteTag", async () => {
    const r = await run(sb, ["tags", "delete", "9", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tag 9 not found");
    expect(kuma.calls.find((c) => c.event === "deleteTag")).toBeUndefined();
    expect(kuma.state.tags).toHaveLength(2);
  });

  test("delete: Kuma's ok:false exits 1 with its message", async () => {
    kuma.state.fail.deleteTag = "cannot delete";
    const r = await run(sb, ["tags", "delete", "2", "--yes"], creds(kuma.url));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot delete");
    expect(kuma.state.tags).toHaveLength(2);
  });
});
