# uptime-kuma-cli

CLI for Uptime Kuma 1.23 over its Socket.IO API: monitors, beats, status changes, notifications, proxies, docker hosts, maintenance windows, tags, status pages, API keys and settings.

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
uptime-kuma-cli monitors stats
uptime-kuma-cli monitors stats 14
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

uptime-kuma-cli docker-hosts list
uptime-kuma-cli docker-hosts add --name "build" --type socket --daemon /var/run/docker.sock
uptime-kuma-cli docker-hosts edit 2 --type tcp --daemon tcp://docker.example.com:2375
uptime-kuma-cli docker-hosts test 2
uptime-kuma-cli docker-hosts delete 2 --yes

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

uptime-kuma-cli api-keys list
uptime-kuma-cli api-keys add --name "ci metrics" --expires 2027-01-01T00:00
uptime-kuma-cli api-keys enable 3
uptime-kuma-cli api-keys disable 3
uptime-kuma-cli api-keys delete 3 --yes
```

- `monitors add` and `tags add` exit 3 and send nothing when the same name exists; `maintenance add` does the same for a title, `status-pages add` for a slug, `status-pages save` when the file's slug belongs to another page; `monitors tag` exits 3 when the same tag+value is already attached. `monitors add --tag <id[:value]>` attaches tags at creation
- `maintenance add` / `edit` take `--config-file` for the schedule fields of the `cron` and `recurring-*` strategies; `maintenance monitors` / `status-pages` replace the whole attached set — Kuma's attach events delete every existing row first, they do not add
- `docker-hosts test` also takes `--type` / `--daemon` to check a host that is not saved yet; deleting a host clears `docker_host` on the monitors that used it
- `status-pages get` also fetches the unauthenticated `GET /api/status-page/<slug>` for the public groups and incidents; the output carries `incidents` (the server's array on 2.x, `[incident]` or `[]` on 1.x) plus a compatibility `incident` (the newest pinned one). Kuma caches that route for 5 minutes but the CLI adds a cache-busting query so Kuma's own cache never answers a read (a reverse proxy in front of Kuma that ignores query strings could still serve a stale body), and `status-pages incident` keeps one pinned incident — on 2.x it calls `unpinIncident` before `postIncident` because 2.x's `postIncident` no longer unpins
- `status-pages save` merges the JSON file over the fetched page config and replaces the whole public group set — groups not listed are deleted; a `get` output's `publicGroupList` can be fed back as the file's `publicGroupList` (monitor `url`s in the file are dropped — 2.x would store them as custom URLs); when the file omits `publicGroupList` on Kuma 2.x, a custom monitor URL set in the UI survives the save — the CLI reads the public route unredacted and sends the public `url` back only when it differs from the monitor's own (a `sendUrl`-off monitor exposes no public url, so its custom URL cannot be detected and is cleared). The file accepts the save keys of both Kuma versions: the six refresh/analytics keys (`autoRefreshInterval`, `rssTitle`, `showOnlyLastHeartbeat`, `analyticsId`, `analyticsScriptUrl`, `analyticsType`) exit 2 on 1.x and `googleAnalyticsId` exits 2 on 2.x. If the read-back after a successful save fails, the sent config is printed with a stderr warning and exit code 0 — an unexpected response shape on the read-back is not degraded and still exits 70
- `settings set` sends the whole merged settings object like the UI does — a partial object would reset `entryPage`, toggle `nscd` and could disconnect other clients; precedence is fetched < `--config-file` < `--set`. The editable keys follow the connected Kuma version: `domainExpiryNotifyDays` and `globalpingApiToken` need 2.x, `dnsCache` is 1.x-only, and a key for the other version exits 2 after connect. `steamAPIKey` and `globalpingApiToken` only go through `--config-file`, the literal `"***"` is refused there, and both print as `***`; a `primaryBaseURL` password prints as `***` too, is refused in `--set` (use `--config-file`) and its masked form is refused when fed back, and any `?` / `#` is refused; `serverTimezone` accepts only the names the connected version's UI offers that Kuma also takes, case-sensitively; turning `disableAuth` on re-checks the login password and turning it back off disconnects other clients; `chromeExecutable` / `nscd` changes take effect immediately; if the post-save re-read fails the sent object is printed with a warning and exit code 0
- Push monitors get their token in the same `add` call; the output carries `pushToken` and `pushUrl`
- `api-keys add` prints the clear key once — Kuma stores only its hash, so it cannot be read again; `--expires` takes a local ISO datetime without an offset and is stored in the UI's `yyyy-MM-dd HH:mm:ss` form, omitting it means the key never expires
- `--paused` creates the monitor without starting it (push to a paused monitor returns HTTP 404, so resume before the pusher starts)
- Kuma only notifies on status changes; with `resendInterval` 0 a monitor that stays down does not notify again
- Notification configs, proxy passwords and secret monitor fields (basic auth, OAuth secret, TLS key, headers, body, ...) are never printed; pass secrets with `--config-file` / `--password-file`. The Kuma 2.x monitor secrets `bearer_token`, `gamedigToken`, `rabbitmqPassword`, `sshPassword`, `sshPrivateKey` and `sshPassphrase` print as `***` the same way
- `monitors add` / `monitors edit` take `--set key=value` and `--config-file` for monitor fields without a dedicated flag; secret fields only go through `--config-file` so they stay out of argv. The field allowlist covers both Kuma versions: a key that only Kuma 2.x has passes the pre-connect check but exits 2 once the server reports 1.x (`"<key>" needs Uptime Kuma 2.x`)
- On Kuma 2.x, `monitors add` sends `conditions: []`, `rabbitmqNodes: []` and `jsonPathOperator: "=="` (like the 2.x UI, for every type) unless `--config-file` / `--set` give them; `--json-path-operator <op>` (`==`, `!=`, `<`, `<=`, `>`, `>=` or `contains`) sets the operator of a json-query monitor and is ignored on other types. `monitors edit` gives a monitor that is or becomes json-query `==` when it has no operator. On Kuma 1.x, `--json-path-operator` (on add only for json-query; on edit always, since the type is not known yet) and every other 2.x-only field exit 2
- Monitor timing follows the server version detected at login: `interval` must be 20–2073600 s on Kuma 1.x but only >= 1 s on 2.x (no maximum), `timeout` must be positive on 1.x (0 would become interval × 800 s) but may be 0 on 2.x (Kuma turns it into 80% of the interval), and `retryInterval` must be >= 1 on 2.x. An unset `timeout` on `monitors add` defaults to the 2.x UI value — 10 for ping, 1 for kafka-producer, 48 for every other type — and 48 on 1.x. The timeout is capped at 80% of the interval, except a ping on 2.x, whose timeout must be 1–300 s and at least `ping_per_request_timeout` (2 by default) or the command exits 2
- `monitors stats` reports Kuma's pushed stats like `beats latest` waits for heartbeats: `uptime24h` / `uptime30d` are 0–1 ratios over the 24h / 30d windows, `avgPing` is null when no beat has a ping, `certExpiresAt` / `certDaysRemaining` are null without a certificate — the wait for a monitor's certificate ends 500 ms after its own 30d uptime arrives, and missing stats (not a missing certificate) exit 2 naming the monitors
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

