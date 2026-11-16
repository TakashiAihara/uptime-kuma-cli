// Measures the name list KUMA_2X_TIMEZONES in src/timezones.ts. Run it inside
// the Kuma 2.x image so the check is Kuma's own dayjs and ICU; @vvo/tzdb
// (the package util-frontend.js's timezoneList() uses) is already in the
// image's node_modules:
//
//   docker run --rm -v "$PWD/scripts:/chk/scripts:ro" \
//     --entrypoint node louislam/uptime-kuma:2.5.11 /chk/scripts/kuma-timezones-2x.js
//
// It prints { node, icu, listed, accepted, refused } as JSON, where listed is
// the size of the @vvo/tzdb list and accepted/refused also count the leading
// "UTC". accepted is what KUMA_2X_TIMEZONES holds; paste it there by hand.
const dayjs = require("/app/node_modules/dayjs");
dayjs.extend(require("/app/node_modules/dayjs/plugin/utc"));
dayjs.extend(require("/app/node_modules/dayjs/plugin/timezone"));
const { getTimeZones } = require("/app/node_modules/@vvo/tzdb");

const names = getTimeZones().map((t) => t.name);
const accepted = [];
const refused = [];
for (const name of ["UTC", ...names]) {
  // the same call as Kuma's UptimeKumaServer.checkTimezone
  try {
    dayjs.utc("2013-11-18 11:55").tz(name).format();
    accepted.push(name);
  } catch {
    refused.push(name);
  }
}

console.log(
  JSON.stringify({
    node: process.version,
    icu: process.versions.icu,
    listed: names.length,
    accepted,
    refused,
  }),
);
