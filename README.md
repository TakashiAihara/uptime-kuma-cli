# uptime-kuma-cli

CLI for Uptime Kuma 1.23 over its Socket.IO API: monitors, beats, status changes, notifications and proxies.

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
uptime-kuma-cli monitors get 14
uptime-kuma-cli monitors add --type http --name "docs" --url https://docs.example.com --notifications-from 14
uptime-kuma-cli monitors add --type keyword --name "login page" --url https://example.com/login --keyword "Sign in"
uptime-kuma-cli monitors add --type json-query --name "relay jp" --url https://api.example.com/relays \
  --json-path '$[hostname="jp-1"].active' --expected-value true --proxy-id 2
uptime-kuma-cli monitors add --type port --name "ssh" --hostname 10.0.0.5 --port 22
uptime-kuma-cli monitors add --type push --name "nightly job" --paused --notifications-from 14
uptime-kuma-cli monitors edit 14 --set maxretries=2 --set 'notificationIDList=[3,5]'
uptime-kuma-cli monitors pause 14
uptime-kuma-cli monitors resume 14
uptime-kuma-cli monitors delete 14 --yes

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
```

- `monitors add` exits 3 and sends nothing when a monitor with the same name exists
- Push monitors get their token in the same `add` call; the output carries `pushToken` and `pushUrl`
- `--paused` creates the monitor without starting it (push to a paused monitor returns HTTP 404, so resume before the pusher starts)
- Kuma only notifies on status changes; with `resendInterval` 0 a monitor that stays down does not notify again
- Notification configs, proxy passwords and secret monitor fields (basic auth, OAuth secret, TLS key, headers, body, ...) are never printed; pass secrets with `--config-file` / `--password-file`
- New monitors get the notifications marked default, and http / keyword / json-query monitors get the default proxy, as in the UI
- Each command logs in once; Kuma allows 20 logins per minute per instance, so pace long loops. Accounts with 2FA are not supported

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Kuma answered no (`ok: false`, unknown id) |
| 2 | Configuration, usage, connection, login or timeout failure |
| 3 | `monitors add` skipped: same name exists |
| 70 | Unexpected error |

## Integration tests

- `bun run test:integration` runs `tests/integration` — the same CLI — against a real `louislam/uptime-kuma:1.23.17` container started with Docker Compose; it needs Docker
- Kuma is published on `127.0.0.1:3901` only; set `UPTIME_KUMA_IT_PORT` to use another port
- `UPTIME_KUMA_IT_KEEP=1` leaves the container up afterwards for debugging; run `docker compose -f tests/integration/compose.yaml -p uptime-kuma-cli-it down -v` before the next run, or setup fails because the admin already exists
