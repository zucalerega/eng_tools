# Contributing

YJSP is a college rocketry team's engineering tools: Vault (CAD version control for SolidWorks), Yorg (test data),
Piper (P&IDs), and Buildflow (bills of design), on one server. The team trusts them with flight hardware's designs and
test data, so correctness, and never losing data, come before speed. Changes are welcome: say what you'd like to change
in an issue first, for anything bigger than a fix, so no one's work goes to waste.

## Getting started

[README.md](README.md) has running the server and the web app on a laptop ("Run the server locally") and the `vault`
command. [docs/design.md](docs/design.md) is how the site works, and `docs/vault.md`, `docs/yorg.md`, `docs/piper.md`,
and `docs/buildflow.md` each app; read the parts your change touches first.

## How changes are made

[CLAUDE.md](CLAUDE.md) is the whole of it, for people and AI agents alike. In short:

- One logical change per pull request, from a branch, with its tests and the docs it changes, and with screenshots if it
  changes what people see. A behavior change ships with tests; a bug fix starts with a test that fails without it.
- The full check passes before every commit: it's the one CI runs.

  ```bash
  cd server && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest
  cd client && dotnet format --verify-no-changes && dotnet build && dotnet test
  cd web && npm ci && npm run check && npm test && npm run build
  ```

- The API changes only by adding to it: the add-in and the `vault` command on team laptops update slowly.
- Every error the server sends has a code, and [docs/troubleshooting.md](docs/troubleshooting.md) says what it means.

## Licenses

`server/` and `web/` are under the GNU GPL, version 3 ([LICENSE](LICENSE)); `client/` is under the MIT license
([client/LICENSE](client/LICENSE)). What you contribute is under the license of the part you change. A new dependency's
license has to allow that: GPL-compatible for the server and the web app, and permissive for the client, which runs
inside SolidWorks. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists what the repository uses under terms of its
own.

## Security

Please don't open an issue for a vulnerability: [SECURITY.md](SECURITY.md) says how to report one privately.
