"""Where Yorg keeps files (YJSP_YORG_DIR): each dataset's upload, and the arrays read from it."""

import os
import shutil
import tempfile
import time
from pathlib import Path


def _move(source: Path, target: Path) -> None:
    """os.replace, trying again for a few seconds on Windows, which won't move a file (or a folder with one in it) while
    something has it open: a virus scanner, or the search indexer, looking at what was just written."""
    for pause in (0.05, 0.1, 0.2, 0.4, 0.8, 1.6):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if os.name != "nt":
                raise
            time.sleep(pause)
    os.replace(source, target)


class DataFiles:
    """datasets/<id>/source is the file as it was uploaded; datasets/<id>/<version>/ holds the arrays of a read."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._tmp = self.root / "tmp"
        self._tmp.mkdir(parents=True, exist_ok=True)

    def folder(self, dataset_id: int) -> Path:
        return self.root / "datasets" / str(dataset_id)

    def source(self, dataset_id: int) -> Path:
        return self.folder(dataset_id) / "source"

    def data(self, dataset_id: int, version: str) -> Path:
        return self.folder(dataset_id) / version

    def temp_path(self) -> Path:
        """A new empty file for an upload in progress, on the same filesystem as the datasets."""
        fd, name = tempfile.mkstemp(dir=self._tmp, suffix=".part")
        os.close(fd)
        return Path(name)

    def work_folder(self) -> Path:
        """A new empty folder for a read in progress."""
        return Path(tempfile.mkdtemp(dir=self._tmp))

    def keep_source(self, dataset_id: int, upload: Path) -> None:
        self.folder(dataset_id).mkdir(parents=True, exist_ok=True)
        _move(upload, self.source(dataset_id))

    def keep_data(self, dataset_id: int, work: Path, version: str) -> None:
        self.folder(dataset_id).mkdir(parents=True, exist_ok=True)  # a piece of another dataset has no upload
        _move(work, self.data(dataset_id, version))

    def drop(self, folder: Path) -> None:
        """Delete a read's arrays (replaced by a newer read, or from a read that failed). The upload stays."""
        shutil.rmtree(folder, ignore_errors=True)
