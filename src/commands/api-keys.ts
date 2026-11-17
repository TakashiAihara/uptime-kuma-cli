import type { Command } from "commander";
import { fail, hasOffsetDesignator, localDateTimeFields, parseId, printJson } from "../lib.ts";
import { connect, type ApiKeyRow, type KumaSession } from "../kuma.ts";

// The CLI host's local date as "YYYY-MM-DD", zero-padded like the flag input.
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --expires takes the same offset-free local ISO 8601 datetime as the
// maintenance flags but goes on the wire in the APIKeyDialog datepicker's
// modelType spelling — a space-separated local datetime without fractional
// seconds (the UI's modelType has none, and a DATETIME column cannot keep
// them on every supported DB) that APIKey.save stores verbatim and
// getStatus reads with dayjs as server-local time. Omitting the flag sends
// expires: null, the dialog's "Don't expire". The datepicker's minDate
// refuses dates before today; the CLI applies the same rule against its
// own host's local date, the way the UI judges "today" on the client.
function parseExpires(value: string): string {
  if (hasOffsetDesignator(value)) {
    fail(2, `--expires must be local time without an offset, got "${value}"`);
  }
  const f = localDateTimeFields(value);
  if (f === null) {
    fail(2, `--expires must be an ISO 8601 local datetime, got "${value}"`);
  }
  if (f.fraction !== "") {
    fail(2, `--expires must not have fractional seconds, got "${value}"`);
  }
  if (f.date < localToday()) {
    fail(2, `--expires must be today or later, got "${value}"`);
  }
  return `${f.date} ${f.time}:${f.seconds}`;
}

function parseName(value: string): string {
  if (value === "") fail(2, "--name must not be empty");
  return value;
}

// apiKeyList rows are APIKey.toPublicJSON(): the stored secret `key` is never
// sent, `active` arrives as the BOOLEAN column's 0/1, and `status` is Kuma's
// computed active / inactive / expired. userID and createdDate are pushed
// but not printed.
function keyView(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name ?? null,
    expires: row.expires ?? null,
    active: Boolean(row.active),
    status: row.status ?? null,
  };
}

// enableAPIKey / disableAPIKey / deleteAPIKey all answer ok even when the id
// matches nothing (the UPDATE/DELETE affects 0 rows), and enable/disable do
// not even scope by user — the pushed list is the only guard against
// touching a key that is not the logged-in user's.
function requireApiKey(s: KumaSession, id: number): void {
  if (!s.apiKeyById(id)) fail(1, `api key ${id} not found`);
}

export function registerApiKeys(program: Command): void {
  const apiKeys = program.command("api-keys").description("Manage API keys");

  apiKeys
    .command("list")
    .description("List API keys")
    .action(async () => {
      const s = await connect(["apiKeyList"]);
      printJson(s.apiKeys().map(keyView));
    });

  apiKeys
    .command("add")
    .description("Add an API key")
    .requiredOption("--name <name>", "key name")
    .option(
      "--expires <datetime>",
      "expiry as a local ISO 8601 datetime without an offset; omit to never expire",
    )
    .action(async (opts) => {
      const name = parseName(opts.name as string);
      const expires = opts.expires === undefined ? null : parseExpires(opts.expires as string);
      const s = await connect();
      // APIKeyDialog.vue's save payload; the server generates the clear key,
      // stores only its hash and enables apiKeysEnabled itself
      const res = await s.request("addAPIKey", [{ name, expires, active: 1 }]);
      const id = res?.keyID;
      const key = res?.key;
      if (typeof id !== "number" || typeof key !== "string" || key === "") {
        fail(70, "unexpected addAPIKey response");
      }
      printJson({ id, name, expires, active: true, key });
      console.error(
        "warning: the clear key is returned only once; store it now — it cannot be read again",
      );
      // addAPIKey sets apiKeysEnabled unconditionally and nothing turns it
      // back: /metrics then accepts only API-key auth
      console.error(
        "warning: /metrics now requires API-key auth — login credentials no longer work there",
      );
    });

  apiKeys
    .command("enable <id>")
    .description("Enable an API key")
    .action(async (rawId) => {
      const id = parseId(rawId, "api key id");
      const s = await connect(["apiKeyList"]);
      requireApiKey(s, id);
      await s.request("enableAPIKey", [id]);
      printJson({ id, active: true });
    });

  apiKeys
    .command("disable <id>")
    .description("Disable an API key")
    .action(async (rawId) => {
      const id = parseId(rawId, "api key id");
      const s = await connect(["apiKeyList"]);
      requireApiKey(s, id);
      await s.request("disableAPIKey", [id]);
      printJson({ id, active: false });
    });

  apiKeys
    .command("delete <id>")
    .description("Delete an API key")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "api key id");
      if (!opts.yes) fail(2, `would delete api key ${id}; pass --yes to delete`);
      const s = await connect(["apiKeyList"]);
      requireApiKey(s, id);
      await s.request("deleteAPIKey", [id]);
      printJson({ id, deleted: true });
    });
}
