// Regenerates the name list in src/timezones.ts. Run it inside the Kuma image
// so the check is Kuma's own dayjs and ICU, with timezones-list 3.0.3 (the
// package General.vue uses) unpacked at /chk/timezones-list:
//
//   mkdir -p tl && curl -fsSL https://registry.npmjs.org/timezones-list/-/timezones-list-3.0.3.tgz | tar -xz -C tl
//   docker run --rm -v "$PWD/tl/package:/chk/timezones-list:ro" -v "$PWD/scripts:/chk/scripts:ro" \
//     --entrypoint node louislam/uptime-kuma:1.23.17 /chk/scripts/kuma-timezones.js
//
// It prints { node, icu, total, accepted, refused } as JSON; accepted is the list.
const dayjs = require("/app/node_modules/dayjs");
dayjs.extend(require("/app/node_modules/dayjs/plugin/utc"));
dayjs.extend(require("/app/node_modules/dayjs/plugin/timezone"));
const list = require("/chk/timezones-list/dist/timezones.json");

const names = list.map((t) => t.tzCode);
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
    total: names.length,
    accepted,
    refused,
  }),
);
