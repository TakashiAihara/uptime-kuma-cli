import type { Command } from "commander";

import { connect, type NotificationRow } from "../kuma.ts";
import { fail, parseSets, printJson, readJsonFile, redactUrl } from "../lib.ts";

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

// The stored config is the whole object the provider reads; the bean adds
// id, active and isDefault. A stray copy a --set stored loses to the row's
// value, and a config that predates isDefault still reports the column.
function notificationObject(row: NotificationRow): Record<string, unknown> {
  const config = storedConfig(row);
  delete config.id;
  delete config.active;
  return { id: row.id, active: row.active, isDefault: row.isDefault, ...config };
}

// Fields whose names end in a secret word print "***" when they hold a
// value — the same convention as monitor secrets. Every provider's token /
// password / api-key field on both supported Kuma versions is named that
// way.
const SECRET_FIELD_NAME = /(?:password|passwd|secret|token|pass|key|credentials?)$/i;

// What the name pattern cannot see: the Nostr sender keypair, the JSON
// header blocks, the webhook request body, the fields upstream renders as
// HiddenInput although the name carries no secret word (the Aliyun access
// key id and recipient phone number, the heii trigger id, the Webpush
// subscription credential), and the URLs upstream renders as HiddenInput
// because the credential sits inside the URL itself.
const SECRET_FIELDS = new Set([
  "accessKeyId",
  "bitrix24WebhookURL",
  "discordWebhookUrl",
  "fluxerWebhookUrl",
  "googleSheetsWebhookUrl",
  "halowebhookurl",
  "heiiOnCallTriggerId",
  "phonenumber",
  "sender",
  "smtpAdditionalHeaders",
  "splunkRestURL",
  "subscription",
  "webhookAdditionalHeaders",
  "webhookCustomBody",
  "wxpusherSPT",
]);

// URL-valued fields print through redactUrl like a monitor url — userinfo
// is masked, the rest stays readable. The suffix covers the *URL / *Url /
// *url, *Endpoint, *Addr and *Server spellings providers use; ntfyIcon and
// the Nostr relays list hold URLs without one of them.
const URL_FIELD_NAME = /(?:url|uri|endpoint|addr|server)$/i;
const URL_FIELDS = new Set(["ntfyIcon", "relays"]);

function redactNotificationConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELDS.has(key) || SECRET_FIELD_NAME.test(key)) {
      // presence, not type: --config-file may store any JSON value
      out[key] = value === undefined || value === null || value === "" ? value : "***";
    } else {
      out[key] = URL_FIELDS.has(key) || URL_FIELD_NAME.test(key) ? redactUrl(value) : value;
    }
  }
  return out;
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
    .command("get <id|name>")
    .description("Show one notification's stored config")
    .action(async (rawId) => {
      const s = await connect();
      const id = s.resolveNotificationId(rawId);
      const row = s.notificationById(id);
      if (!row) fail(1, `notification ${id} not found`);
      printJson(redactNotificationConfig(notificationObject(row)));
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
    .command("edit <id|name>")
    .description("Edit a notification")
    .option("--set <key=value>", "config key=value (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file merged into the config")
    .action(async (rawId, opts) => {
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
      const id = s.resolveNotificationId(rawId);
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
    .command("test <id|name>")
    .description("Send a test notification")
    .addHelpText(
      "after",
      "\nThe test send carries no heartbeat, so it skips the payload a real alert builds — a pass does not prove a DOWN notification is delivered (on Kuma 1.x an ntfy view action on a monitor without a url fails while the test succeeds).",
    )
    .action(async (rawId) => {
      const s = await connect();
      const id = s.resolveNotificationId(rawId);
      const row = s.notificationById(id);
      if (!row) fail(1, `notification ${id} not found`);
      const res = await s.request("testNotification", [storedConfig(row)]);
      printJson({ id, ok: true, msg: res?.msg ?? null });
    });

  notifications
    .command("delete <id|name>")
    .description("Delete a notification")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      if (!opts.yes) fail(2, `would delete notification ${rawId}; pass --yes to delete`);
      const s = await connect();
      const id = s.resolveNotificationId(rawId);
      // Kuma 1.23 rejects an unknown id with ok:false, so no pre-check (unlike deleteMonitor)
      await s.request("deleteNotification", [id]);
      printJson({ id, deleted: true });
    });
}
