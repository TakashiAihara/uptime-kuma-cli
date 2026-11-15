# uptime-kuma-cli design

## Goal

- Operate an Uptime Kuma 1.23 instance from the shell and from agents without writing ad hoc `uptime-kuma-api` scripts
- Cover what existing CLIs lack: proxies, notification tests, and status changes (important heartbeats)

## Why not an existing CLI

- BigBoot/AutoKuma `kuma` (Rust): monitors and notifications via JSON files; no beats, no status changes, no proxies, no notification test; targets Kuma v2 by default since 2.0.0
- pablofmorales/kuma-cli (TypeScript): monitors and beats, but no proxies, no notification edit/test, no keyword / json-query fields, and it stores the login token in its config file

## Transport

- Socket.IO v4 client (`socket.io-client`) against the Kuma base URL, `transports: ["websocket"]`
- Kuma 1.23 has no OpenAPI / REST API for management (only badge, push, status page and metrics are REST), so the CLI talks Socket.IO
- Log in with `login` `{ username, password, token: "" }`; the callback returns `{ ok, msg }`
- After login the server pushes `monitorList` (object keyed by id), `notificationList` (array), `proxyList` (array), `dockerHostList` (array), then one `heartbeatList (monitorID, beats)` and one `importantHeartbeatList (monitorID, beats)` per monitor. There is no pushed tag list: each monitor's `tags` is the `monitor_tag`⋈`tag` join (`{ id, monitor_id, tag_id, value, name, color }`, ordered by tag name) and the tag table itself is only readable through `getTags`
- Request events used, all with a trailing callback returning `{ ok, msg, ... }`:
    - `add (monitor)` → `monitorID`
    - `editMonitor (monitor)` → `monitorID`
    - `getMonitor (id)` → `monitor`
    - `pauseMonitor (id)` / `resumeMonitor (id)`
    - `getMonitorBeats (id, hours)` → `data` (oldest first, raw heartbeat rows with `important`)
    - `addNotification (notification, idOrNull)` → `id`; the server stores the whole object as the `config` JSON string
    - `testNotification (notification)` → `msg`
    - `addProxy (proxy, idOrNull)` → `id`
    - `deleteMonitor (id)` / `deleteNotification (id)` / `deleteProxy (id)`
    - `getTags ()` → `tags` (`{ id, name, color }` rows)
    - `addTag ({ name, color })` → `tag`; `editTag ({ id, name, color })` → `tag` (overwrites both fields, `ok:false "Tag not found"` for an unknown id); `deleteTag (id)` answers ok even for an unknown id
    - `addMonitorTag (tagID, monitorID, value)` / `editMonitorTag (tagID, monitorID, value)` / `deleteMonitorTag (tagID, monitorID, value)`; none of them pushes `monitorList` again, so the CLI's pushed copy goes stale within a run (each command logs in once, so the next run sees the new state)
- A request whose callback has `ok: false` exits 1 with `msg` on stderr

## Configuration

- `$XDG_CONFIG_HOME/uptime-kuma-cli/config.toml` (or `~/.config/uptime-kuma-cli/config.toml`)
    - `url`, `username_command`, `password_command`
- `*_command` runs with `sh -c`; the first stdout line, minus a trailing `\r`, is the secret (spaces are kept). An env value takes precedence and the command does not run
- Accounts with 2FA are not supported: Kuma answers `tokenRequired` and the CLI exits 2
- Each command logs in once. Kuma limits logins to 20 per minute for the whole instance, so a loop of many commands can lock out the UI login for a while
- With an `http://` URL the login travels in clear text; use `https://` when the path leaves a trusted network
- Env: `UPTIME_KUMA_URL`, `UPTIME_KUMA_USERNAME`, `UPTIME_KUMA_PASSWORD`, `UPTIME_KUMA_TIMEOUT` (seconds, default 30, for connect + login + each request), `UPTIME_KUMA_COMMAND_TIMEOUT` (seconds, default 60)
- The username command does not see the password and vice versa

## Output

