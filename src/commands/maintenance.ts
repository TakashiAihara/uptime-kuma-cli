import { Option, type Command } from "commander";
import { fail, parseId, parseSets, printJson, readJsonFile } from "../lib.ts";
import { connect, type KumaSession } from "../kuma.ts";

// The six strategies the 1.23.17 EditMaintenance.vue picker offers.
const STRATEGIES = [
  "manual",
  "single",
  "cron",
  "recurring-interval",
  "recurring-weekday",
  "recurring-day-of-month",
] as const;

const collect = (value: string, previous: string[]): string[] => [...previous, value];

// --start/--end are ISO 8601 local datetimes: Kuma stores the strings and
// reads them as local time in timezoneOption (dayjs.tz in getStatus, the
// single-window croner job), so an offset designator would be misparsed —
// the UI's datetime-local input never sends one, and neither does the CLI.
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const OFFSET_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}(:\d{2}|\d{2})?)$/;

const hasOffset = (value: string): boolean => OFFSET_DATETIME.test(value);

const isLocalDateTime = (value: unknown): value is string =>
  typeof value === "string" && LOCAL_DATETIME.test(value) && !Number.isNaN(Date.parse(value));

const LOCAL_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

// Ordering must not go through Date.parse: it resolves the offset-free
// strings in the CLI host's timezone, where DST can reorder local times.
// Compare the fields instead; callers run isLocalDateTime first.
function compareLocalDateTimes(a: string, b: string): number {
  const pa = LOCAL_PARTS.exec(a);
  const pb = LOCAL_PARTS.exec(b);
  if (pa === null || pb === null) return Number.NaN;
  for (let i = 1; i <= 6; i++) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const fa = pa[7] ?? "";
  const fb = pb[7] ?? "";
  const width = Math.max(fa.length, fb.length);
  const sa = fa.padEnd(width, "0");
  const sb = fb.padEnd(width, "0");
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function parseIsoDateTime(value: string, flag: string): string {
  if (hasOffset(value)) {
    fail(
      2,
      `${flag} must be local time in the maintenance timezone without an offset, got "${value}"`,
    );
  }
  if (!LOCAL_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
    fail(2, `${flag} must be an ISO 8601 local datetime, got "${value}"`);
  }
  return value;
}

// --start and --end are the UI's "Effective Date Range": every strategy except
// manual accepts them, single requires both, and the UI allows a start
// without an end.
function parseDateRange(start: string | undefined, end: string | undefined): string[] | undefined {
  if (start === undefined) {
    if (end !== undefined) fail(2, "--end requires --start");
    return undefined;
  }
  const s = parseIsoDateTime(start, "--start");
  if (end === undefined) return [s];
  const e = parseIsoDateTime(end, "--end");
  if (compareLocalDateTimes(e, s) <= 0) fail(2, "--end must be after --start");
  return [s, e];
}

const isIanaTimezone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// An invalid timezone makes dayjs.tz throw inside Maintenance.toJSON, which
// breaks the maintenanceList push for every user, so it is checked up front.
// SAME_AS_SERVER is the UI's "use the server timezone" option, not an IANA name.
function parseTimezone(value: string): string {
  if (value !== "SAME_AS_SERVER" && !isIanaTimezone(value)) {
    fail(2, `--timezone must be an IANA timezone name or SAME_AS_SERVER, got "${value}"`);
  }
  return value;
}

function parseTitle(value: string): string {
  if (value === "") fail(2, "--title must not be empty");
  return value;
}

function parseIdList(value: string, flag: string): number[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((part) => parseId(part.trim(), flag));
}

async function fetchMaintenance(s: KumaSession, id: number): Promise<Record<string, unknown>> {
  const res = await s.request("getMaintenance", [id]);
  const maintenance = res?.maintenance;
  if (maintenance === null || typeof maintenance !== "object") {
    fail(1, `maintenance ${id} not found`);
  }
  return maintenance as Record<string, unknown>;
}

const isPosInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

// timeRange entries are the {hours, minutes, seconds?} objects
// parseTimeObject emits; seconds is optional in what jsonToBean accepts.
const isTimeRange = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return value.every((t) => {
    if (t === null || typeof t !== "object") return false;
    const o = t as Record<string, unknown>;
    return (
      isIntIn(o.hours, 0, 23) &&
      isIntIn(o.minutes, 0, 59) &&
      (o.seconds === undefined || o.seconds === null || isIntIn(o.seconds, 0, 59))
    );
  });
};

