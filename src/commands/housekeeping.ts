import type { Command } from "commander";
import { connect } from "../kuma.ts";
import { fail, printJson } from "../lib.ts";

// Instance-wide housekeeping: the events act on the whole heartbeat table or
// the database file, so there is no per-monitor variant and no pushed list
// beyond the ones connect() already waits for.
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
      const s = await connect();
      await s.request("shrinkDatabase");
      printJson({ shrunk: true });
    });
}
