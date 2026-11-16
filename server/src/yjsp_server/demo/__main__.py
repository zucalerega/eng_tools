"""`yjsp-demo seed` (or `python -m yjsp_server.demo seed`): make the demo's made-up data from nothing (seed.py), where
the demo's settings keep it: YJSP_DEMO=1 and the rest, in the environment or a .env file, as the demo's server reads
them (docs/deploying.md, "The demo")."""

import argparse
import sys

from ..config import Settings, refuse_old_settings
from .seed import SeedError, seed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="yjsp-demo", description="The demo, with made-up data, that anyone can see.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed", help="make the demo's data from nothing, in place of what the last seed made")
    parser.parse_args(argv)
    refuse_old_settings()
    try:
        folder = seed(Settings())
    except SeedError as error:
        print(f"yjsp-demo: {error}", file=sys.stderr)
        return 1
    print(f"The demo's data is made, in {folder}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