// generateCron joins weekdays into the cron dow field, so only 0-6 work.
const isWeekdayList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((d) => isIntIn(d, 0, 6));

// days_of_month accepts ints 1-31 and "lastDay1" (generateCron maps it to "L").
const isDayOfMonthList = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every((d) => isIntIn(d, 1, 31) || d === "lastDay1");

// The EditMaintenance.vue intervalDay input is capped at 3650.
const MAX_INTERVAL_DAY = 3650;

// croner 6.0.7 shape check, mirroring CronPattern.parse up to
// throwAtIllegalCharacters: a nickname expands first, the pattern splits on
// whitespace into 5 or 6 parts (5 gets a leading seconds "0"), the first "L"
// is stripped from day-of-month and day-of-week, month and day-of-week parts
// of 3+ chars get the JAN-DEC / SUN-SAT names replaced, the first "?" of each
// part becomes a number, and what remains may only contain [0-9*/,-]. Ranges and
// values are still croner's job; Kuma 1.23.17 calls the async validateCron
// without await, so a bad expression is stored anyway and the rejection
// goes unhandled — only the shape is checked up front.
const CRON_NICKNAMES = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

const CRON_LEGAL = /^[0-9*,/-]*$/;

// croner's replaceAlphaMonths / replaceAlphaDays are substring replacements,
// so a name only survives the charset check when it converts fully to digits
const alphaMonths = (value: string): string =>
  value
    .replace(/jan/gi, "1")
    .replace(/feb/gi, "2")
    .replace(/mar/gi, "3")
    .replace(/apr/gi, "4")
    .replace(/may/gi, "5")
    .replace(/jun/gi, "6")
    .replace(/jul/gi, "7")
    .replace(/aug/gi, "8")
    .replace(/sep/gi, "9")
    .replace(/oct/gi, "10")
    .replace(/nov/gi, "11")
    .replace(/dec/gi, "12");

const alphaDays = (value: string): string =>
  value
    .replace(/-sun/gi, "-7")
    .replace(/sun/gi, "0")
    .replace(/mon/gi, "1")
    .replace(/tue/gi, "2")
    .replace(/wed/gi, "3")
    .replace(/thu/gi, "4")
    .replace(/fri/gi, "5")
    .replace(/sat/gi, "6");

function isCronExpression(value: string): boolean {
  let pattern = value;
  if (pattern.includes("@")) {
    pattern = (CRON_NICKNAMES.get(pattern.trim().toLowerCase()) ?? pattern).trim();
  }
  const fields = pattern.replace(/\s+/g, " ").split(" ");
  if (fields.length !== 5 && fields.length !== 6) return false;
  const [second, minute, hour, day, month, dayOfWeek] = (
    fields.length === 5 ? ["0", ...fields] : fields
  ) as [string, string, string, string, string, string];
  const dom = day.replace("L", "");
  const dow = dayOfWeek.replace("L", "");
  const parts = [
    second,
    minute,
    hour,
    dom,
    month.length >= 3 ? alphaMonths(month) : month,
    dow.length >= 3 ? alphaDays(dow) : dow,
  ];
  // croner substitutes the first "?" of each part with a number; leftovers fail
  return parts.every((part) => CRON_LEGAL.test(part.replace("?", "0")));
}