- stdout is JSON (pretty, 2-space indent), stderr is for messages
- `notificationIDList` is always printed as a sorted array of numbers, whether Kuma sent `{ "3": true }` or `[3]`
- Monitor `tags` print as `[{ tagId, name, value }]`, normalized from the `monitor_tag`⋈`tag` join rows Kuma sends
- Notification configs and proxy passwords are never printed
- Monitor fields that hold secrets (`basic_auth_pass`, `oauth_client_secret`, `tlsKey`, `headers`, `body`, `grpcBody`, `grpcMetadata`, `mqttPassword`, `radiusPassword`, `radiusSecret`, `databaseConnectionString`, and every `kafkaProducerSaslOptions` value other than `mechanism` / `username` / `awsRegion` / `accessKeyId`) print as `"***"` when non-empty; `pushToken` stays visible because pushers need it
- A password inside a monitor `url` (`https://user:pass@host/`) prints as `***` in `monitors list` / `get` / `edit`

## Exit codes

| code | meaning |
|---|---|
| 0 | done |
| 1 | Kuma answered no (`ok: false`, unknown id) |
| 2 | configuration, usage (including a missing subcommand), connection, login, disconnect, or timeout failure |
| 3 | a create or attach was skipped because it already exists (`monitors add` / `tags add` same name, `monitors tag` same tag+value) |
| 70 | unexpected error |

## Commands

### monitors

- `monitors list [--name <substring>] [--tag <name>]`
    - array sorted by id of `{ id, name, type, active, url, hostname, port, interval, parent, notificationIDList, tags }`; `tags` is `[{ tagId, name, value }]` from the monitor's `monitor_tag`⋈`tag` join
    - `--name` filters case-insensitively; `--tag` keeps monitors that have a tag whose name equals the argument exactly (case-sensitive); the two combine
