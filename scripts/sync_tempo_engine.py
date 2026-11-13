"""Verify or update Tempo's vendored Sequence Tester Python engine.

Sequence Tester (https://github.com/gt-space/sequence-tester) is the single
authoritative implementation of Tempo's Luna compatibility and simulation
engine. This script pins an exact upstream revision and verifies byte-for-byte
integrity of the vendored files.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "web" / "src" / "tempo" / "engine"
MANIFEST_PATH = ENGINE_DIR / "upstream.json"
ENGINE_FILES = ("luna_contract.py", "luna_validation.py", "engine.py")
DEFAULT_REPO = "https://github.com/gt-space/sequence-tester"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(source_dir: Path | None = None) -> int:
    if not MANIFEST_PATH.exists():
        print(f"Missing manifest: {MANIFEST_PATH}", file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    recorded = manifest.get("files", {})
    if set(recorded) != set(ENGINE_FILES):
        print(f"Manifest files mismatch: {sorted(recorded)} != {sorted(ENGINE_FILES)}", file=sys.stderr)
        return 1

    ok = True
    for name in ENGINE_FILES:
        target = ENGINE_DIR / name
        if not target.exists():
            print(f"Missing vendored file: {target}", file=sys.stderr)
            ok = False
            continue
        actual = sha256_file(target)
        if actual != recorded[name]:
            print(f"Checksum mismatch for {name}: {actual} != {recorded[name]}", file=sys.stderr)
            ok = False
        if source_dir is not None:
            upstream = source_dir / "src" / name
            if not upstream.exists():
                print(f"Missing upstream file: {upstream}", file=sys.stderr)
                ok = False
            elif sha256_file(upstream) != actual:
                print(f"Upstream mismatch for {name}: {upstream} differs from {target}", file=sys.stderr)
                ok = False

    if ok:
        print(
            f"Tempo engine OK: sequence-tester {manifest.get('tester_sha', '?')[:8]} "
            f"(Luna {manifest.get('luna_sha', '?')[:8]})"
        )
        return 0
    return 1


def update(source_dir: Path, luna_sha: str) -> int:
    tester_sha = subprocess.check_output(
        ["git", "-C", str(source_dir), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}
    for name in ENGINE_FILES:
        src = source_dir / "src" / name
        if not src.exists():
            print(f"Missing upstream file: {src}", file=sys.stderr)
            return 1
        dst = ENGINE_DIR / name
        dst.write_bytes(src.read_bytes())
        hashes[name] = sha256_file(dst)

    manifest = {
        "schema_version": 1,
        "repo": DEFAULT_REPO,
        "tester_sha": tester_sha,
        "luna_sha": luna_sha,
        "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": hashes,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Updated Tempo engine to sequence-tester {tester_sha[:8]} (Luna {luna_sha[:8]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify vendored engine checksums")
    parser.add_argument("--update", action="store_true", help="Update vendored engine from sequence-tester checkout")
    parser.add_argument("--source-dir", type=Path, help="Path to gt-space/sequence-tester checkout")
    parser.add_argument("--luna-sha", help="Tested Luna commit SHA (required with --update)")
    args = parser.parse_args()

    if args.update:
        if not args.source_dir or not args.luna_sha:
            parser.error("--update requires --source-dir and --luna-sha")
        return update(args.source_dir, args.luna_sha)
    return check(args.source_dir)


if __name__ == "__main__":
    raise SystemExit(main())