// Maintenance.jsonToBean of Kuma 1.23.17 writes title, description, strategy,
// intervalDay, timezoneOption, active and dateRange unconditionally, then the
// schedule fields of the strategy: cron + durationMinutes for cron,
// timeRange + weekdays + daysOfMonth for recurring-* (generateCron also reads
// intervalDay for recurring-interval). Checking the merged object keeps a
// missing or malformed field from failing inside Kuma.
// full judges every field (add, or an edit that changes strategy); otherwise
// only the touched keys plus the always-read dateRange are judged, the same
// scoping monitors edit uses for its touched/typeChanged rule.
function validateMaintenance(
  m: Record<string, unknown>,
  opts: { full: boolean; touched?: ReadonlySet<string>; edit?: boolean },
): void {
  const need = (key: string) => opts.full || opts.touched?.has(key) === true;
  if (!Array.isArray(m.dateRange)) fail(2, "dateRange must be an array");
  if (need("dateRange") && Array.isArray(m.dateRange)) {
    // jsonToBean stores start/end verbatim and getStatus / the single-window
    // job read them as local time in timezoneOption, so offsets are refused
    // here the same way the flags refuse them. null means "no bound".
    for (const v of m.dateRange as unknown[]) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && hasOffset(v)) {
        fail(
          2,
          `"dateRange" must be local time in the maintenance timezone without an offset, got "${v}"`,
        );
      }
      if (!isLocalDateTime(v)) {
        fail(2, `"dateRange" entries must be ISO 8601 local datetimes, got ${JSON.stringify(v)}`);
      }
    }
  }
  if (need("title") && (typeof m.title !== "string" || m.title === "")) {
    fail(2, "title must be a non-empty string");
  }
  if (need("description") && typeof m.description !== "string") {
    fail(2, "description must be a string");
  }
  if (
    need("strategy") &&
    (typeof m.strategy !== "string" || !(STRATEGIES as readonly string[]).includes(m.strategy))
  ) {
    fail(2, `unknown maintenance strategy "${String(m.strategy)}"`);
  }
  const strategy = typeof m.strategy === "string" ? m.strategy : undefined;
  if (need("intervalDay")) {
    // recurring-interval feeds interval_day into "*/N"; the other strategies
    // only store it, so null stays acceptable there
    const required = strategy === "recurring-interval";
    const v = m.intervalDay;
    const ok = required
      ? isPosInt(v) && v <= MAX_INTERVAL_DAY
      : v === null || v === undefined || (isPosInt(v) && v <= MAX_INTERVAL_DAY);
    if (!ok) fail(2, "intervalDay must be a positive integer no greater than 3650");
  }
  if (
    need("timezoneOption") &&
    m.timezoneOption !== null &&
    m.timezoneOption !== undefined &&
    (typeof m.timezoneOption !== "string" ||
      (m.timezoneOption !== "" &&
        m.timezoneOption !== "SAME_AS_SERVER" &&
        !isIanaTimezone(m.timezoneOption)))
  ) {
    fail(2, 'timezoneOption must be an IANA timezone name, "SAME_AS_SERVER", "" or null');
  }
  if (strategy === "cron") {
    if (need("cron")) {
      const cron = m.cron;
      if (typeof cron !== "string" || cron === "") {
        fail(2, 'strategy "cron" requires a non-empty "cron" expression');
      }
      if (!isCronExpression(cron)) {
        fail(2, 'strategy "cron" requires "cron" as 5 or 6 whitespace-separated cron fields');
      }
    }
    if (need("durationMinutes") && !isPosInt(m.durationMinutes)) {
      fail(2, 'strategy "cron" requires "durationMinutes" as a positive integer');
    }
  } else if (strategy !== undefined && strategy.startsWith("recurring-")) {
    if (need("timeRange") && !isTimeRange(m.timeRange)) {
      fail(2, '"timeRange" must be an array of two {hours, minutes, seconds?} objects');
    }
    if (need("weekdays")) {
      const weekdays = m.weekdays;
      if (strategy === "recurring-weekday") {
        if (!isWeekdayList(weekdays) || weekdays.length === 0) {
          fail(2, 'strategy "recurring-weekday" requires "weekdays" as a non-empty integer array');
        }
      } else if (!isWeekdayList(weekdays)) {
        fail(2, '"weekdays" must be an array of integers 0-6');
      }
    }
    if (need("daysOfMonth")) {
      const days = m.daysOfMonth;
      if (strategy === "recurring-day-of-month") {
        if (!isDayOfMonthList(days) || days.length === 0) {
          fail(
            2,
            'strategy "recurring-day-of-month" requires "daysOfMonth" as a non-empty integer array',
          );
        }
      } else if (!isDayOfMonthList(days)) {
        fail(2, '"daysOfMonth" must be an array of integers 1-31 or "lastDay1"');
      }
    }
  }
  if (strategy === "single" && (opts.full || opts.touched?.has("dateRange") === true)) {
    const range = m.dateRange as unknown[];
    const start = range[0];
    const end = range[1];
    if (
      range.length < 2 ||
      !isLocalDateTime(start) ||
      !isLocalDateTime(end) ||
      compareLocalDateTimes(end, start) <= 0
    ) {
      fail(
        2,
        'strategy "single" requires "dateRange" as [start, end] ISO datetimes, end after start',
      );
    }
  }
  // Kuma 1.23.17 bug: Maintenance.run leaves duration undefined when a
  // cron/recurring window has an end_date far enough out, so the timeslot
  // timeout fires at once and the maintenance ends immediately. Those
  // strategies may carry a start but never an end.
  if (
    strategy !== undefined &&
    (strategy === "cron" || strategy.startsWith("recurring-")) &&
    need("dateRange")
  ) {
    const end = (m.dateRange as unknown[])[1];
    if (end !== null && end !== undefined) {
      fail(
        2,
        opts.edit === true
          ? `Kuma 1.23.17 ends a "${strategy}" maintenance immediately ` +
              'when "dateRange" has an end date; clear a stored end with ' +
              '--set dateRange=["<start>"] (local time)'
          : `Kuma 1.23.17 ends a "${strategy}" maintenance immediately ` +
              'when "dateRange" has an end date; give only a start',
      );
    }
  }
}