- `monitors get <id>`: the monitor object from `monitorList` with `notificationIDList` as an array and `tags` as `[{ tagId, name, value }]`; unknown id exits 1
- `monitors add --type <group|http|port|ping|keyword|json-query|grpc-keyword|dns|docker|real-browser|push|steam|gamedig|mqtt|kafka-producer|sqlserver|postgres|mysql|mongodb|radius|redis|tailscale-ping> --name <name> [options]` (picker order of EditMonitor.vue)
    - options: `--url`, `--hostname`, `--port`, `--keyword`, `--invert-keyword`, `--json-path`, `--expected-value`, `--packet-size`, `--dns-resolve-server`, `--dns-resolve-type`, `--docker-container`, `--docker-host`, `--game`, `--grpc-url`, `--grpc-service-name`, `--grpc-method`, `--grpc-protobuf <file>`, `--grpc-enable-tls`, `--mqtt-topic`, `--mqtt-username`, `--mqtt-success-message`, `--kafka-producer-broker <host:port>` (repeatable), `--kafka-producer-topic`, `--kafka-producer-message`, `--kafka-producer-ssl`, `--kafka-producer-allow-auto-topic-creation`, `--radius-username`, `--radius-called-station-id`, `--radius-calling-station-id`, `--database-query <sql>`, `--interval <s>` (60), `--retry-interval <s>`, `--max-retries <n>` (0), `--resend-interval <n>` (0), `--timeout <s>` (positive; the timing rule is below), `--proxy-id <id>`, `--notification-id <id>` (repeatable), `--notifications-from <monitorId>`, `--parent <groupId>`, `--paused`, `--push-token <token>`, `--tag <tagId[:value]>` (repeatable), `--set <key>=<value>` (repeatable), `--config-file <json>`
    - required per type: http / keyword / json-query / real-browser need `--url`; keyword and grpc-keyword need `--keyword`; json-query needs `--json-path` and `--expected-value`; grpc-keyword also needs `--grpc-url`, `--grpc-service-name`, `--grpc-method` and `--grpc-protobuf` (Kuma 1.23.17 always runs `protojs.parse` on the proto and `JSON.parse` on `grpcBody` at check time, so the proto cannot be empty); port / steam / gamedig need `--hostname` and `--port`; ping / dns / tailscale-ping / radius need `--hostname`; mqtt needs `--hostname`, `--port` and `--mqtt-topic`; kafka-producer needs `--kafka-producer-broker` (each a `host:port` string), `--kafka-producer-topic` and `--kafka-producer-message`; radius also needs `--radius-username`, `--radius-called-station-id` and `--radius-calling-station-id` — its secrets `radiusPassword` / `radiusSecret` can only come from `--config-file` and are checked on the merged monitor; docker needs `--docker-container` and `--docker-host <docker host id>`; gamedig also needs `--game`; sqlserver / postgres / mysql / mongodb / redis need `databaseConnectionString` — a secret that only `--config-file` can supply (`--set` refuses it), so a missing or empty one exits 2 on the merged monitor after connecting, with a message naming the field; mysql's optional password is `radiusPassword`, also `--config-file` only. Missing flag values exit 2 before connecting
    - type-specific defaults: ping `--packet-size` (56); dns `--port` (53) and radius `--port` (1812), both from the UI's type watcher; gamedig sends `gamedigGivenPortOnly: true`; `--grpc-protobuf` reads the proto file and sends its content like the UI textarea; grpc-keyword sends `grpcBody: "{}"` unless `--config-file` overrides it (Kuma 1.23.17 JSON.parses it at check time and protobufjs rejects a null request); `--invert-keyword` applies to keyword and grpc-keyword; `--database-query` is sent only for sqlserver / postgres / mysql — on the other types it is ignored like every type-specific flag. The database types get no `databaseConnectionString` default: the UI's type watcher would prefill a template such as `postgres://username:password@host:port/database`, the CLI sends nothing. The CLI does not check an mqtt `mqttTopic`; Kuma 1.23.17 compares the received topic with `===`, so a wildcard like `sensors/#` never matches and the monitor times out
    - `--set` / `--config-file` are the escape hatch for fields without a dedicated flag: the value parses as JSON when it parses, else stays a string. Every key must be a monitor field the `add` event accepts (the `MONITOR_ADD_FIELDS` set in `src/kuma.ts`; the test fake keeps its own copy of the accepted columns); `id`, `type` and `name` are refused (use `--type` / `--name`), and an unknown key exits 2 naming it before connecting. Precedence: UI defaults < typed flags < `--config-file` < `--set`
    - a hatch key that has a typed flag goes through the flag's validation (`interval`, `retryInterval`, `resendInterval`, `maxretries`, `timeout`, `port`, `packetSize`, `dns_resolve_type`, `proxyId`, `parent`, `docker_host`), and `accepted_statuscodes` must be an array of strings, `kafkaProducerBrokers` an array of `host:port` strings — the `host:port` rule is the CLI's, the 1.23.17 UI does not check it, but kafkajs splits each broker on `:` so a host containing `:` cannot work — and `kafkaProducerSaslOptions` an object whose `mechanism` is one of the UI's values (`None`, `plain`, `scram-sha-256`, `scram-sha-512`, `aws`); invalid exits 2 naming the key before connecting, and valid values are coerced to the flag's type
    - secret fields (`basic_auth_pass`, `oauth_client_secret`, `tlsKey`, `headers`, `body`, `grpcBody`, `grpcMetadata`, `mqttPassword`, `radiusPassword`, `radiusSecret`, `databaseConnectionString`, `kafkaProducerSaslOptions`) are refused in `--set` — exit 2 pointing at `--config-file` — so they stay out of argv; `--config-file` accepts them
    - like the UI, notifications marked default are always attached, and every type except port / push gets the default proxy unless `--proxy-id` is given (the UI assigns it on add for all types; only the proxy picker is limited to http / keyword / json-query)
    - `--parent <groupId>` must be an existing monitor of type `group` in the pushed `monitorList`; an unknown id or a non-group exits 1. The parent value is normalized before sending — a numeric string becomes a number, an empty string exits 2, `null` clears — and the group check runs on the final merged value whichever source set it. `--parent` cannot be combined with a `parent` key in `--set` / `--config-file` — that exits 2 (`use either --parent or a parent key, not both`); between the two hatch sources `--set` still wins
    - `--docker-host` and a hatch `docker_host` must name an id in the pushed `dockerHostList`; an unknown id exits 1 (`docker host <id> not found`) before `add` is sent. For `--type docker` a hatch `docker_host: null` overrides the flag's host, so the monitor would have none — exit 2 naming the hatch source (`--set docker_host must be a docker host id`)
    - same name (exact match) already present: print `{ id, name, skipped: true }` and exit 3 without sending `add`
    - the payload starts from the Kuma 1.23 UI defaults (`accepted_statuscodes: ["200-299"]`, `method: "GET"`, `maxredirects: 10`, `kafkaProducerBrokers: []`, `kafkaProducerSaslOptions: { mechanism: "None" }`, ...) and sends `notificationIDList` as `{ "<id>": true }`
    - `--notifications-from` copies that monitor's notifications; `--notification-id` adds to them (both on top of the defaults)
    - timing: `interval` must be 20–2073600 seconds — the bounds Kuma 1.23.17 `Monitor.validate()` enforces before storing, so the CLI checks a user-supplied value (flag or hatch) against them up front. `retryInterval` defaults to the interval and `timeout` defaults to 48, both computed from the final interval after `--config-file` / `--set`. An explicit `retryInterval` or `timeout` from any source is kept, except that `timeout` never exceeds 80% of the final interval — a larger explicit value is capped to it (the same rule the flags always had). `timeout` must be positive: Kuma 1.23.17 `monitor.js` replaces a timeout of 0 (or less) with `interval * 1000 * 0.8` at check time and then multiplies by 1000 for axios, so 0 would silently become a timeout of interval × 800 seconds — the CLI refuses it with exit 2
    - push: `pushToken` precedence is generated default < `--push-token` < `--config-file` < `--set`; a random 32-char token is generated only when none of the three is given. The merged value must be a non-empty string — anything else exits 2 — and it is what gets sent and printed
    - `--paused` sends `active: false`, so Kuma does not start the monitor
    - `--tag <tagId[:value]>` attaches tags after `add` succeeds: each id must exist in `getTags` (exit 1 before `add` is sent), the value defaults to `""` and may contain colons. `addMonitorTag` is sent per tag; if one fails after the monitor was created the command exits 1 and the printed object lists the tags attached so far — the monitor exists
    - prints `{ id, name, type, active }`, `tags` (`[{ tagId, name, value }]`, only when `--tag` was given), plus `pushToken` and `pushUrl` (`<base>/api/push/<token>?status=up&msg=OK&ping=`, where base is the Primary Base URL setting when set, else the CLI url) for push
