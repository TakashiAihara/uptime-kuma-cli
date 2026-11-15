# uptime-kuma-cli

CLI for Uptime Kuma 1.23 over its Socket.IO API: monitors, beats, status changes, notifications, proxies, maintenance windows, tags, status pages and settings.

Existing CLIs cover monitors but not proxies, notification tests, or status changes; see `docs/design/cli.md` for the comparison and the full specification.

## Install

- Install a release binary with `install.sh`. It stops without installing when the checksum does not match

```sh
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/uptime-kuma-cli/main/install.sh | sh
```

- To pin a tag, put the env on the `sh` side (on the `curl` side it never reaches install.sh and latest is installed)

```sh
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/uptime-kuma-cli/main/install.sh | UPTIME_KUMA_CLI_VERSION=v0.1.0 sh
```

- `UPTIME_KUMA_CLI_INSTALL_DIR` changes the destination (default `$HOME/.local/bin`)
- `UPTIME_KUMA_CLI_VERIFY_ATTESTATION=1` also verifies the build provenance with `gh`
- Binaries are `uptime-kuma-cli-<linux|darwin>-<x64|arm64>` on the Releases page, with `SHA256SUMS`
- From source: `bun install && bun run start -- --help`

## Configuration

- Env wins; otherwise `$XDG_CONFIG_HOME/uptime-kuma-cli/config.toml` (default `~/.config/uptime-kuma-cli/config.toml`)
- Kuma's API keys only work for `/metrics`, so the CLI logs in with a username and password

```toml
url = "https://uptime.example.com"
username_command = "infisical run --silent -- printenv UPTIME_KUMA_USERNAME"
password_command = "infisical run --silent -- printenv UPTIME_KUMA_PASSWORD"
```

- `*_command` runs with `sh -c`; the first stdout line is used. The username command does not see the password env and vice versa

| Env | Meaning |
| --- | --- |
| `UPTIME_KUMA_URL` | Base URL, starting with `http://` or `https://` (with `http://` the login travels in clear text) |
| `UPTIME_KUMA_USERNAME` / `UPTIME_KUMA_PASSWORD` | Login |
| `UPTIME_KUMA_TIMEOUT` | Seconds for connect, login, each request and pushed lists (default 30) |
| `UPTIME_KUMA_COMMAND_TIMEOUT` | Seconds for each `*_command` (default 60) |

## Usage

All output is JSON on stdout.

```sh
uptime-kuma-cli monitors list --name taba
uptime-kuma-cli monitors list --tag prod
uptime-kuma-cli monitors get 14
uptime-kuma-cli monitors add --type http --name "docs" --url https://docs.example.com --notifications-from 14
uptime-kuma-cli monitors add --type keyword --name "login page" --url https://example.com/login --keyword "Sign in"
uptime-kuma-cli monitors add --type json-query --name "relay jp" --url https://api.example.com/relays \
  --json-path '$[hostname="jp-1"].active' --expected-value true --proxy-id 2
uptime-kuma-cli monitors add --type port --name "ssh" --hostname 10.0.0.5 --port 22
uptime-kuma-cli monitors add --type push --name "nightly job" --paused --notifications-from 14
uptime-kuma-cli monitors add --type group --name "edge"
uptime-kuma-cli monitors add --type ping --name "gw" --hostname 192.0.2.1 --parent 12 --paused
uptime-kuma-cli monitors add --type dns --name "resolver" --hostname example.com --set 'dns_resolve_type="AAAA"'
uptime-kuma-cli monitors add --type mqtt --name "broker" --hostname mqtt.example.com --port 1883 \
  --mqtt-topic "sensors/temperature" --mqtt-username u1 --config-file mqtt.json
uptime-kuma-cli monitors add --type postgres --name "orders db" --database-query "SELECT 1" --config-file pg.json
uptime-kuma-cli monitors add --type http --name "wiki" --url https://wiki.example.com --config-file wiki.json
uptime-kuma-cli monitors edit 14 --set maxretries=2 --set 'notificationIDList=[3,5]'
uptime-kuma-cli monitors edit 14 --parent 12
uptime-kuma-cli monitors edit 14 --parent none
uptime-kuma-cli monitors pause 14
uptime-kuma-cli monitors resume 14
uptime-kuma-cli monitors delete 14 --yes
uptime-kuma-cli monitors tag 14 --tag 3 --value eu
uptime-kuma-cli monitors untag 14 --tag 3 --value eu
uptime-kuma-cli monitors retag 14 --tag 3 --value us

uptime-kuma-cli beats 14 --hours 6 --limit 20
uptime-kuma-cli beats latest
uptime-kuma-cli events 14 --hours 720 --by-day

uptime-kuma-cli notifications list
uptime-kuma-cli notifications add --name "ntfy" --type ntfy --config-file ntfy.json
uptime-kuma-cli notifications edit 3 --set ntfytopic=alerts
uptime-kuma-cli notifications test 3
uptime-kuma-cli notifications delete 3 --yes

uptime-kuma-cli proxies list
uptime-kuma-cli proxies add --protocol socks5 --host 10.0.0.9 --port 1080
uptime-kuma-cli proxies edit 2 --set port=1081 --password-file proxy-pw
uptime-kuma-cli proxies delete 2 --yes

uptime-kuma-cli tags list
uptime-kuma-cli tags add --name prod --color "#22c55e"
uptime-kuma-cli tags edit 3 --name production
uptime-kuma-cli tags delete 3 --yes

uptime-kuma-cli maintenance list
uptime-kuma-cli maintenance add --title "db upgrade" --strategy manual --paused
uptime-kuma-cli maintenance add --title "nightly" --strategy recurring-weekday --config-file nightly.json
uptime-kuma-cli maintenance edit 4 --title "db upgrade (extended)"
uptime-kuma-cli maintenance monitors 4 --add 14
uptime-kuma-cli maintenance status-pages 4 --set-ids 2
uptime-kuma-cli maintenance pause 4
uptime-kuma-cli maintenance resume 4
uptime-kuma-cli maintenance delete 4 --yes

uptime-kuma-cli status-pages list
uptime-kuma-cli status-pages get status
uptime-kuma-cli status-pages add --slug status --title "Status"
uptime-kuma-cli status-pages save status --config-file page.json
uptime-kuma-cli status-pages incident status --title "Degraded" --content "Investigating" --style warning
uptime-kuma-cli status-pages unpin status
uptime-kuma-cli status-pages delete status --yes

uptime-kuma-cli settings get
uptime-kuma-cli settings set --set keepDataPeriodDays=90 --set 'tlsExpiryNotifyDays=[7,14,21]'
uptime-kuma-cli settings set --config-file settings.json
```