// The attach subcommands share one shape: get*/add* pairs that replace the
// whole set (Kuma DELETEs then INSERTs, it does not add).
const ATTACH_KINDS = {
  monitor: {
    command: "monitors",
    noun: "monitor",
    field: "name",
    getEvent: "getMonitorMaintenance",
    setEvent: "addMonitorMaintenance",
    responseKey: "monitors",
    extraLists: ["maintenanceList"],
    find: (s: KumaSession, id: number) => {
      const m = s.monitorById(id);
      return m === undefined ? undefined : { id: m.id, label: m.name };
    },
  },
  statusPage: {
    command: "status-pages",
    noun: "status page",
    field: "title",
    getEvent: "getMaintenanceStatusPage",
    setEvent: "addMaintenanceStatusPage",
    responseKey: "statusPages",
    extraLists: ["maintenanceList", "statusPageList"],
    find: (s: KumaSession, id: number) => {
      const p = s.statusPageById(id);
      return p === undefined ? undefined : { id: p.id, label: p.title };
    },
  },
} as const;

type AttachKind = (typeof ATTACH_KINDS)[keyof typeof ATTACH_KINDS];

function registerAttach(maintenance: Command, kind: AttachKind): void {
  maintenance
    .command(`${kind.command} <id>`)
    .description(`Show or change the ${kind.noun}s a maintenance window affects`)
    .option("--set-ids <ids>", "replace the set with these ids (comma-separated)")
    .option("--add <id>", `attach a ${kind.noun} id (repeatable)`, collect, [])
    .option("--remove <id>", `detach a ${kind.noun} id (repeatable)`, collect, [])
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "maintenance id");
      const setIdsRaw = opts.setIds as string | undefined;
      const addIds = ((opts.add as string[] | undefined) ?? []).map((v) => parseId(v, "--add"));
      const removeIds = ((opts.remove as string[] | undefined) ?? []).map((v) =>
        parseId(v, "--remove"),
      );
      const setIds =
        setIdsRaw === undefined ? undefined : [...new Set(parseIdList(setIdsRaw, "--set-ids"))];
      if (setIds !== undefined && (addIds.length > 0 || removeIds.length > 0)) {
        fail(2, "--set-ids cannot be combined with --add or --remove");
      }
      const s = await connect(kind.extraLists);
      if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
      // every user-supplied id must name a row in the pushed list
      for (const target of setIds ?? [...addIds, ...removeIds]) {
        if (kind.find(s, target) === undefined) fail(1, `${kind.noun} ${target} not found`);
      }

      const fetchAttached = async (): Promise<number[]> => {
        const res = await s.request(kind.getEvent, [id]);
        const rows = res?.[kind.responseKey];
        if (!Array.isArray(rows)) fail(70, `unexpected ${kind.getEvent} response`);
        const ids = rows.map((r) => Number((r as { id?: unknown })?.id));
        if (!ids.every((n) => Number.isInteger(n))) {
          fail(70, `unexpected ${kind.getEvent} response`);
        }
        return ids;
      };

      let next: number[];
      let changed = false;
      if (setIds !== undefined) {
        next = [...setIds].sort((a, b) => a - b);
        changed = true;
      } else if (addIds.length > 0 || removeIds.length > 0) {
        const current = await fetchAttached();
        const removing = new Set(removeIds);
        next = current.filter((x) => !removing.has(x));
        for (const addId of addIds) {
          // monitor_maintenance has no unique constraint: never send a dup
          if (!next.includes(addId)) next.push(addId);
        }
        next.sort((a, b) => a - b);
        changed = true;
      } else {
        next = (await fetchAttached()).sort((a, b) => a - b);
      }

      if (changed) {
        await s.request(kind.setEvent, [id, next.map((x) => ({ id: x }))]);
      }
      printJson(
        next.map((x) => {
          const row = kind.find(s, x);
          // after a successful write the set is what Kuma stored; an id that
          // dropped out of the pushed list (e.g. created after login) prints
          // with a null label instead of failing the whole command
          if (row === undefined) {
            if (!changed) fail(1, `${kind.noun} ${x} not found`);
            return kind.field === "name" ? { id: x, name: null } : { id: x, title: null };
          }
          return kind.field === "name" ? { id: x, name: row.label } : { id: x, title: row.label };
        }),
      );
    });
}

