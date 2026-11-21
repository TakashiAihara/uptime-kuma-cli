import type { Command } from "commander";

import { connect } from "../kuma.ts";
import { fail, parsePositiveInteger, parsePositiveNumber, printJson } from "../lib.ts";

type Beat = Record<string, unknown>;

function beatRows(res: any): Beat[] {
  const data = res?.data;
  if (!Array.isArray(data)) fail(70, "unexpected getMonitorBeats response");
  return data as Beat[];
}

const beatShape = (b: Beat) => ({
  time: b.time ?? null,
  status: b.status ?? null,
  msg: b.msg ?? null,
  ping: b.ping ?? null,
  important: b.important ?? null,
});

export function registerBeats(program: Command): void {
  const beats = program.command("beats").description("Heartbeat history");

  beats
    .argument("<id|name>", "monitor id or name")
    .option("--hours <n>", "hours of history (default 24)")
    .option("--limit <n>", "keep only the newest n beats")
    .option("--important", "keep only status changes")
    .action(async (rawId, opts) => {
      const hours = opts.hours === undefined ? 24 : parsePositiveNumber(opts.hours, "--hours");
      const limit =
        opts.limit === undefined ? undefined : parsePositiveInteger(opts.limit, "--limit");
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
      const res = await s.request("getMonitorBeats", [id, hours]);
      // Kuma returns beats oldest first
      let rows = beatRows(res).reverse();
      if (opts.important) rows = rows.filter((b) => b.important);
      if (limit !== undefined) rows = rows.slice(0, limit);
      printJson(rows.map(beatShape));
    });

  beats
    .command("latest")
    .description("Newest beat of every monitor")
    .action(async () => {
      const s = await connect();
      const monitors = s.monitors();
      const names = new Map<number, string>(
        monitors.map((m) => [m.id, m.name] as [number, string]),
      );
      await s.waitHeartbeats(
        monitors.map((m) => m.id),
        names,
      );
      printJson(
        monitors.map((m) => {
          const beats = s.heartbeat(m.id);
          const newest =
            beats !== undefined && beats.length > 0 ? beats[beats.length - 1] : undefined;
          return {
            id: m.id,
            name: m.name,
            active: m.active ?? null,
            time: newest?.time ?? null,
            status: newest?.status ?? null,
            msg: newest?.msg ?? null,
          };
        }),
      );
    });
}

export function registerEvents(program: Command): void {
  program
    .command("events <id|name>")
    .description("Status changes of a monitor")
    .option("--hours <n>", "hours of history (default 168)")
    .option("--by-day", "count downs and ups per UTC day")
    .action(async (rawId, opts) => {
      const hours = opts.hours === undefined ? 168 : parsePositiveNumber(opts.hours, "--hours");
      const s = await connect();
      const id = s.resolveMonitorId(rawId);
      const res = await s.request("getMonitorBeats", [id, hours]);
      const rows = beatRows(res)
        .filter((b) => b.important)
        .reverse();
      if (opts.byDay) {
        const days = new Map<string, { date: string; down: number; up: number }>();
        for (const b of rows) {
          const date = String(b.time ?? "").slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const day = days.get(date) ?? { date, down: 0, up: 0 };
          if (b.status === 0) day.down += 1;
          else if (b.status === 1) day.up += 1;
          days.set(date, day);
        }
        printJson([...days.values()].sort((a, b) => a.date.localeCompare(b.date)));
      } else {
        printJson(
          rows.map((b) => ({
            time: b.time ?? null,
            status: b.status ?? null,
            msg: b.msg ?? null,
          })),
        );
      }
    });
}
