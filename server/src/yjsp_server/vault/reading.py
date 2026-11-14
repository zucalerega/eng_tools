"""Reading Caliper's 3D models ahead: the server makes each SolidWorks part's and assembly's model from its file once
it's checked in, in a thread of its own, so that Caliper has it when the file's first opened, and a big assembly needn't
wait for hundreds of parts to be read while someone watches. Which versions, and making each, are the vault's
(vault.caliper_unread, vault.read_ahead); this is when.

One at a time, so that of the two files the server reads at once, one turn is left for whoever's looking; and after
each it rests for as long as the read took, as reading is Python's work and shares the server's one interpreter with
every request. A version waits a while after its check-in, since Vault for SolidWorks makes its own model of what it
checks in a moment later, and the server's would only be thrown away. What couldn't be read isn't tried again until
the server restarts: a version's bytes never change, so neither does that (a newer reader comes with a restart).
"""

import logging
import threading
import time
from datetime import datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from ..db import utcnow
from ..errors import ApiError, Conflict
from . import vault
from .storage import BlobStore

log = logging.getLogger(__name__)

GRACE = timedelta(minutes=10)  # after a check-in, for Vault for SolidWorks to make its own
IDLE = 300.0  # seconds between looks for something to read, when there was nothing
REST = (1.0, 60.0)  # seconds' rest after a read, at least and at most


class Reader:
    """Reads models ahead, from the server's start to its stop."""

    def __init__(self, sessions: sessionmaker[Session], store: BlobStore, grace: timedelta = GRACE):
        self.sessions, self.store, self.grace = sessions, store, grace
        self._tried: set[tuple[int, int]] = set()  # (file id, version): read, or found unreadable
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="caliper-reader", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        wait = 0.0
        while not self._stop.wait(wait):
            started = time.monotonic()
            try:
                read = self.step()
            except Exception:  # a bad look mustn't stop the next ones
                log.exception("Reading 3D models ahead failed")
                read = False
            wait = min(max(time.monotonic() - started, REST[0]), REST[1]) if read else IDLE

    def step(self, at: datetime | None = None) -> bool:
        """Read the newest version that wants a model, of those checked in long enough before now (at). Whether there
        was one: not when there's nothing to read, or the server's busy reading for people, whose turn comes first."""
        with self.sessions() as db:
            before = (at or utcnow()) - self.grace
            waiting = [key for key in vault.caliper_unread(db, self.store, before) if key not in self._tried]
            if not waiting:
                return False
            file_id, version = waiting[0]
            try:
                vault.read_ahead(db, self.store, file_id, version)
            except Conflict:
                return False
            except ApiError as e:  # unreadable, or gone meanwhile: Caliper says why when it's opened
                log.info("No 3D model read ahead of file %s v%s: %s", file_id, version, e.message)
            except Exception:
                self._tried.add((file_id, version))  # whatever it is, not again and again
                raise
            self._tried.add((file_id, version))
            return True