## Testing

- `bun test` runs the unit tests in `tests/` against an in-process fake Kuma (`tests/helpers/fake-kuma.ts`); the CLI itself runs in-process too, so coverage sees `src/commands` (`tests/cli-process.test.ts` additionally spawns the real entry point to prove it boots, exits cleanly and disconnects)
- `bun run check` runs typecheck, lint, format check and the unit tests — the same gate CI's `check` job runs; the job also ends with `bun audit`, which fails on known vulnerabilities in `bun.lock`
- To accept an audit finding, add its GHSA or advisory id to `--ignore` on the `bun audit` step in `.github/workflows/ci.yml`; the acceptance stays in the file's history so it is re-read on review
- CI enforces line coverage on `src/`: the whole project must stay >= 90%, and on pull requests the lines the PR adds or changes must be >= 90% covered. A diff with no measurable src lines (docs, config, tests only) passes
- Reproduce locally: `bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage` then `bun scripts/coverage.ts whole` (and `bun scripts/coverage.ts diff --base origin/main` for the diff gate)
- CI also runs mutation testing (`mewt`) on src lines changed by the PR and posts surviving mutants as a PR comment — report-only for now, it does not fail the build; reproduce locally with `mise use -g github:trailofbits/mewt@4.0.0` then `bun scripts/mutation-report.ts --base origin/main`

## Contributing

- Open a pull request; CI runs `check`, `static`, `coverage`, `integration` (Kuma 1.23 and 2.x) and `mutation` (report-only). Branch protection on `main` requires `check`, both `integration` jobs, `opencode / review` and `coderabbit-review` to pass, and all review conversations to be resolved before merge
- `.github/PULL_REQUEST_TEMPLATE.md` is the PR body: it asks for the verification results (both integration images with pass/fail counts, coverage numbers) and a review log — one row per review round with the reviewed commit, the findings, and what was done with them
- CodeRabbit and opencode review every PR automatically. `coderabbit-review` is a commit status this repo publishes itself: it turns green only when CodeRabbit's own status reports `Review completed` — CodeRabbit's check stays green even when it is rate limited or skips the review, so it cannot be required directly
- When `coderabbit-review` fails, the status description says why; comment `@coderabbitai review` on the PR to request a new review (for a paused review `@coderabbitai resume` also works; when CodeRabbit reports no files to review, `@coderabbitai full review` reviews the whole diff), then resolve every review thread — unresolved threads block the merge
- Dependabot opens weekly PRs for bun dependencies and the GitHub Actions (`.github/dependabot.yml`). Bun gets version updates only — no security updates — and the dependency graph reads `package.json` but not `bun.lock`, so the `bun audit` step is the vulnerability gate for the transitive tree. Dependabot PRs go through the same required checks as any other PR

## Integration tests

- `bun run test:integration` runs `tests/integration` — the same CLI — against a real `louislam/uptime-kuma:1.23.17` container started with Docker Compose; it needs Docker
- Set `UPTIME_KUMA_IT_IMAGE=louislam/uptime-kuma:2.5.11` to run the same tests against Kuma 2.x; tests that 2.x breaks until their issue lands are skipped there (CI runs both images)
- Kuma is published on `127.0.0.1:3901` only; set `UPTIME_KUMA_IT_PORT` to use another port
- `UPTIME_KUMA_IT_KEEP=1` leaves the container up afterwards for debugging; a later run on the same `UPTIME_KUMA_IT_PORT` removes it before starting