- `monitors edit <id> [--set <key>=<value>...] [--config-file <json>] [--parent <groupId|none>]`
    - fetches the monitor with `getMonitor`, merges `--config-file`, then `--set` over it, applies `--parent`, and sends `editMonitor`; at least one of the three is required. `--parent` cannot be combined with a `parent` key in `--set` / `--config-file` — that exits 2 (`use either --parent or a parent key, not both`); between the two hatch sources `--set` still wins
    - same field and value validation as add: every key must be a monitor field, `id` exits 2, hatch values for typed-flag keys go through the flag's validation (`type` included — it must be one of the picker types), and secret fields are refused in `--set` and accepted in `--config-file`. Unlike add, `name` and `type` may be set here
    - `notificationIDList` accepts an array or an object of positive integer ids and is sent as an object (Kuma 1.23 iterates it with `for...in`, so an array would be stored as its indexes)
    - the parent checks run on the final merged value whichever source set it: a `parent` from `--set`, `--config-file` or `--parent` naming the monitor itself exits 2 — Kuma 1.23 rejects only descendants, and a self-parent makes its parent walk loop forever
    - a parent value is normalized before sending (a numeric string becomes a number, an empty string exits 2, `null` clears), and the final value must be an existing monitor of type `group` in the pushed `monitorList` — exit 1 otherwise, including a `--set parent`; `--parent none` sends `parent: null` to clear it
    - `docker_host` and `proxyId` are checked against the pushed `dockerHostList` / `proxyList` when the edit sets them (see the shared validation note below)
    - for a push monitor a `pushToken` the edit sets must be a non-empty string — anything else exits 2 before `editMonitor` is sent
    - `retryInterval` / `timeout` derive from the interval only when the edit touches `interval` or `timeout`; a stored `timeout: 0` is otherwise sent back untouched even though Kuma 1.23.17 runs it as interval × 800 seconds on HTTP checks. The UI may legitimately store `timeout: 0`, a deleted docker host as `docker_host: null`, `proxyId: 0` or `port: 0`
    - a `type` change keeps the stored fields the new type shares: editing a `radius` monitor to `mysql` keeps the stored `radiusPassword`, which Kuma 1.23.17 reads as the MySQL password — the UI stores both in that one field
    - prints the monitor as Kuma saved it (fetched again with `getMonitor`), redacted and with `tags` normalized as in `monitors get`; Kuma ignores some fields here (`active`), and this shows it
