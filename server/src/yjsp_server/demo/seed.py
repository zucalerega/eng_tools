"""The demo's data (docs/design.md, "The demo"), made up and made from nothing, through the site's own API, as if a team
had used the site over a semester. `yjsp-demo seed` makes it where the demo's settings keep their data, and the demo's
own server serves it (YJSP_DEMO=1).

A fictional team's liquid rocket, Kestrel, and its test stand: their people; their P&IDs, Piper's own examples
(diagrams/, which web/tests/demo-diagrams.test.ts keeps as they're drawn), revised and released; their tests in Yorg,
cold flows, a proof test, and two hot fires (data.py), named after the P&IDs' tags, so Piper shows them on the
drawings; their bills of design in Buildflow, through design and into build and test, and linked to all of those; and in
Vault, SparkFun's model of a servo (files/), the only CAD, credited to SparkFun. Nothing in it is anyone's real hardware
or data.

Each change is made at its time in the semester (db.clock), counted back from the day the demo is made, so it's made
again each night (deploy/yjsp-demo.service) to stay recent. Otherwise it's the same each time. The demo's data is all in
one folder, which the seed makes beside it and then puts in its place, so a seed that fails leaves the last one as it
was; and it replaces only a folder a seed made (MARK), never anything else.
"""

import hashlib
import json
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from sqlalchemy import delete
from sqlalchemy.engine import make_url
from starlette.testclient import TestClient

from .. import auth, db
from ..config import Settings
from ..models import ClientAuthCode, Token, User, UserStatus
from . import GUEST_EMAIL, GUEST_NAME, SITE_NAME, data

HERE = Path(__file__).parent
# In the demo's folder, and only there: what a seed made, and may replace.
MARK = ".yjsp-demo"


class SeedError(Exception):
    """The demo can't be made where its settings say: the message says why, and what to do."""


@dataclass(frozen=True)
class Person:
    key: str
    name: str
    admin: bool = False

    @property
    def email(self) -> str:
        return f"{self.key}@kestrel.test"  # .test: an address that can never be anyone's


TEAM = [
    Person("ada", "Ada Okafor", admin=True),  # the chief engineer
    Person("ben", "Ben Hartley"),  # the leads: propulsion,
    Person("chloe", "Chloe Nakamura"),  # fluids,
    Person("diego", "Diego Ramírez"),  # structures,
    Person("elena", "Elena Petrova"),  # avionics,
    Person("farid", "Farid Haddad"),  # and recovery
    Person("grace", "Grace Liu"),  # propulsion
    Person("hugo", "Hugo Lindqvist"),  # fluids
    Person("imani", "Imani Brooks"),  # test operations
    Person("jonas", "Jonas Weber"),  # structures
    Person("keiko", "Keiko Tanaka"),  # avionics
    Person("leo", "Leo Martins"),  # ground support
]
# Who leads each of the rocket's subsystems, as templates.ROCKET names them.
LEADS = {"Propulsion": "ben", "Fluids": "chloe", "Structures": "diego", "Avionics": "elena", "Recovery": "farid"}


def seed(settings: Settings) -> Path:
    """Make the demo's data from nothing where the demo's settings keep it, replacing what a seed made there before.
    Returns the folder it's in."""
    if not settings.demo:
        raise SeedError("Only the demo's settings say where its data goes: these don't have YJSP_DEMO=1")
    folder = _folder(settings)
    new = folder.with_name(folder.name + ".new")
    _clear(new)
    new.mkdir(parents=True)
    (new / MARK).write_text("Made by `yjsp-demo seed`: the demo's data, replaced each time it's made.\n")
    Seed(_in(settings, folder, new)).make()
    old = folder.with_name(folder.name + ".old")
    _clear(old)
    if folder.exists():
        folder.rename(old)
    new.rename(folder)
    _clear(old)
    return folder


def _folder(settings: Settings) -> Path:
    """The one folder the demo's data is all in: its database's, which holds Vault's and Yorg's folders too."""
    url = make_url(settings.database_url)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise SeedError(
            "The demo's database is a SQLite file in a folder of its own: set YJSP_DATABASE_URL to one, like "
            "sqlite:////srv/yjsp-demo/data/yjsp.db"
        )
    folder = Path(url.database).resolve().parent
    for name, inside in (("YJSP_VAULT_DIR", settings.vault_dir), ("YJSP_YORG_DIR", settings.yorg_dir)):
        if inside.resolve().parent != folder:
            raise SeedError(f"{name} has to be in the demo's database's folder, {folder}, like {folder / 'vault'}")
    if folder.exists() and any(folder.iterdir()) and not (folder / MARK).exists():
        raise SeedError(f"{folder} has something in it that isn't the demo's: give the demo a folder of its own")
    return folder


