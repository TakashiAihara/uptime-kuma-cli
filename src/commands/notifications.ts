import type { Command } from "commander";
import { fail, parseId, parseSets, printJson, readJsonFile } from "../lib.ts";
import { connect, type NotificationRow } from "../kuma.ts";

function storedConfig(row: NotificationRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.config);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  return fail(2, `notification ${row.id} has an unreadable stored config`);
}

// The list view never exposes the config; only the type is read out of it.
function configType(row: NotificationRow): unknown {
  try {
    const value: unknown = JSON.parse(row.config);
    if (value !== null && typeof value === "object") {
      return (value as Record<string, unknown>).type ?? null;
    }
  } catch {
    // an unreadable config reports no type rather than failing the whole list
  }
  return null;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerNotifications(program: Command): void {
  const notifications = program.command("notifications").description("Manage notifications");

  notifications
    .command("list")
    .description("List notifications")
    .action(async () => {
      const s = await connect();
      printJson(
        s.notifications().map((row) => ({
          id: row.id,
          name: row.name,
          type: configType(row),
          active: row.active,
          isDefault: row.isDefault,
        })),
      );
    });

  notifications
    .command("add")
    .description("Add a notification")
    .requiredOption("--name <name>", "notification name")
    .requiredOption("--type <type>", "notification type")
    .option("--set <key=value>", "config key=value (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file merged into the config")
    .option("--default", "mark as the default notification")
    .option("--apply-existing", "apply to existing monitors")
    .action(async (opts) => {
      const sets = parseSets(opts.set as string[] | undefined);
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      // Flags win only when given; otherwise the config file and --set may still turn
      // isDefault / applyExisting on, and both default to false
      const notification: Record<string, unknown> = {
        isDefault: false,
        applyExisting: false,
        ...fileConfig,
        ...sets,
        name: opts.name,
        type: opts.type,
      };
      if (opts.default === true) notification.isDefault = true;
      if (opts.applyExisting === true) notification.applyExisting = true;
      const s = await connect();
      const res = await s.request("addNotification", [notification, null]);
      printJson({ id: res?.id ?? null, name: notification.name, type: notification.type });
    });

  notifications
    .command("edit <id>")
    .description("Edit a notification")
    .option("--set <key=value>", "config key=value (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file merged into the config")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "notification id");
      const sets = parseSets(opts.set as string[] | undefined);
      if (Object.keys(sets).length === 0 && opts.configFile === undefined) {
        fail(2, "notifications edit requires --set key=value or --config-file");
      }
      if ("applyExisting" in sets) {
        fail(2, "applyExisting cannot be set on edit; use notifications add --apply-existing");
      }
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      if ("applyExisting" in fileConfig) {
        fail(2, "applyExisting cannot be set on edit; use notifications add --apply-existing");
      }
      const s = await connect();
      const row = s.notificationById(id);
      if (!row) fail(1, `notification ${id} not found`);
      // applyExisting would re-attach the notification to every monitor.
      const merged: Record<string, unknown> = {
        ...storedConfig(row),
        ...fileConfig,
        ...sets,
        applyExisting: false,
      };
      const res = await s.request("addNotification", [merged, id]);
      printJson({
        id: res?.id ?? id,
        name: merged.name ?? row.name,
        type: merged.type ?? null,
      });
    });

  notifications
    .command("test <id>")
    .description("Send a test notification")
    .action(async (rawId) => {
      const id = parseId(rawId, "notification id");
      const s = await connect();
      const row = s.notificationById(id);
      if (!row) fail(1, `notification ${id} not found`);
      const res = await s.request("testNotification", [storedConfig(row)]);
      printJson({ id, ok: true, msg: res?.msg ?? null });
    });

  notifications
    .command("delete <id>")
    .description("Delete a notification")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "notification id");
      if (!opts.yes) fail(2, `would delete notification ${id}; pass --yes to delete`);
      const s = await connect();
      await s.request("deleteNotification", [id]);
      printJson({ id, deleted: true });
    });
}
