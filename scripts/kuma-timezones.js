// Measures the name list in src/timezones.ts. Run it inside the Kuma image
// so the check is Kuma's own dayjs and ICU, with timezones-list 3.0.3 (the
// package General.vue uses) unpacked at /chk/timezones-list:
//
//   TL=$(mktemp -d) && curl -fsSL https://registry.npmjs.org/timezones-list/-/timezones-list-3.0.3.tgz | tar -xz -C "$TL"
//   docker run --rm -v "$TL/package:/chk/timezones-list:ro" -v "$PWD/scripts:/chk/scripts:ro" \
//     --entrypoint node louislam/uptime-kuma:1.23.17 /chk/scripts/kuma-timezones.js
//
// It prints { node, icu, listed, accepted, refused } as JSON, where listed is
// the size of the UI list and accepted/refused also count the leading "UTC".
// accepted is what src/timezones.ts holds; paste it there by hand.
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
    listed: names.length,
    accepted,
    refused,
  }),
);
