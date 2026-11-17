"""A stand-in for systemctl, as the site asks it to start yjsp-deploy.service (YJSP_DEPLOY_SYSTEMCTL):

    python fake_systemctl.py CALLS DEPLOY_DIR MODE <what systemctl is asked>

It notes what it was asked in CALLS, a line of JSON each time, and then, as MODE says: "start" begins a deploy as
yjsp-deploy does, its record in DEPLOY_DIR saying it's fetching main; "silent" starts nothing; "denied" and "missing"
fail as systemctl does when polkit won't let the site start the unit, or the unit isn't installed."""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

calls, folder, mode, *asked = sys.argv[1:]
with open(calls, "a", encoding="utf-8") as file:
    file.write(json.dumps(asked) + "\n")
if mode == "denied":
    sys.exit("Failed to start yjsp-deploy.service: Access denied")
if mode == "missing":
    print("Failed to start yjsp-deploy.service: Unit yjsp-deploy.service not found.", file=sys.stderr)
    sys.exit(5)
if mode == "start":
    now = datetime.now(UTC)
    deploys = Path(folder) / "deploys"
    deploys.mkdir(parents=True, exist_ok=True)
    started = now.strftime("%Y%m%d-%H%M%S")
    record = {"source": "site", "started": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "step": "fetch"}
    (deploys / f"{started}.json").write_text(json.dumps(record), encoding="utf-8")
    (deploys / f"{started}.log").write_text("==> Fetching main from GitHub\n", encoding="utf-8", newline="\n")