export function registerMaintenance(program: Command): void {
  const maintenance = program.command("maintenance").description("Manage maintenance windows");

  maintenance
    .command("list")
    .description("List maintenance windows")
    .action(async () => {
      const s = await connect(["maintenanceList"]);
      printJson(
        s.maintenances().map((m) => ({
          id: m.id,
          title: m.title ?? null,
          strategy: m.strategy ?? null,
          active: m.active ?? null,
          status: m.status ?? null,
        })),
      );
    });

  maintenance
    .command("get <id>")
    .description("Show one maintenance window")
    .action(async (rawId) => {
      const id = parseId(rawId, "maintenance id");
      const s = await connect(["maintenanceList"]);
      // getMaintenance of an unknown id dies inside toJSON with a TypeError
      // message, so the pushed list is the clearer check.
      if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
      printJson(await fetchMaintenance(s, id));
    });

  maintenance
    .command("add")
    .description("Add a maintenance window")
    .addOption(
      new Option("--strategy <strategy>", "maintenance strategy")
        .choices([...STRATEGIES])
        .makeOptionMandatory(),
    )
    .requiredOption("--title <title>", "maintenance title")
    .option("--description <description>", "maintenance description")
    .option("--start <datetime>", "effective window start, local ISO 8601 (not for manual)")
    .option("--end <datetime>", "effective window end, local ISO 8601 (not for manual)")
    .option("--timezone <tz>", "timezone (IANA name or SAME_AS_SERVER)")
    .option("--paused", "create the maintenance paused")
    .option("--config-file <path>", "JSON file of maintenance fields")
    .action(async (opts) => {
      const strategy = opts.strategy as (typeof STRATEGIES)[number];
      const title = parseTitle(opts.title as string);
      const description = (opts.description as string | undefined) ?? "";
      if (strategy === "single" && (opts.start === undefined || opts.end === undefined)) {
        fail(2, "--strategy single requires --start and --end");
      }
      const range = parseDateRange(opts.start, opts.end);
      const timezoneOption =
        opts.timezone === undefined ? "SAME_AS_SERVER" : parseTimezone(opts.timezone);
      const active = opts.paused !== true;
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      if (fileConfig.id !== undefined) {
        fail(2, '--config-file cannot set "id"');
      }
      // The isAdd object of src/pages/EditMaintenance.vue (Kuma 1.23.17);
      // jsonToBean reads only the fields the strategy needs, dateRange must
      // always be an array. Precedence: defaults < typed flags < --config-file.
      const payload: Record<string, unknown> = {
        title,
        description,
        strategy,
        active,
        cron: "30 3 * * *",
        durationMinutes: 60,
        intervalDay: 1,
        dateRange: range ?? [],
        timeRange: [
          { hours: 2, minutes: 0 },
          { hours: 3, minutes: 0 },
        ],
        weekdays: [],
        daysOfMonth: [],
        timezoneOption,
        ...fileConfig,
      };
      // a --config-file strategy of manual overrides the flag's strategy, so
      // the merged value is what the manual rule judges
      if (range !== undefined && payload.strategy === "manual") {
        fail(2, "--start and --end do not apply to --strategy manual");
      }
      validateMaintenance(payload, { full: true });
      const s = await connect(["maintenanceList"]);
      const existing = s.maintenances().find((m) => m.title === payload.title);
      if (existing) {
        printJson({ id: existing.id, title: existing.title, skipped: true });
        fail(3, "");
      }
      const res = await s.request("addMaintenance", [payload]);
      const id = res?.maintenanceID;
      if (typeof id !== "number") fail(70, "unexpected addMaintenance response");
      printJson({ id, title: payload.title, strategy: payload.strategy, active: payload.active });
    });

  maintenance
    .command("edit <id>")
    .description("Edit a maintenance window")
    .option("--title <title>", "new title")
    .option("--description <description>", "new description")
    .option("--start <datetime>", "effective window start, local ISO 8601 (not for manual)")
    .option("--end <datetime>", "effective window end, local ISO 8601 (not for manual)")
    .option("--timezone <tz>", "timezone (IANA name or SAME_AS_SERVER)")
    .option("--set <key=value>", "set a field (repeatable)", collect, [])
    .option("--config-file <path>", "JSON file of maintenance fields")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "maintenance id");
      const sets = parseSets(opts.set as string[] | undefined);
      const fileConfig =
        opts.configFile === undefined ? {} : readJsonFile(opts.configFile, "--config-file");
      // The id selects the maintenance; a hatch id would redirect the edit.
      if (sets.id !== undefined) {
        fail(2, '--set cannot set "id"; the id selects the maintenance');
      }
      if (fileConfig.id !== undefined) {
        fail(2, '--config-file cannot set "id"; the id selects the maintenance');
      }
      const hasChange =
        opts.title !== undefined ||
        opts.description !== undefined ||
        opts.start !== undefined ||
        opts.end !== undefined ||
        opts.timezone !== undefined ||
        Object.keys(sets).length > 0 ||
        Object.keys(fileConfig).length > 0;
      if (!hasChange) {
        fail(
          2,
          "maintenance edit requires at least one of --title, --description, --start/--end, --timezone, --set or --config-file",
        );
      }
      const title = opts.title === undefined ? undefined : parseTitle(opts.title);
      // on edit each flag patches one end of the stored range: --start replaces
      // index 0, --end index 1, so either may be given alone
      const start = opts.start === undefined ? undefined : parseIsoDateTime(opts.start, "--start");
      const end = opts.end === undefined ? undefined : parseIsoDateTime(opts.end, "--end");
      if (start !== undefined && end !== undefined && compareLocalDateTimes(end, start) <= 0) {
        fail(2, "--end must be after --start");
      }
      const timezoneOption = opts.timezone === undefined ? undefined : parseTimezone(opts.timezone);
      const s = await connect(["maintenanceList"]);
      if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
      // editMaintenance runs jsonToBean, which overwrites every field it
      // reads, so the whole fetched object goes back with the changes merged.
      // Precedence: fetched < --config-file < --set < typed flags.
      const fetched = await fetchMaintenance(s, id);
      const merged: Record<string, unknown> = { ...fetched, ...fileConfig, ...sets };
      if (title !== undefined) merged.title = title;
      if (opts.description !== undefined) merged.description = opts.description;
      if (timezoneOption !== undefined) merged.timezoneOption = timezoneOption;
      // the strategy may itself have just changed through a hatch, so the
      // manual rule judges the merged value
      if ((start !== undefined || end !== undefined) && merged.strategy === "manual") {
        fail(2, "--start and --end do not apply to --strategy manual");
      }
      if (start !== undefined || end !== undefined) {
        const stored = Array.isArray(merged.dateRange) ? (merged.dateRange as unknown[]) : [];
        const next: unknown[] = [...stored];
        if (start !== undefined) next[0] = start;
        if (end !== undefined) {
          // --end alone only works when the range already has a start to keep
          if (typeof next[0] !== "string" || next[0] === "") {
            fail(2, "--end requires --start or a stored window start");
          }
          next[1] = end;
        }
        merged.dateRange = next;
      }
      const touched = new Set([...Object.keys(fileConfig), ...Object.keys(sets)]);
      if (title !== undefined) touched.add("title");
      if (opts.description !== undefined) touched.add("description");
      if (start !== undefined || end !== undefined) touched.add("dateRange");
      if (timezoneOption !== undefined) touched.add("timezoneOption");
      validateMaintenance(merged, {
        full: merged.strategy !== fetched.strategy,
        touched,
        edit: true,
      });
      await s.request("editMaintenance", [merged]);
      // Print what Kuma stored, like the UI does after its save.
      printJson(await fetchMaintenance(s, id));
    });

  for (const [name, event, active] of [
    ["pause", "pauseMaintenance", false],
    ["resume", "resumeMaintenance", true],
  ] as const) {
    maintenance
      .command(`${name} <id>`)
      .description(`${name} a maintenance window`)
      .action(async (rawId) => {
        const id = parseId(rawId, "maintenance id");
        const s = await connect(["maintenanceList"]);
        if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
        await s.request(event, [id]);
        printJson({ id, active });
      });
  }

  maintenance
    .command("delete <id>")
    .description("Delete a maintenance window")
    .option("--yes", "confirm deletion")
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "maintenance id");
      if (!opts.yes) fail(2, `would delete maintenance ${id}; pass --yes to delete`);
      const s = await connect(["maintenanceList"]);
      // deleteMaintenance answers ok even for an unknown id, so the pushed
      // list is the only check.
      if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
      await s.request("deleteMaintenance", [id]);
      printJson({ id, deleted: true });
    });

  registerAttach(maintenance, ATTACH_KINDS.monitor);
  registerAttach(maintenance, ATTACH_KINDS.statusPage);
}