def _clear(folder: Path) -> None:
    """Remove a folder a seed made (or the start of one), and nothing else."""
    if not folder.exists():
        return
    if any(folder.iterdir()) and not (folder / MARK).exists():
        raise SeedError(f"{folder} has something in it that isn't the demo's: move it, and seed again")
    shutil.rmtree(folder)


def _in(settings: Settings, folder: Path, new: Path) -> Settings:
    """The demo's settings for making it in `new`, as a server it can make changes on: never one anyone can reach (it's
    reached only in this process), with nothing running on its own."""
    url = make_url(settings.database_url)
    database = new / Path(url.database or "yjsp.db").name
    return settings.model_copy(
        update={
            "demo": False,
            "env": "development",
            "dev_auth": False,
            "root_path": "",
            "database_url": f"sqlite:///{database}",
            "vault_dir": new / settings.vault_dir.resolve().relative_to(folder),
            "yorg_dir": new / settings.yorg_dir.resolve().relative_to(folder),
            "caliper_read_ahead": False,  # the demo's server reads the servo's 3D model once it starts
            "assistant_keep_warm": False,
            "deals_schedule": False,
            "web_dir": new / "no-web-app",
        }
    )


class Seed:
    """The demo's data, made through the API, one change at a time, each at its time in the semester."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.today = datetime.now(UTC)
        self.tokens: dict[str, dict[str, str]] = {}  # each person's, for the step it's at
        self.ids: dict[str, int] = {}
        self.client: TestClient

    def make(self) -> None:
        from ..app import create_app  # the app, which this module's package is part of

        app = create_app(self.settings)
        self.sessions = app.state.sessionmaker
        with TestClient(app) as self.client, self._clock():
            self.at(110)
            self._people(app)
            vault = self._vault()
            tests = self._yorg()
            diagrams = self._piper()
            self._buildflow(vault, tests, diagrams)
            self.at(0, hour=0)
            # Its guest, last: a seed that fails partway leaves a database the demo won't start on (demo.ready).
            with app.state.sessionmaker() as session:
                session.add(User(email=GUEST_EMAIL, name=GUEST_NAME, status=UserStatus.ACTIVE))
                # No one signs in to the demo: the seed's own credentials go.
                session.execute(delete(Token))
                session.execute(delete(ClientAuthCode))
                session.commit()

    # --- time ---------------------------------------------------------------------------------------------------------

    @contextmanager
    def _clock(self) -> Iterator[None]:
        """The server's time, while the seed makes its data: when `at` says, a second on each time it's asked, so what
        happens in a step happens in order."""
        self.when = self.today
        self.ticks = 0

        def now() -> datetime:
            self.ticks += 1
            return min(self.when + timedelta(seconds=self.ticks), self.today)

        db.clock = now
        try:
            yield
        finally:
            db.clock = None

    def at(self, days_ago: float, hour: int = 22, minute: int = 0) -> None:
        """Go to a time in the semester: so many days before the demo's made, at about that time of day (UTC: evening on
        the US's east coast). Each person signs in again there: a client's sign-in lapses after months unused."""
        day = self.today - timedelta(days=days_ago)
        self.when = min(day.replace(hour=hour, minute=minute, second=0, microsecond=0), self.today)
        self.ticks = 0
        self.tokens.clear()

    def day(self, days_ago: float) -> str:
        """A day in the semester, for a date the API takes (a review's day, a due date): in the future when negative."""
        return (self.today - timedelta(days=days_ago)).date().isoformat()

    # --- the API ------------------------------------------------------------------------------------------------------

    def call(self, who: str, method: str, path: str, **kwargs: Any) -> Any:
        if who not in self.tokens:
            with self.sessions() as session:
                user = session.get_one(User, self.ids[who])
                secret = auth.issue_token(session, user, kind=auth.CLIENT, name="the demo's seed")
            self.tokens[who] = {"Authorization": f"Bearer {secret}"}
        response = self.client.request(method, path, headers=self.tokens[who], **kwargs)
        if response.status_code >= 400:
            raise SeedError(f"{method} {path} as {who}: {response.status_code} {response.text}")
        return response.json() if response.content else None

    # --- people -------------------------------------------------------------------------------------------------------

    def _people(self, app: FastAPI) -> None:
        with app.state.sessionmaker() as session:
            for person in TEAM:
                user = User(email=person.email, name=person.name, status=UserStatus.ACTIVE, is_admin=person.admin)
                session.add(user)
                session.flush()
                self.ids[person.key] = user.id
            session.commit()

    # --- Vault --------------------------------------------------------------------------------------------------------

    def _vault(self) -> dict[str, int]:
        """The vault's folders, who can do what in them, and SparkFun's servo (its only CAD) as the airbrake's actuator,
        one part of it checked out. Its files' ids, by name."""
        self.at(104)
        # Everyone sees it all (the demo's guest too): members change it, and leads manage their subsystems' folders.
        self.call("ada", "PUT", "/api/grants", json={"path": "", "user_id": None, "role": "viewer"})
        for person in TEAM[1:]:
            self.call("ada", "PUT", "/api/grants", json={"path": "", "user_id": self.ids[person.key], "role": "editor"})
        for subsystem, lead in LEADS.items():
            path = f"Kestrel/{subsystem}"
            self.call("ada", "POST", "/api/folders", json={"path": path})
            self.call("ada", "PUT", "/api/grants", json={"path": path, "user_id": self.ids[lead], "role": "lead"})
        self.call("ada", "POST", "/api/folders", json={"path": "Test stand/Frame"})
        self.call("ada", "POST", "/api/folders", json={"path": "Test stand/Feed system"})

        self.at(64, hour=23, minute=10)
        servo = "Kestrel/Avionics/Airbrake actuator"
        files = {name: (HERE / "files" / name).read_bytes() for name in ("Embout.SLDPRT", "Servomoteur.SLDPRT")}
        assembly = (HERE / "files" / "9347.SLDASM").read_bytes()
        items = [self._item(f"{servo}/{name}", contents) for name, contents in files.items()]
        items.append(self._item(f"{servo}/9347.SLDASM", assembly, [f"{servo}/{name}" for name in files]))
        comment = (
            "SparkFun's model of the SM-S4303R servo (product 9347) for the airbrake actuator, as SparkFun has it: "
            "© SparkFun Electronics, CC BY-SA 4.0"
        )
        checked_in = self.call(
            "keiko", "POST", "/api/checkin", json={"comment": comment, "host": "KEIKO-LAPTOP", "items": items}
        )
        ids = {Path(each["file"]["path"]).name: each["file"]["id"] for each in checked_in["files"]}
        # A vendor's part, named as SparkFun names it, with what it is.
        titles = {
            "9347.SLDASM": "Servo, SM-S4303R",
            "Embout.SLDPRT": "Output spline",
            "Servomoteur.SLDPRT": "Servo case",
        }
        described = [{"file": ids[name], "title": title, "vendor": True} for name, title in titles.items()]
        self.call("keiko", "POST", "/api/files/metadata", json={"files": described})

        # Someone working on it now: the case, checked out on a laptop.
        self.at(2, hour=21, minute=40)
        self.call("elena", "POST", "/api/checkout", json={"files": [ids["Servomoteur.SLDPRT"]], "host": "ELENA-PC"})
        return ids

    def _item(self, path: str, contents: bytes, references: list[str] | None = None) -> dict[str, Any]:
        sha = hashlib.sha256(contents).hexdigest()
        self.call("keiko", "PUT", f"/api/blobs/{sha}", content=contents)
        return {
            "path": path,
            "sha256": sha,
            "size": len(contents),
            "references": [{"path": used} for used in references or []],
        }

    # --- Yorg ---------------------------------------------------------------------------------------------------------

    def _yorg(self) -> dict[str, int]:
        """The tests, in their campaign's folders; calculated channels everyone has; and a view of the latest hot fire.
        Their ids, by name."""
        self.at(70)
        kestrel = self.call("imani", "POST", "/api/yorg/folders", json={"name": "Kestrel"})["id"]
        folders = {
            name: self.call("imani", "POST", "/api/yorg/folders", json={"name": name, "parent_id": kestrel})["id"]
            for name in ("Proof tests", "Cold flows", "Hot fires")
        }
        tests: dict[str, int] = {}

        def upload(who: str, name: str, folder: str, description: str, contents: bytes) -> None:
            params = {"filename": f"{name}.csv", "name": name, "description": description, "folder": folders[folder]}
            made = self.call(who, "POST", "/api/yorg/datasets", params=params, content=contents)
            tests[name] = made["id"]

        self.at(66, hour=21)
        upload(
            "hugo",
            "PT-TK2 LOX tank proof",
            "Proof tests",
            "Hydrostatic proof of the LOX tank, TK-2, to 1.5 times its MEOP of 750 psi, held for a minute. Passed.",
            data.proof_test(seed=11, meop_psi=750),
        )
        self.at(59, hour=20)
        upload(
            "imani",
            "CF-1 fuel side water flow",
            "Cold flows",
            "Water through the fuel side's feed line and injector, from the run tank at 300 psi, MOV-01 open for 8 s.",
            data.cold_flow(seed=21, tank_psi=300, manifold_psi=210, flow_lbm=0.66, duration=8),
        )
        self.at(57, hour=20)
        upload(
            "imani",
            "CF-2 LOX side water flow",
            "Cold flows",
            "Water through the LOX side's feed line, cavitating venturi, and injector, at 300 psi, MOV-01 open for 8 s.",
            data.cold_flow(seed=22, tank_psi=300, manifold_psi=195, flow_lbm=1.43, duration=8),
        )
        self.at(31, hour=23, minute=20)
        upload(
            "ben",
            "HF-1 3 s hot fire",
            "Hot fires",
            "The first hot fire of Kestrel's engine on the stand: a 3 s burn at a chamber pressure of 290 psi.",
            data.hot_fire(seed=31, burn=3.0, chamber_psi=290, thrust_lbf=480, mixture=2.1),
        )
        self.at(12, hour=23, minute=5)
        upload(
            "grace",
            "HF-2 5 s hot fire",
            "Hot fires",
            "The second hot fire: 5 s at 300 psi in the chamber, LOX/RP-1 at a mixture ratio of 2.2, on the stand's "
            "new thrust mount.",
            data.hot_fire(seed=32, burn=5.0, chamber_psi=300, thrust_lbf=500, mixture=2.2),
        )

        self.at(30, hour=1)
        for name, expression, unit, description in (
            (
                "O/F",
                "where([FM-FU] > 0.05, [FM-OX] / [FM-FU])",
                "",
                "The mixture ratio, while fuel flows: LOX's flow over RP-1's.",
            ),
            ("Total flow", "[FM-OX] + [FM-FU]", "lbm/s", "Both propellants' flows."),
        ):
            body = {"name": name, "expression": expression, "unit": unit, "description": description}
            self.call("ben", "POST", "/api/yorg/formulas", json=body)

        self.at(11, hour=1, minute=30)
        latest = tests["HF-2 5 s hot fire"]
        # As the web app saves a view (web/src/yorg/layout.ts): each panel and series with an id of its own, and its
        # color from Yorg's palette, so the view opens as saved. The test's events mark ignition and shutdown.
        colors = iter(["#2f7ed8", "#e0a500", "#d64541", "#2ca25f", "#8e5bd6", "#16a5a5", "#e8743b", "#d9559a"])

        def series(*names: str) -> list[dict[str, Any]]:
            return [{"id": f"s-{name}", "dataset": latest, "channel": name, "color": next(colors)} for name in names]

        config = {
            "datasets": [{"id": latest, "shift": 0}],
            "panels": [
                {"id": "chamber", "title": "Chamber and tanks", "series": series("PT-4", "PT-2", "PT-3", "PT-1")},
                {"id": "thrust", "title": "Thrust", "series": series("LC-1")},
                {"id": "valves", "title": "Valves", "series": series("PV-1", "PV-2", "BV-1")},
            ],
            "window": [10.0, 20.0],
        }
        view = {
            "name": "HF-2 chamber, thrust, and valves",
            "description": "The burn, with the tanks' pressures and the valves' states.",
            "datasets": [latest],
            "config": config,
            "folder": "Kestrel",
        }
        self.call("ben", "POST", "/api/yorg/views", json=view)
        return tests

    # --- Piper --------------------------------------------------------------------------------------------------------

    def _piper(self) -> dict[str, int]:
        """The P&IDs: the stand's feed system, revised, released, and changed since; and its cold flow rigs. Their ids,
        by name."""
        drawings = {name: json.loads((HERE / "diagrams" / f"{name}.json").read_text()) for name in _DIAGRAMS}
        self.at(80)
        # The team's default color scheme is the made-up team's, not named for YJSP as a new site's is.
        default = next(scheme for scheme in self.call("ada", "GET", "/api/piper/schemes") if scheme["is_default"])
        self.call("ada", "PATCH", f"/api/piper/schemes/{default['id']}", json={"name": f"{SITE_NAME} standard"})
        folders = {
            name: self.call("chloe", "POST", "/api/piper/folders", json={"name": name})["id"]
            for name in ("Kestrel", "Test stand")
        }
        made: dict[str, int] = {}

        def new(who: str, name: str, folder: str, drawing: str, description: str) -> dict[str, Any]:
            body = {"name": name, "folder_id": folders[folder], "description": description}
            diagram = self.call(who, "POST", "/api/piper/diagrams", json=body | {"drawing": drawings[drawing]})
            made[name] = diagram["id"]
            return diagram

        def change(who: str, diagram: dict[str, Any], drawing: dict[str, Any]) -> dict[str, Any]:
            path = f"/api/piper/diagrams/{diagram['id']}"
            self.call(who, "POST", f"{path}/lock")
            saved = self.call(who, "PUT", f"{path}/drawing", json={"drawing": drawing, "version": diagram["version"]})
            self.call(who, "DELETE", f"{path}/lock")
            return saved

        self.at(72, hour=23)
        feed = new(
            "chloe",
            "Kestrel feed system",
            "Kestrel",
            "feed-system",
            "Nitrogen through a regulator presses the RP-1 and LOX tanks; each feeds the engine through its main valve, "
            "an orifice on the fuel side and a cavitating venturi on the LOX side.",
        )
        path = f"/api/piper/diagrams/{feed['id']}"
        self.at(71, hour=23, minute=30)
        self.call("chloe", "PATCH", f"{path}/revisions/1", json={"note": "First draw"})

        self.at(44, hour=22)
        revised = _with(drawings["feed-system"], {"REG-1": {"set": "525 psi"}})
        feed = change("hugo", feed, revised)
        self.at(43, hour=22, minute=30)
        release = self.call(
            "hugo",
            "POST",
            f"{path}/releases",
            json={"revision": 2, "approvers": [self.ids["ada"], self.ids["ben"]], "note": "For HF-1's test readiness"},
        )
        self.at(42, hour=18)
        self.call("ben", "POST", f"{path}/releases/{release['id']}/approve", json={"comment": ""})
        self.at(41, hour=19)
        self.call("ada", "POST", f"{path}/releases/{release['id']}/approve", json={"comment": "Good to go"})

        self.at(9, hour=22, minute=15)
        change("chloe", feed, _with(revised, {"TK-1": {"volume": "6.5 L"}, "TK-2": {"volume": "6.5 L"}}))

        self.at(62, hour=21)
        new(
            "imani",
            "Fuel side cold flow",
            "Test stand",
            "cold-flow",
            "Water from the run tank, at a pressure the test sets, through MOV-01 and the injector, to find its "
            "discharge coefficient.",
        )
        self.at(60, hour=21)
        new(
            "leo",
            "Pressurized run tank",
            "Test stand",
            "pressurized-flow",
            "The run tank pressed with nitrogen through a regulator, vented, and flowed through a cavitating venturi.",
        )
        return made

    # --- Buildflow ----------------------------------------------------------------------------------------------------

    def _buildflow(self, vault: dict[str, int], tests: dict[str, int], diagrams: dict[str, int]) -> None:
        """Kestrel's bill of design, and its stand's: leads, progress through design, build, and test, and links to
        their CAD, P&IDs, and tests."""
        self.at(90)
        rocket = self.call(
            "ada",
            "POST",
            "/api/buildflow/programs",
            json={
                "name": "Kestrel",
                "description": "A 500 lbf pressure-fed LOX/RP-1 rocket, the team's first liquid flight vehicle.",
                "template": "rocket",
            },
        )
        stand = self.call(
            "ada",
            "POST",
            "/api/buildflow/programs",
            json={
                "name": "Kestrel test stand",
                "description": "The horizontal stand Kestrel's engine and feed system are tested on.",
                "template": "stand",
            },
        )
        self._rocket(rocket, vault, tests, diagrams)
        self._stand(stand, tests, diagrams)

    def _rocket(
        self, program: dict[str, Any], vault: dict[str, int], tests: dict[str, int], diagrams: dict[str, int]
    ) -> None:
        stones = {m["name"]: m["id"] for m in program["milestones"]}
        subsystems = {s["id"]: s["name"] for s in program["subsystems"]}
        components = {c["name"]: c for c in program["components"]}
        teams = {
            "Propulsion": "grace",
            "Fluids": "hugo",
            "Structures": "jonas",
            "Avionics": "keiko",
            "Recovery": "farid",
        }

        self.at(88)
        for component in program["components"]:
            subsystem = subsystems[component["subsystem_id"]]
            lead = LEADS[subsystem]
            self.call("ada", "PATCH", f"/api/buildflow/components/{component['id']}", json={"lead_id": self.ids[lead]})
            self.call(
                lead,
                "PUT",
                f"/api/buildflow/components/{component['id']}/people",
                json={"phase": "design", "user_ids": [self.ids[lead], self.ids[teams[subsystem]]]},
            )

        def progress(name: str, milestone: str, who: str, **change: Any) -> None:
            component = components[name]["id"]
            self.call(who, "PUT", f"/api/buildflow/components/{component}/progress/{stones[milestone]}", json=change)

        # Design: every component's first reviews, then most past PDR, and some past CDR; bought parts skip them.
        order = list(components)
        for at, milestone, share in ((84, "DCR", 1.0), (74, "CoDR", 1.0), (52, "PDR", 0.85), (21, "CDR", 0.5)):
            self.at(at, hour=23)
            for index, name in enumerate(order):
                component = components[name]
                lead = LEADS[subsystems[component["subsystem_id"]]]
                if component["bought"]:
                    progress(name, milestone, lead, status="skipped")
                elif index < round(share * len(order)):
                    progress(name, milestone, lead, status="done", done_on=self.day(at))
                elif milestone == "CDR":
                    progress(name, milestone, lead, status="in_progress", due=self.day(-12 - index))
                else:
                    progress(name, milestone, lead, status="in_progress", due=self.day(at - 30))

        # The feed system's PDR, held for the whole subsystem at once, with its notes; and the CDR coming up for the
        # structures and recovery components still in design.
        self.at(52, hour=23)
        fluids = [c["id"] for c in program["components"] if subsystems[c["subsystem_id"]] == "Fluids"]
        notes = (
            "Board: Ada (chair), Grace, Hugo, and two alumni reviewers. Passed, with two actions:\n\n"
            "- **RFA 1** (Hugo): a relief valve downstream of the regulator, sized for its full flow.\n"
            "- **RFA 2** (Chloe): the MOV flange bolts' torque on its drawing.\n\n"
            "Next: the feed system's CDR, with the cold flows' results."
        )
        body = {
            "milestone_id": stones["PDR"],
            "name": "Feed system PDR",
            "held_on": self.day(52),
            "component_ids": fluids,
            "notes": notes,
        }
        self.call("hugo", "POST", f"/api/buildflow/programs/{program['id']}/reviews", json=body)
        self.at(20, hour=10)
        coming = [
            c["id"]
            for c in program["components"]
            if subsystems[c["subsystem_id"]] in ("Structures", "Recovery")
            and not c["bought"]
            and order.index(c["name"]) >= round(0.5 * len(order))
        ]
        body = {
            "milestone_id": stones["CDR"],
            "name": "Structures and recovery CDR",
            "held_on": self.day(-16),
            "component_ids": coming,
        }
        self.call("jonas", "POST", f"/api/buildflow/programs/{program['id']}/reviews", json=body)

        # Build, for what's past CDR, and the bought parts: drawings, then ordering, and the first parts made.
        self.at(18, hour=22)
        for name in order:
            component = components[name]
            lead = LEADS[subsystems[component["subsystem_id"]]]
            if component["bought"]:
                progress(name, "Drawings", lead, status="skipped")
                progress(name, "Procurement", lead, status="done", done_on=self.day(19))
            elif order.index(name) < round(0.5 * len(order)):
                progress(name, "Drawings", lead, status="done", done_on=self.day(17))
                progress(name, "Procurement", lead, status="in_progress", due=self.day(-7))
        self.at(6, hour=21)
        progress("Thrust chamber", "Manufacturing", "ben", status="done", done_on=self.day(6))
        progress("Injector", "Manufacturing", "ben", status="in_progress", note="Holes drilled; flow-checking next")
        progress(
            "Pressure regulator",
            "Procurement",
            "chloe",
            status="blocked",
            note="The vendor's lead time slipped to six weeks: looking for another",
        )

        # The build plan: what each part takes to get or make, the day it has to be ready for the vehicle's
        # integration, and what has to be ready before it can be started. The regulator's lead time has slipped.
        self.at(17, hour=20)
        weeks = {
            "Thrust chamber": 6,
            "Injector": 4,
            "Igniter": 2,
            "Main oxidizer valve": 10,
            "Main fuel valve": 8,
            "LOX tank": 8,
            "LOX vent valve": 6,
            "Fuel tank": 8,
            "Pressurant tank": 16,
            "Pressure regulator": 12,
            "Thrust structure": 3,
            "Fins": 2,
            "Intertank": 3,
            "Nose cone": 3,
            "Flight computer": 4,
            "Telemetry radio": 4,
            "Batteries": 2,
            "Drogue parachute": 2,
            "Main parachute": 3,
        }
        ready = {"LOX tank": -40, "Fuel tank": -40, "Thrust chamber": -45, "Injector": -45}
        for name, lead in weeks.items():
            component = components[name]
            who = LEADS[subsystems[component["subsystem_id"]]]
            change = {"lead_days": lead * 7, "need_by": self.day(ready.get(name, -60))}
            self.call(who, "PATCH", f"/api/buildflow/components/{component['id']}", json=change)
        for name, first in (
            ("Thrust structure", ["Thrust chamber"]),
            ("Intertank", ["LOX tank", "Fuel tank"]),
            ("Fins", ["Thrust structure"]),
        ):
            body = {"component_ids": [components[each]["id"] for each in first]}
            self.call("jonas", "PUT", f"/api/buildflow/components/{components[name]['id']}/needs", json=body)

        # Its BOM, read in from the team's spreadsheet: the valves and fittings on order, the engine's hardware in hand.
        self.at(16, hour=19)
        bom = [
            ("Main oxidizer valve", "SS-63TS8", "1/2 in ball valve, 316 SS", 1, "Swagelok", 41250, 70, "ordered"),
            ("Main oxidizer valve", "MS-133-H", "Pneumatic actuator", 1, "Swagelok", 38900, 56, "to_order"),
            ("Main fuel valve", "SS-63TS8", "1/2 in ball valve, 316 SS", 1, "Swagelok", 41250, 56, "ordered"),
            (
                "Pressure regulator",
                "TESCOM 26-1000",
                "Dome-loaded regulator, 6000 psi",
                1,
                "Emerson",
                189000,
                84,
                "to_order",
            ),
            (
                "Pressurant tank",
                "COPV-2L-6K",
                "2 L carbon composite tank, 6000 psi",
                1,
                "Luxfer",
                240000,
                112,
                "to_order",
            ),
            ("LOX vent valve", "SS-4BK-1C", "Bellows-sealed valve, 1/4 in", 1, "Swagelok", 21500, 42, "ordered"),
            ("Injector", "91251A463", "Socket head screw, 1/4-20 x 1 in", 12, "McMaster-Carr", 38, 2, "received"),
            ("Injector", "9452K33", "O-ring, -214, Viton", 4, "McMaster-Carr", 120, 3, "received"),
            ("Thrust chamber", "C101-PLATE-1", "C101 copper plate, 1 in", 2, "Online Metals", 31200, 21, "received"),
            (
                "LOX tank",
                "6061-TUBE-8",
                "6061-T6 tube, 8 in OD, 0.125 in wall",
                4,
                "Online Metals",
                9800,
                28,
                "to_order",
            ),
            (
                "Fuel tank",
                "6061-TUBE-8",
                "6061-T6 tube, 8 in OD, 0.125 in wall",
                3,
                "Online Metals",
                9800,
                28,
                "to_order",
            ),
            ("Flight computer", "TEENSY-4.1", "Teensy 4.1", 2, "PJRC", 3160, 10, "received"),
        ]
        lines = [
            {
                "component_id": components[name]["id"],
                "part_number": number,
                "description": description,
                "quantity": quantity,
                "vendor": vendor,
                "unit_cost": cost,
                "lead_days": lead,
                "status": status,
            }
            for name, number, description, quantity, vendor, cost, lead, status in bom
        ]
        body = {"lines": lines, "component_id": None, "file": "Kestrel BOM.xlsx"}
        self.call("chloe", "PUT", f"/api/buildflow/programs/{program['id']}/bom", json=body)

        # Test: the engine's parts were proven on the stand.
        self.at(32, hour=21)
        for name in ("Thrust chamber", "Injector"):
            progress(name, "TRR", "ben", status="done", done_on=self.day(32))
        self.at(11, hour=22)
        for name in ("Thrust chamber", "Injector"):
            progress(name, "Testing", "ben", status="done", done_on=self.day(12))
            progress(name, "QRR", "ben", status="in_progress", due=self.day(-5))

        # Links: the engine's tests, the feed system's P&ID at each valve, and the airbrake's CAD.
        self.at(10, hour=22, minute=45)

        def link(name: str, phase: str, kind: str, url: str, title: str = "", milestone: str | None = None) -> None:
            body: dict[str, Any] = {"phase": phase, "kind": kind, "url": url, "title": title}
            if milestone:
                body["milestone_id"] = stones[milestone]
            component = components[name]["id"]
            self.call("ben", "POST", f"/api/buildflow/components/{component}/links", json=body)

        feed = diagrams["Kestrel feed system"]
        for name in ("Thrust chamber", "Injector"):
            link(name, "test", "data", f"/yorg/datasets/{tests['HF-1 3 s hot fire']}")
            link(name, "test", "data", f"/yorg/datasets/{tests['HF-2 5 s hot fire']}")
        for name, tag in (
            ("Main oxidizer valve", "PV-2"),
            ("Main fuel valve", "PV-1"),
            ("LOX tank", "TK-2"),
            ("Fuel tank", "TK-1"),
            ("Pressurant tank", "B-1"),
            ("Pressure regulator", "REG-1"),
        ):
            link(name, "design", "pid", f"/piper/diagrams/{feed}?find={tag}")
        link("LOX tank", "test", "data", f"/yorg/datasets/{tests['PT-TK2 LOX tank proof']}", milestone="Testing")

        self.at(9, hour=20)
        airbrake = self.call(
            "ada",
            "POST",
            f"/api/buildflow/programs/{program['id']}/components",
            json={
                "name": "Airbrake actuator",
                "subsystem_id": next(i for i, s in subsystems.items() if s == "Avionics"),
                "description": "A continuous-rotation servo that opens the airbrakes after burnout.",
                "bought": True,
                "x": 186,
                "y": 2.2,
            },
        )
        components["Airbrake actuator"] = airbrake
        self.call("ada", "PATCH", f"/api/buildflow/components/{airbrake['id']}", json={"lead_id": self.ids["elena"]})
        link("Airbrake actuator", "design", "cad", f"/vault/file/{vault['9347.SLDASM']}", "Servo, SparkFun 9347")
        progress("Airbrake actuator", "Procurement", "elena", status="done", done_on=self.day(8))

    def _stand(self, program: dict[str, Any], tests: dict[str, int], diagrams: dict[str, int]) -> None:
        """The stand: designed, built, and tested, and in use."""
        stones = {m["name"]: m["id"] for m in program["milestones"]}
        self.at(86)
        for component in program["components"]:
            self.call(
                "ada", "PATCH", f"/api/buildflow/components/{component['id']}", json={"lead_id": self.ids["imani"]}
            )
        steps = [
            (82, ("DCR", "CoDR")),
            (76, ("PDR",)),
            (70, ("CDR",)),
            (66, ("Drawings", "Procurement")),
            (63, ("Manufacturing", "Inspection")),
            (61, ("TRR",)),
            (58, ("Testing", "QRR")),
        ]
        for at, milestones in steps:
            self.at(at, hour=22)
            for component in program["components"]:
                for milestone in milestones:
                    skip = component["bought"] and milestone in ("DCR", "CoDR", "PDR", "CDR", "Drawings")
                    change = {"status": "skipped"} if skip else {"status": "done", "done_on": self.day(at)}
                    path = f"/api/buildflow/components/{component['id']}/progress/{stones[milestone]}"
                    self.call("imani", "PUT", path, json=change)
        self.at(56, hour=22)
        first = program["components"][0]["id"]
        for name in ("CF-1 fuel side water flow", "CF-2 LOX side water flow"):
            body = {"phase": "test", "kind": "data", "url": f"/yorg/datasets/{tests[name]}", "title": ""}
            self.call("imani", "POST", f"/api/buildflow/components/{first}/links", json=body)
        for name in ("Fuel side cold flow", "Pressurized run tank"):
            body = {"phase": "design", "kind": "pid", "url": f"/piper/diagrams/{diagrams[name]}", "title": ""}
            self.call("imani", "POST", f"/api/buildflow/components/{first}/links", json=body)


# The P&IDs the seed draws from (diagrams/): Piper's examples.
_DIAGRAMS = ("feed-system", "cold-flow", "pressurized-flow")


def _with(document: dict[str, Any], changes: dict[str, dict[str, str]]) -> dict[str, Any]:
    """A drawing with some of its parts' properties changed, by their tags: a revision someone made."""
    changed = json.loads(json.dumps(document))
    for page in changed["pages"]:
        for part in page["parts"]:
            if part.get("tag") in changes:
                part["props"] = {**part.get("props", {}), **changes[part["tag"]]}
    return changed