- `add` and `edit` both run `validateFinalMonitor` on the merged monitor right before sending, but with different scope. On `add` the whole monitor is judged: the per-type required fields must be present (`url`, `keyword`, `jsonPath` + `expectedValue`, `grpcUrl` + `grpcServiceName` + `grpcMethod` + `grpcProtobuf` for grpc-keyword, `hostname`, `port`, `mqttTopic`, `kafkaProducerTopic` + `kafkaProducerMessage` + a non-empty `kafkaProducerBrokers`, the five `radius*` fields including the secret `radiusPassword` / `radiusSecret`, `game`, `docker_container` + `docker_host`, `pushToken`, `databaseConnectionString` for sqlserver / postgres / mysql / mongodb / redis, and `dns_resolve_server` for `dns`), `parent` must be null or an existing group, and `docker_host` / `proxyId` must name ids in the pushed `dockerHostList` / `proxyList`. On `edit` only the fields the edit sets are judged the same way, plus every required field of the new type when `type` changes — a stored value the edit does not touch is never re-judged. A hatch `type` on edit must be one of the 22 types the 1.23.17 picker offers; anything else exits 2
- `monitors pause <id>` / `monitors resume <id>`: prints `{ id, active }`
- `monitors delete <id> --yes`: sends `deleteMonitor` and prints `{ id, deleted: true }`; without `--yes` exits 2 before connecting. The id is checked against the pushed `monitorList` first because Kuma 1.23 answers ok even for an unknown id. Deleting a group monitor does not delete its children: their `parent` becomes null (Kuma 1.23 `ON DELETE SET NULL`), so they become top-level monitors and keep their own active / paused state, and the monitor's heartbeats are deleted with it
- `monitors tag <id> --tag <tagId> [--value <value>]`: attaches the tag; `--value` defaults to `""` (never sent as null). The monitor must be in the pushed `monitorList` and the tag in `getTags` — exit 1 each. `addMonitorTag` has no unique constraint, but the same tag+value already attached prints `{ id, tagId, value, skipped: true }` and exits 3 without sending. Otherwise sends `addMonitorTag` and prints `{ id, tagId, value }`
- `monitors untag <id> --tag <tagId> [--value <value>]`: `--value` defaults to `""`; the monitor must have that exact tag+value in the pushed list, else exit 1 — `deleteMonitorTag` answers ok even when nothing matches. A stored null value can never match `value = ?`, so removing one exits 1 with a message saying Kuma cannot remove a tag whose value is null through this event. Prints `{ id, tagId, value, removed: true }`
- `monitors retag <id> --tag <tagId> --value <value>`: the monitor must have the tag (exit 1); sends `editMonitorTag`, which sets the value on EVERY attachment of that tag on the monitor and answers ok even when nothing matches. Prints `{ id, tagId, value }`
- none of `addMonitorTag` / `editMonitorTag` / `deleteMonitorTag` pushes `monitorList` again; each command logs in once, so the next run sees the new state

### beats

- `beats <id> [--hours <n>] [--limit <n>] [--important]`
    - `getMonitorBeats (id, hours)`, default 24 hours; newest first; `--limit` keeps the newest n; `--important` keeps rows with `important` truthy
    - each row `{ time, status, msg, ping, important }`; `status` stays numeric (0 down, 1 up, 2 pending, 3 maintenance)
