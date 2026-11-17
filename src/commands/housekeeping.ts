import type { Command } from "commander";
import { connect, type KumaSession } from "../kuma.ts";
import { fail, printJson, shrinkTimeoutMs } from "../lib.ts";

// Instance-wide housekeeping: the events act on the whole heartbeat table or
// the database file, so there is no per-monitor variant and no pushed list
// beyond the ones connect() already waits for.

// getDatabaseSize/shrinkDatabase are sqlite-only on 2.x: other backends
// answer size 0 and a no-op ok, so the CLI refuses instead of printing a
// lie. 1.23 is sqlite-only and sends no dbType, so the check only fires on
// a present non-sqlite value.
function requireSqlite(s: KumaSession, command: string): void {
  if (s.dbType !== undefined && s.dbType !== "sqlite") {
    fail(2, `"${command}" needs a sqlite database; the server uses "${s.dbType}"`);
  }
}

export function registerHousekeeping(program: Command): void {
  program
    .command("clear-statistics")
    .description("Delete the heartbeat history of every monitor")
    .option("--yes", "confirm clearing")
    .action(async (opts) => {
      if (!opts.yes) fail(2, "would clear statistics of every monitor; pass --yes to clear");
      const s = await connect();
      await s.request("clearStatistics");
      printJson({ cleared: "statistics" });
    });

  const database = program.command("database").description("Database upkeep");

  database
    .command("size")
    .description("Show the database file size in bytes")
    .action(async () => {
      const s = await connect();
      requireSqlite(s, "database size");
      const res = await s.request("getDatabaseSize");
      const size = res?.size;
      if (typeof size !== "number" || !Number.isFinite(size)) {
        fail(70, "unexpected getDatabaseSize response");
      }
      printJson({ sizeBytes: size });
    });

  database
    .command("shrink")
    .description("Rebuild the database file (VACUUM)")
    .option("--yes", "confirm shrinking")
    .action(async (opts) => {
      if (!opts.yes) fail(2, "would shrink the database; pass --yes to shrink");
      const timeoutMs = shrinkTimeoutMs();
      const s = await connect();
      requireSqlite(s, "database shrink");
      await s.request("shrinkDatabase", [], timeoutMs);
      // 1.23.17's handler does not await Database.shrink(), so its ok only
      // means VACUUM was dispatched — completion and failure are invisible;
      // 2.x awaits it, so ok there means the shrink finished.
      printJson(s.majorVersion >= 2 ? { shrunk: true } : { started: true });
    });
}
