import { Option, type Command } from "commander";
import {
  compareLocalDateTimes,
  fail,
  hasOffsetDesignator,
  isLocalDateTime,
  parseId,
  parseSets,
  printJson,
  readJsonFile,
} from "../lib.ts";
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

function parseIsoDateTime(value: string, flag: string): string {
  if (hasOffsetDesignator(value)) {
    fail(
      2,
      `${flag} must be local time in the maintenance timezone without an offset, got "${value}"`,
    );
  }
  if (!isLocalDateTime(value)) {
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

function idListParts(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((part) => part.trim());
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

// The EditMaintenance.vue intervalDay input is capped at 3650; recurring-interval
// is tighter because generateCron emits "*/N" in day-of-month and croner 6.0.7
// rejects a step over 31.
const MAX_INTERVAL_DAY = 3650;

// Mirrors CronPattern.parse for croner 6.0.7 (Kuma 1.23) and 8.1.2 (Kuma
// 2.x): the shape check up to throwAtIllegalCharacters, then partToArray's
// numeric range and step checks. The majors differ in the day-of-week
// charset (croner 8 also allows "#" and "L"), the day-of-week bitmap length
// (8 on 6, 7 on 8), whether a day-of-week "L" is stripped or parsed, and
// whether an empty comma entry or a day/month step start of 0 throws, so the
// checks run per version. Kuma 1.23.17 calls the async validateCron without
// await, so a bad expression is stored anyway and the rejection goes
// unhandled — on 1.x only the CLI's check can refuse a bad pattern before it
// is stored; on 2.x validateCron is synchronous, so the check also mirrors
// what the server would refuse.
const CRON_NICKNAMES = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

const CRON_LEGAL = /^[0-9*,/-]*$/;

// croner 8.1.2's throwAtIllegalCharacters gives the day-of-week part the
// wider charset [^/*0-9,\-#L]+ so "#" nth-weekday and "L" last-weekday forms
// parse; every other part keeps the 6.0.7 charset.
const CRON_LEGAL_DOW_2X = /^[0-9*,/#L-]*$/;

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

// croner 6.0.7 and 8.1.2
type CronMajor = "6" | "8";

// partToArray's per-field bounds: the config value range and the bitmap
// length a step is capped by. day-of-week's bitmap is 8 on croner 6 (index 7
// also means Sunday) and 7 on croner 8; the value range 0-7 is the same on
// both, so only the step cap differs.
const CRON_PART_LIMITS = [
  { min: 0, max: 59, size: 60 }, // second
  { min: 0, max: 59, size: 60 }, // minute
  { min: 0, max: 23, size: 24 }, // hour
  { min: 1, max: 31, size: 31 }, // day of month
  { min: 1, max: 12, size: 12 }, // month
  { min: 0, max: 7, size: 8 }, // day of week
] as const;

// croner substitutes "?" with the field's current value at run time, so a
// compound entry is only checkable where every possible value gives the
// same verdict: a whole "?" entry, a step start ("?/5" — the current value
// always sits inside the field's range), a day-of-week "?L" or "?#n" (the
// rest side always parses), and a step value ("5/?") on day-of-month or
// month only, where the current value can never be 0 so the step stays in
// 1..size. A "?" in a range bound or a "#" nth flips the verdict with the
// clock, so those are refused.
function questionOk(entry: string, partIndex: number, version: CronMajor): boolean {
  if (!entry.includes("?")) return true;
  let rest = entry;
  if (version === "8" && partIndex === 5) {
    const seg = entry.split("#");
    rest = seg[0]!;
    if (seg[1]?.includes("?") === true) return false;
  }
  return (
    rest === "?" ||
    rest === "?L" ||
    /^\?\/\d+$/.test(rest) ||
    ((partIndex === 3 || partIndex === 4) && rest.endsWith("/?"))
  );
}

// parse's transforms up to throwAtIllegalCharacters: a nickname expands
// first, the pattern splits on whitespace into 5 or 6 parts (5 gets a
// leading seconds "0"), the first "L" is stripped from day-of-month, month
// and day-of-week parts of 3+ chars get the JAN-DEC / SUN-SAT names
// replaced, the first "?" of each part becomes a number, and what remains
// may only contain [0-9*/,-] — plus "#" and "L" in day-of-week on croner 8.
// Returns null where parse throws; an empty part or a bare day-of-week "L"
// is refused too since the field stays all-zero and the window never runs
// (croner 8 throws anyway). At most one "?" per part, as in croner.
function cronParts(
  value: string,
  version: CronMajor,
): { parts: string[]; lastDay: boolean } | null {
  let pattern = value;
  if (pattern.includes("@")) {
    pattern = (CRON_NICKNAMES.get(pattern.trim().toLowerCase()) ?? pattern).trim();
  }
  const fields = pattern.replace(/\s+/g, " ").split(" ");
  if (fields.length !== 5 && fields.length !== 6) return null;
  if (fields.includes("")) return null;
  const [second, minute, hour, day, month, dayOfWeek] = (
    fields.length === 5 ? ["0", ...fields] : fields
  ) as [string, string, string, string, string, string];
  const lastDay = day.includes("L");
  const dom = day.replace("L", "");
  // croner 6 strips a day-of-week "L"; croner 8 keeps it, where "5L" parses
  // as 5 and a bare "L" throws on parseInt — both end up refused either way
  const dow = version === "6" ? dayOfWeek.replace("L", "") : dayOfWeek;
  if (dow === "") return null;
  const raw = [
    second,
    minute,
    hour,
    dom,
    month.length >= 3 ? alphaMonths(month) : month,
    dow.length >= 3 ? alphaDays(dow) : dow,
  ];
  const parts: string[] = [];
  for (const [i, part] of raw.entries()) {
    const q = part.indexOf("?");
    if (q !== -1) {
      if (part.indexOf("?", q + 1) !== -1) return null;
      if (!part.split(",").every((entry) => questionOk(entry, i, version))) return null;
    }
    parts.push(q === -1 ? part : part.replace("?", String(CRON_PART_LIMITS[i]!.min)));
  }
  const ok = parts.every((part, i) =>
    (i === 5 && version === "8" ? CRON_LEGAL_DOW_2X : CRON_LEGAL).test(part),
  );
  return ok ? { parts, lastDay } : null;
}

// partToArray's reject rules for one comma-separated entry, applied per
// croner major: an empty entry is silently skipped on 6 but throws on 8
// (unless the day-of-month part carried "L"); a step or range step over the
// bitmap length and a step of 0 throw on both; a range bound outside the
// value range or a lower bound above the upper throws on both. croner 8's
// extractNth allows "#" in day-of-week only, with an nth of 1-5 or "L", and
// offsets the step start so a day/month start of 0 throws in setPart;
// croner 6 never checks the step start, so a start past the bitmap end just
// schedules nothing and stays accepted, matching the server.
function cronEntryOk(
  entry: string,
  partIndex: number,
  version: CronMajor,
  lastDay: boolean,
): boolean {
  const { min, max, size } = CRON_PART_LIMITS[partIndex]!;
  const fieldSize = partIndex === 5 && version === "8" ? 7 : size;
  if (entry === "") return version === "6" || (partIndex === 3 && lastDay);
  if (entry === "*") return true;

  let rest = entry;
  if (version === "8" && partIndex === 5 && rest.includes("#")) {
    const seg = rest.split("#");
    rest = seg[0]!;
    // setNthWeekdayOfMonth takes "L" or a numeric 1-5 (so "05" counts); an
    // empty nth falls back to the default "any occurrence" bitmask
    const nth = seg[1]!;
    if (nth !== "" && nth !== "L" && (!/^\d+$/.test(nth) || Number(nth) < 1 || Number(nth) > 5)) {
      return false;
    }
  }
  const num = (s: string): number => Number.parseInt(s, 10);
  const inRange = (n: number) => n >= min && n <= max;

  // partToArray picks the handler on the untouched conf — "-" inside a
  // day-of-week "#" nth still routes into the range or stepping handler,
  // where it breaks the rest-only parse the same way it breaks croner's
  if (entry.includes("-") && entry.includes("/")) {
    const m = /^(\d+)-(\d+)\/(\d+)$/.exec(rest);
    if (m === null) return false;
    const lower = num(m[1]!);
    const upper = num(m[2]!);
    const steps = num(m[3]!);
    if (steps === 0 || steps > fieldSize || !inRange(lower) || lower > upper) return false;
    // croner 8 only checks the values the steps land on — an upper bound
    // past the end of the field is fine while no step reaches it; croner 6
    // throws "Value out of range" on the bound itself
    if (version === "8") return lower + Math.floor((upper - lower) / steps) * steps <= max;
    return inRange(upper);
  }
  if (entry.includes("-")) {
    const seg = rest.split("-");
    if (seg.length !== 2) return false;
    const lower = num(seg[0]!);
    const upper = num(seg[1]!);
    return inRange(lower) && inRange(upper) && lower <= upper;
  }
  if (entry.includes("/")) {
    const seg = rest.split("/");
    if (seg.length !== 2) return false;
    const steps = num(seg[1]!);
    if (Number.isNaN(steps) || steps === 0 || steps > fieldSize) return false;
    return version !== "8" || seg[0] === "*" || seg[0] === "" || num(seg[0]!) >= min;
  }
  return inRange(num(rest));
}

// "either" is the pre-connect union — refuse only what both croners refuse,
// so a 1.x server never stores what its unawaited validateCron would throw
// on, while 2.x-only forms still reach a 2.x server.
function isCronExpression(value: string, version: CronMajor | "either"): boolean {
  if (version === "either") {
    return isCronExpression(value, "6") || isCronExpression(value, "8");
  }
  const shape = cronParts(value, version);
  if (shape === null) return false;
  return shape.parts.every((part, i) => {
    const entries = part.split(",");
    // a part whose comma entries are all empty leaves the field all-zero on
    // croner 6 — the window never runs — while croner 8 throws; the
    // day-of-month "L" flag is the one empty part that still schedules
    if (entries.every((entry) => entry === "") && !(i === 3 && shape.lastDay)) {
      return false;
    }
    return entries.every((entry) => cronEntryOk(entry, i, version, shape.lastDay));
  });
}

// Maintenance.jsonToBean writes title, description, strategy, intervalDay,
// timezoneOption, active and dateRange unconditionally, then the schedule
// fields of the strategy: cron + durationMinutes for cron, timeRange +
// weekdays + daysOfMonth for recurring-* (generateCron also reads intervalDay
// for recurring-interval). Checking the merged object keeps a missing or
// malformed field from failing inside Kuma. kuma2 selects the server's cron
// grammar and bounds; the rules that differ are the croner major (6 on 1.x,
// 8 on 2.x), the recurring-interval intervalDay cap (31 on 1.x because
// generateCron emits "*/N" in day-of-month, 3650 on 2.x where the interval is
// gated by last_start_date instead) and the cron/recurring end-date refusal
// (a 1.23.17 run() bug 2.x's inferDuration does not have).
// full judges every field (add, or an edit that changes strategy); otherwise
// only the touched keys plus the always-read dateRange are judged, the same
// scoping monitors edit uses for its touched/typeChanged rule.
function validateMaintenance(
  m: Record<string, unknown>,
  opts: {
    full: boolean;
    touched?: ReadonlySet<string>;
    edit?: boolean;
    kuma2: boolean | "unknown";
  },
): void {
  const need = (key: string) => opts.full || opts.touched?.has(key) === true;
  if (!Array.isArray(m.dateRange)) fail(2, "dateRange must be an array");
  if (need("dateRange") && Array.isArray(m.dateRange)) {
    // jsonToBean stores start/end verbatim and getStatus / the single-window
    // job read them as local time in timezoneOption, so offsets are refused
    // here the same way the flags refuse them. null means "no bound".
    for (const v of m.dateRange as unknown[]) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && hasOffsetDesignator(v)) {
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
    // recurring-interval feeds interval_day into "*/N" in day-of-month where
    // croner 6.0.7 rejects steps over 31; on 2.x generateCron emits a plain
    // daily cron and the interval is gated by last_start_date, so the cap is
    // the UI's 3650. The other strategies only store it, so null stays
    // acceptable there
    const required = strategy === "recurring-interval";
    const cap = required && opts.kuma2 === false ? 31 : MAX_INTERVAL_DAY;
    const v = m.intervalDay;
    const ok = required
      ? isPosInt(v) && v <= cap
      : v === null || v === undefined || (isPosInt(v) && v <= MAX_INTERVAL_DAY);
    if (!ok) {
      fail(
        2,
        `intervalDay must be a positive integer no greater than ${
          required ? `${cap} for recurring-interval` : MAX_INTERVAL_DAY
        }`,
      );
    }
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
      const cronVersion = opts.kuma2 === "unknown" ? "either" : opts.kuma2 ? "8" : "6";
      if (!isCronExpression(cron, cronVersion)) {
        fail(
          2,
          'strategy "cron" requires "cron" as 5 or 6 whitespace-separated cron fields with in-range values and steps',
        );
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
  // strategies may carry a start but never an end on 1.x; 2.x's inferDuration
  // falls back to duration * 1000, so the end date is valid there.
  if (
    opts.kuma2 === false &&
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
              'when "dateRange" has an end date; drop the end (a stored one with ' +
              "--set 'dateRange=[\"<start>\"]', local time)"
          : `Kuma 1.23.17 ends a "${strategy}" maintenance immediately ` +
              'when "dateRange" has an end date; give only a start',
      );
    }
  }
  // On 2.x a cron/recurring window may carry both ends, and Kuma stores an
  // end before the start without complaint — the window would sit scheduled
  // then ended and never run. Judge the merged range's ordering like single's
  // whenever dateRange is judged; on 1.x the refusal above already rejects
  // any end, so only the 2.x path needs it.
  if (
    opts.kuma2 !== false &&
    strategy !== undefined &&
    (strategy === "cron" || strategy.startsWith("recurring-")) &&
    need("dateRange")
  ) {
    const range = m.dateRange as unknown[];
    const start = range[0];
    const end = range[1];
    if (isLocalDateTime(start) && isLocalDateTime(end) && compareLocalDateTimes(end, start) <= 0) {
      fail(2, '"dateRange" end must be after start');
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
  // Monitor targets also take exact names; status pages stay id-only.
  const named = kind === ATTACH_KINDS.monitor;
  const targetArg = named ? "<id|name>" : "<id>";
  const targetRef = named ? "id or name" : "id";
  maintenance
    .command(`${kind.command} <id>`)
    .description(`Show or change the ${kind.noun}s a maintenance window affects`)
    .option(
      "--set-ids <ids>",
      `replace the set with these ${named ? "monitor ids or names" : "ids"} (comma-separated)`,
    )
    .option(`--add ${targetArg}`, `attach a ${kind.noun} ${targetRef} (repeatable)`, collect, [])
    .option(`--remove ${targetArg}`, `detach a ${kind.noun} ${targetRef} (repeatable)`, collect, [])
    .action(async (rawId, opts) => {
      const id = parseId(rawId, "maintenance id");
      const setIdsRaw = opts.setIds as string | undefined;
      const addRaw = (opts.add as string[] | undefined) ?? [];
      const removeRaw = (opts.remove as string[] | undefined) ?? [];
      // Status-page targets are ids only, so they keep the pre-connect
      // validation they always had; monitor targets may be names, which
      // resolve against monitorList after connect.
      if (!named) {
        for (const v of addRaw) parseId(v, "--add");
        for (const v of removeRaw) parseId(v, "--remove");
        if (setIdsRaw !== undefined) {
          for (const v of idListParts(setIdsRaw)) parseId(v, "--set-ids");
        }
      }
      if (setIdsRaw !== undefined && (addRaw.length > 0 || removeRaw.length > 0)) {
        fail(2, "--set-ids cannot be combined with --add or --remove");
      }
      const s = await connect(kind.extraLists);
      if (!s.maintenanceById(id)) fail(1, `maintenance ${id} not found`);
      // Monitor targets may be exact names from monitorList; status pages
      // stay id-only — the CLI addresses them by slug everywhere else.
      const targetId = (raw: string, flag: string): number =>
        named ? s.resolveMonitorId(raw) : parseId(raw, flag);
      const addIds = addRaw.map((v) => targetId(v, "--add"));
      const removeIds = removeRaw.map((v) => targetId(v, "--remove"));
      const setIds =
        setIdsRaw === undefined
          ? undefined
          : [...new Set(idListParts(setIdsRaw).map((v) => targetId(v, "--set-ids")))];
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
      // single needs both bounds however they arrive — --start/--end or a
      // --config-file dateRange — judged on the merged strategy and range
      const rangePair = Array.isArray(payload.dateRange) && payload.dateRange.length >= 2;
      if (
        payload.strategy === "single" &&
        (opts.start === undefined || opts.end === undefined) &&
        !rangePair
      ) {
        fail(2, "--strategy single requires --start and --end");
      }
      // a --config-file strategy of manual overrides the flag's strategy, so
      // the merged value is what the manual rule judges
      if (range !== undefined && payload.strategy === "manual") {
        fail(2, "--start and --end do not apply to --strategy manual");
      }
      // Before connecting the version is unknown, so the check applies the
      // union of both versions' rules — the 2.x set for the non-cron fields
      // and either croner's grammar for cron, whose accepted forms differ.
      // Once connected the same check runs again under the server's own
      // version, adding the other version's restrictions back.
      validateMaintenance(payload, { full: true, kuma2: "unknown" });
      const s = await connect(["maintenanceList"]);
      validateMaintenance(payload, { full: true, kuma2: s.majorVersion >= 2 });
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
      // an unknown strategy is refused before connecting; the post-fetch
      // validateMaintenance still judges the effective merged value
      for (const candidate of [fileConfig.strategy, sets.strategy]) {
        if (
          candidate !== undefined &&
          !(STRATEGIES as readonly string[]).includes(String(candidate))
        ) {
          fail(2, `unknown maintenance strategy "${String(candidate)}"`);
        }
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
        kuma2: s.majorVersion >= 2,
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
