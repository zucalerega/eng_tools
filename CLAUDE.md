# CVC: agent guide

CAD version control (check-out/check-in, history, folder permissions) for a college
rocketry team's SolidWorks and STEP files. It replaces Kenesto. README.md is the
user guide; docs/design.md has the design, API, and roadmap. Read the design before
changing behavior.

## Commands

```bash
cd server && uv sync                      # env in server/.venv (Python 3.13)
cd server && uv run pytest                # offline tests; run before committing
cd server && uv run ruff check . && uv run ruff format .
cd server && uv run alembic revision --autogenerate -m "..."   # after changing models.py
```

The server applies migrations itself at startup (`db.migrate`). `tests/test_database.py`
fails if the models and migrations drift apart.

## Layout

- `server/src/cvc_server/vault.py`: every vault operation, with no HTTP. Start here.
- `access.py`: the folder tree and effective permissions. `paths.py`: path rules.
- `auth.py`: accounts, tokens, and the CLI/add-in sign-in handshake.
- `api/`: thin FastAPI routes (`files.py`, `admin.py`, `signin.py`), plus
  `schemas.py` for request and response bodies.

## Invariants

- Every mutating vault operation calls `vault.begin_write(db)` first, before
  reading anything it validates. That serializes writers (SQLite and Postgres)
  and keeps `change_seq` in commit order, which the sync feed relies on.
- Check-in needs the lock, held by the same user on the same computer (`host`).
  A check-in is all-or-nothing, references included.
- Versions and blobs never change. Blobs are named by their SHA-256 and verified
  on upload.
- Vault paths are case-insensitive, NFC-normalized, valid Windows names, and at
  most 200 characters (`paths.py`). Compare names with `paths.key()`, never `==`.
- Permission checks go through `Access`. A file the user can't see is 404, not 403.
- Timestamps are timezone-aware UTC (`db.UTCDateTime`). Never store naive
  datetimes.
- Dev sign-in (`CVC_DEV_AUTH`) must never work in production. `Settings.check()`
  enforces this.
- `data/` (database, file contents) is git-ignored. Never commit it.