- `beats latest`
    - waits for `heartbeatList` of every monitor in `monitorList` (until the timeout; missing ones exit 2 naming them)
    - array sorted by id of `{ id, name, active, time, status, msg }`; a monitor with no beat has `time: null, status: null, msg: null`

### events

- `events <id> [--hours <n>] [--by-day]`
    - status changes: `getMonitorBeats (id, hours)` rows with `important` truthy, default 168 hours, newest first, `{ time, status, msg }`
    - `--by-day` prints `[{ date, down, up }]` sorted by date, counting status 0 and 1 per day; Kuma stores `time` in UTC and the day is taken in UTC

### notifications

- `notifications list`: `[{ id, name, type, active, isDefault }]`, `type` read from the `config` JSON
- `notifications add --name <name> --type <type> [--set k=v]... [--config-file <json>] [--default] [--apply-existing]`
    - the notification object is `{ isDefault: false, applyExisting: false, ...config-file, ...sets, name, type }`, then `--default` / `--apply-existing` set their field to true when given; secrets go through `--config-file` so they stay out of argv
    - prints `{ id, name, type }`
- `notifications edit <id> [--set k=v]... [--config-file <json>]`: merges into the stored config and sends `addNotification (merged, id)` with `applyExisting: false` (a stored `true` would re-attach the notification to every monitor on each edit, so `--set applyExisting=...` exits 2); at least one of `--set` / `--config-file`; prints `{ id, name, type }`
- `notifications test <id>`: sends the stored config to `testNotification`; prints `{ id, ok: true, msg }`, Kuma's failure exits 1
- `notifications delete <id> --yes`: sends `deleteNotification` and prints `{ id, deleted: true }`; without `--yes` exits 2 before connecting

### proxies

- `proxies list`: `[{ id, protocol, host, port, auth, username, active, default }]`; `auth` / `active` / `default` print as booleans although Kuma 1.23 sends them as 0/1
- `proxies add --protocol <http|https|socks|socks5|socks5h|socks4> --host <h> --port <p> [--username <u> --password-file <f>] [--default] [--apply-existing]`: prints `{ id }`
- `proxies edit <id> [--set k=v]... [--password-file <f>]`: merges into the listed proxy (password kept as stored unless `--password-file` is given, which also turns `auth` on) and sends `addProxy (merged, id)`; prints `{ id }`
- `proxies delete <id> --yes`: sends `deleteProxy` and prints `{ id, deleted: true }`; without `--yes` exits 2 before connecting. Kuma sets `proxy_id` to null on the monitors that used the proxy, so they stop using any proxy

### tags

- tags are not pushed after login; every tags command asks `getTags` (`{ id, name, color }` rows)
- `tags list`: `[{ id, name, color }]` sorted by id
- `tags add --name <name> --color <#rrggbb>`: `--color` must match `#rrggbb` (exit 2 before connecting). A tag with the same name (exact) already present prints `{ id, name, skipped: true }` and exits 3 without sending `addTag` — the name is not unique in Kuma, the skip is a CLI convention like `monitors add`. Otherwise sends `addTag` and prints `{ id, name, color }`
- `tags edit <id> [--name n] [--color c]`: at least one flag (exit 2 before connecting); `editTag` overwrites both fields, so the flag not given keeps the stored value. Unknown id exits 1. Prints `{ id, name, color }`
- `tags delete <id> --yes`: sends `deleteTag` and prints `{ id, deleted: true }`; without `--yes` exits 2 before connecting. The id is checked against `getTags` first because Kuma answers ok even for an unknown id; the monitor_tag rows cascade

## Tests

- `bun test` runs the unit tests in `tests/` against `tests/helpers/fake-kuma.ts`, an in-process Socket.IO server that mimics Kuma 1.23.17
- `bun run test:integration` (`scripts/integration.ts`) runs `tests/integration/` — the same CLI — against a real `louislam/uptime-kuma:1.23.17` container from `tests/integration/compose.yaml`; it needs Docker

## Not in scope

- Kuma 2.x event differences (the instance in use is 1.23.17)
