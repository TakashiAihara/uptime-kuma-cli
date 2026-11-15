import type { Command } from "commander";
import { fail, parseId, printJson } from "../lib.ts";
import { connect } from "../kuma.ts";

// The color is stored and rendered verbatim; the UI's custom color is a free
// hex input that accepts #rgb and #rrggbb.
function parseTagColor(value: string): string {
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
    fail(2, `--color must be a #rgb or #rrggbb color, got "${value}"`);
  }
  return value;
}

function parseTagName(value: string): string {
  if (value === "") fail(2, "--name must not be empty");
  return value;
}

export function registerTags(program: Command): void {
  const tags = program.command("tags").description("Manage tags");

  tags
    .command("list")
    .description("List tags")
    .action(async () => {
      const s = await connect();
      const list = (await s.tags()).sort((a, b) => a.id - b.id);
      printJson(list.map((t) => ({ id: t.id, name: t.name, color: t.color })));
    });

  tags
    .command("add")
    .description("Add a tag")
    .requiredOption("--name <name>", "tag name")
    .requiredOption("--color <color>", "tag color (#rgb or #rrggbb)")
    .action(async (opts) => {
      const name = parseTagName(opts.name as string);
      const color = parseTagColor(opts.color);
      const s = await connect();
      const existing = (await s.tags()).find((t) => t.name === name);
      if (existing) {
        printJson({ id: existing.id, name: existing.name, skipped: true });
        fail(3, "");
      }
      const res = await s.request("addTag", [{ name, color }]);
      const id = res?.tag?.id;
      if (typeof id !== "number") fail(70, "unexpected addTag response");
      printJson({ id, name, color });
    });

  tags
    .command("edit <id>")
    .description("Edit a tag")
    .option("--name <name>", "new tag name")
    .option("--color <color>", "new tag color (#rgb or #rrggbb)")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "tag id");
      if (opts.name === undefined && opts.color === undefined) {
        fail(2, "tags edit requires --name or --color");
      }
      const name = opts.name === undefined ? undefined : parseTagName(opts.name as string);
      const color = opts.color === undefined ? undefined : parseTagColor(opts.color);
      const s = await connect();
      const list = await s.tags();
      const tag = list.find((t) => t.id === id);
      if (!tag) fail(1, `tag ${id} not found`);
      // The 1.23.17 TagEditDialog refuses a name another tag already uses;
      // renaming to the tag's own current name is fine, and Kuma itself
      // allows duplicate names
      if (name !== undefined && name !== tag.name) {
        const other = list.find((t) => t.id !== id && t.name === name);
        if (other) fail(1, `tag name "${name}" is already used by tag ${other.id}`);
      }
      // editTag overwrites both fields, so the flag not given keeps the stored value
      const merged = { id, name: name ?? tag.name, color: color ?? tag.color };
      await s.request("editTag", [merged]);
      printJson(merged);
    });

  tags
    .command("delete <id>")
    .description("Delete a tag")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "tag id");
      if (!opts.yes) fail(2, `would delete tag ${id}; pass --yes to delete`);
      const s = await connect();
      // Kuma 1.23 answers ok even for an unknown id, so getTags is the only check
      const list = await s.tags();
      if (!list.some((t) => t.id === id)) fail(1, `tag ${id} not found`);
      await s.request("deleteTag", [id]);
      printJson({ id, deleted: true });
    });
}