- `monitors add` and `tags add` exit 3 and send nothing when the same name exists; `maintenance add` does the same for a title, `status-pages add` for a slug, `status-pages save` when the file's slug belongs to another page; `monitors tag` exits 3 when the same tag+value is already attached. `monitors add --tag <id[:value]>` attaches tags at creation
- `maintenance add` / `edit` take `--config-file` for the schedule fields of the `cron` and `recurring-*` strategies; `maintenance monitors` / `status-pages` replace the whole attached set — Kuma's attach events delete every existing row first, they do not add
- `status-pages get` also fetches the unauthenticated `GET /api/status-page/<slug>` for the public groups and pinned incident; Kuma caches that route for 5 minutes but the CLI adds a cache-busting query so Kuma's own cache never answers a read (a reverse proxy in front of Kuma that ignores query strings could still serve a stale body), and `status-pages incident` unpins the page's previous incident
- `status-pages save` merges the JSON file over the fetched page config and replaces the whole public group set — groups not listed are deleted; a `get` output's `publicGroupList` can be fed back as the file's `publicGroupList`. If the read-back after a successful save fails, the sent config is printed with a stderr warning and exit code 0
- `settings set` sends the whole merged settings object like the UI does — a partial object would reset `entryPage`, toggle `nscd` and could disconnect other clients; precedence is fetched < `--config-file` < `--set`. `steamAPIKey` only goes through `--config-file`, the literal `"***"` is refused there, and the key prints as `***`; a `primaryBaseURL` password prints as `***` too and a query/fragment is refused; `serverTimezone` accepts `"UTC"` or an `Intl.supportedValuesOf("timeZone")` name case-sensitively; turning `disableAuth` on re-checks the login password and turning it back off disconnects other clients; `chromeExecutable` / `nscd` changes take effect immediately; if the post-save re-read fails the sent object is printed with a warning and exit code 0
- Push monitors get their token in the same `add` call; the output carries `pushToken` and `pushUrl`
- `--paused` creates the monitor without starting it (push to a paused monitor returns HTTP 404, so resume before the pusher starts)
- Kuma only notifies on status changes; with `resendInterval` 0 a monitor that stays down does not notify again
- Notification configs, proxy passwords and secret monitor fields (basic auth, OAuth secret, TLS key, headers, body, ...) are never printed; pass secrets with `--config-file` / `--password-file`
- `monitors add` / `monitors edit` take `--set key=value` and `--config-file` for monitor fields without a dedicated flag; secret fields only go through `--config-file` so they stay out of argv
- New monitors get the notifications marked default; every type except port / push gets the proxy flagged `default` (proxyId), and `--proxy-id` overrides it
- Each command logs in once; Kuma allows 20 logins per minute per instance, so pace long loops. Accounts with 2FA are not supported

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Kuma answered no (`ok: false`, unknown id) |
| 2 | Configuration, usage, connection, login or timeout failure |
| 3 | A create or attach was skipped: same name / title / slug / tag+value exists |
| 70 | Unexpected error |

## Integration tests

- `bun run test:integration` runs `tests/integration` — the same CLI — against a real `louislam/uptime-kuma:1.23.17` container started with Docker Compose; it needs Docker
- Kuma is published on `127.0.0.1:3901` only; set `UPTIME_KUMA_IT_PORT` to use another port
- `UPTIME_KUMA_IT_KEEP=1` leaves the container up afterwards for debugging; a later run on the same `UPTIME_KUMA_IT_PORT` removes it before starting
