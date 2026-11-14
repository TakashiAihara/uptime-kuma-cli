# uptime-kuma-cli design

## Goal

- Operate an Uptime Kuma 1.23 instance from the shell and from agents without writing ad hoc `uptime-kuma-api` scripts
- Cover what existing CLIs lack: proxies, notification tests, and status changes (important heartbeats)

## Why not an existing CLI

- BigBoot/AutoKuma `kuma` (Rust): monitors and notifications via JSON files; no beats, no status changes, no proxies, no notification test; targets Kuma v2 by default since 2.0.0
- pablofmorales/kuma-cli (TypeScript): monitors and beats, but no proxies, no notification edit/test, no keyword / json-query fields, and it stores the login token in its config file

## Transport

- Socket.IO v4 client (`socket.io-client`) against the Kuma base URL, `transports: ["websocket"]`
- Log in with `login` `{ username, password, token: "" }`; the callback returns `{ ok, msg }`
- After login the server pushes `monitorList` (object keyed by id), `notificationList` (array), `proxyList` (array), then one `heartbeatList (monitorID, beats)` and one `importantHeartbeatList (monitorID, beats)` per monitor
- Request events used, all with a trailing callback returning `{ ok, msg, ... }`:
    - `add (monitor)` → `monitorID`
    - `editMonitor (monitor)` → `monitorID`
    - `getMonitor (id)` → `monitor`
    - `pauseMonitor (id)` / `resumeMonitor (id)`
    - `getMonitorBeats (id, hours)` → `data` (oldest first, raw heartbeat rows with `important`)
    - `addNotification (notification, idOrNull)` → `id`; the server stores the whole object as the `config` JSON string
    - `testNotification (notification)` → `msg`
    - `addProxy (proxy, idOrNull)` → `id`
- A request whose callback has `ok: false` exits 1 with `msg` on stderr

## Configuration

- `$XDG_CONFIG_HOME/uptime-kuma-cli/config.toml` (or `~/.config/uptime-kuma-cli/config.toml`)
    - `url`, `username_command`, `password_command`
- `*_command` runs with `sh -c`; the first stdout line is the secret. An env value takes precedence and the command does not run
- Env: `UPTIME_KUMA_URL`, `UPTIME_KUMA_USERNAME`, `UPTIME_KUMA_PASSWORD`, `UPTIME_KUMA_TIMEOUT` (seconds, default 30, for connect + login + each request), `UPTIME_KUMA_COMMAND_TIMEOUT` (seconds, default 60)
- The username command does not see the password and vice versa

## Output

- stdout is JSON (pretty, 2-space indent), stderr is for messages
- `notificationIDList` is always printed as a sorted array of numbers, whether Kuma sent `{ "3": true }` or `[3]`
- Notification configs and proxy passwords are never printed

## Exit codes

| code | meaning |
|---|---|
| 0 | done |
| 1 | Kuma answered no (`ok: false`, unknown id) |
| 2 | configuration, usage, connection, login, or timeout failure |
| 3 | `monitors add` skipped because a monitor with the same name exists |
| 70 | unexpected error |

## Commands

### monitors

- `monitors list [--name <substring>]`
    - array sorted by id of `{ id, name, type, active, url, hostname, port, interval, parent, notificationIDList }`
    - `--name` filters case-insensitively
- `monitors get <id>`: the monitor object from `monitorList`; unknown id exits 1
- `monitors add --type <http|keyword|json-query|port|push> --name <name> [options]`
    - options: `--url`, `--hostname`, `--port`, `--keyword`, `--json-path`, `--expected-value`, `--interval <s>` (60), `--retry-interval <s>` (60), `--max-retries <n>` (0), `--resend-interval <n>` (0), `--timeout <s>` (48), `--proxy-id <id>`, `--notification-id <id>` (repeatable), `--notifications-from <monitorId>`, `--paused`, `--push-token <token>`
    - required per type: http / keyword / json-query need `--url`; keyword needs `--keyword`; json-query needs `--json-path` and `--expected-value`; port needs `--hostname` and `--port`. Missing ones exit 2 before connecting
    - same name (exact match) already present: print `{ id, name, skipped: true }` and exit 3 without sending `add`
    - the payload starts from the Kuma 1.23 UI defaults (`accepted_statuscodes: ["200-299"]`, `method: "GET"`, `maxredirects: 10`, `kafkaProducerBrokers: []`, `kafkaProducerSaslOptions: { mechanism: "None" }`, ...) and sends `notificationIDList` as `{ "<id>": true }`
    - `--notifications-from` copies that monitor's notifications; `--notification-id` adds to them
    - push: `pushToken` is `--push-token` or 32 random alphanumerics, sent in `add` itself
    - `--paused` sends `active: false`, so Kuma does not start the monitor
    - prints `{ id, name, type, active }`, plus `pushToken` and `pushUrl` (`<url>/api/push/<token>?status=up&msg=OK&ping=`) for push
- `monitors edit <id> --set <key>=<value>...`
    - fetches the monitor with `getMonitor`, applies each set (value parsed as JSON when it parses, else kept as a string), and sends `editMonitor`
    - `notificationIDList` accepts an array or an object and is sent as an object
    - prints the edited monitor as `monitors get` does
- `monitors pause <id>` / `monitors resume <id>`: prints `{ id, active }`

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
    - the notification object is `{ name, type, isDefault, applyExisting, ...config-file, ...sets }`; secrets go through `--config-file` so they stay out of argv
    - prints `{ id, name, type }`
- `notifications edit <id> [--set k=v]... [--config-file <json>]`: merges into the stored config and sends `addNotification (merged, id)`; prints `{ id, name, type }`
- `notifications test <id>`: sends the stored config to `testNotification`; prints `{ id, ok: true, msg }`, Kuma's failure exits 1

### proxies

- `proxies list`: `[{ id, protocol, host, port, auth, username, active, default }]`
- `proxies add --protocol <http|https|socks|socks5|socks5h|socks4> --host <h> --port <p> [--username <u> --password-file <f>] [--default] [--apply-existing]`: prints `{ id }`
- `proxies edit <id> --set k=v...`: merges into the listed proxy (password kept as stored) and sends `addProxy (merged, id)`; prints `{ id }`

## Not in scope

- Deleting monitors, notifications, or proxies (do it in the UI; nobody asked for it)
- Kuma 2.x event differences (the instance in use is 1.23.17)
