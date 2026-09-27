"""The folder tree and one user's effective permissions on it.

Both are loaded per request: a team vault has hundreds of folders, not millions.
"""

from collections import defaultdict
from collections.abc import Iterable

from . import paths
from .errors import Forbidden, NotFound
from .models import File, Folder, Grant, Role, User

ADMIN_RANK = 100


class Tree:
    """Every folder by id, deleted ones too (to restore them, and for their files' paths); only live ones by path."""

    def __init__(self, folders: Iterable[Folder]):
        self._paths: dict[int, str] = {}
        self.by_id: dict[int, Folder] = {}
        self.children: dict[int, dict[str, Folder]] = defaultdict(dict)
        self._root: Folder | None = None
        for folder in folders:
            self.add(folder)
        if self._root is None:
            raise RuntimeError("the vault has no root folder; vault.init_vault creates it")

    @property
    def root(self) -> Folder:
        assert self._root is not None
        return self._root

    def add(self, folder: Folder) -> None:
        self.by_id[folder.id] = folder
        if folder.parent_id is None:
            self._root = folder
        elif folder.deleted_at is None:
            self.children[folder.parent_id][folder.name_key] = folder

    def path(self, folder_id: int) -> str:
        cached = self._paths.get(folder_id)
        if cached is None:
            folder = self.by_id[folder_id]
            cached = "" if folder.parent_id is None else paths.join(self.path(folder.parent_id), folder.name)
            self._paths[folder_id] = cached
        return cached

    def label(self, folder_id: int) -> str:
        """The folder's path for messages."""
        return self.path(folder_id) or "the vault root"

    def file_path(self, file: File) -> str:
        return paths.join(self.path(file.folder_id), file.name)

    def deepest(self, names: list[str]) -> tuple[Folder, int]:
        """The deepest existing folder along names, and how many of the names it covers."""
        folder = self.root
        for depth, name in enumerate(names):
            child = self.children[folder.id].get(paths.key(name))
            if child is None:
                return folder, depth
            folder = child
        return folder, len(names)

    def find(self, names: list[str]) -> Folder | None:
        folder, depth = self.deepest(names)
        return folder if depth == len(names) else None

    def ancestry(self, folder_id: int) -> list[int]:
        """folder_id followed by its ancestors, up to the root."""
        chain = []
        current: int | None = folder_id
        while current is not None:
            chain.append(current)
            current = self.by_id[current].parent_id
        return chain


class Access:
    """What one user may do where. A grant covers its folder and everything below; the highest role wins."""

    def __init__(self, user: User, tree: Tree, grants: Iterable[Grant]):
        self.user = user
        self.tree = tree
        self._direct: dict[int, int] = {}
        for grant in grants:
            if grant.user_id is None or grant.user_id == user.id:
                self._direct[grant.folder_id] = max(self._direct.get(grant.folder_id, 0), grant.role.rank)
        self._ranks: dict[int, int] = {}
        # Folders on the way down to a granted folder stay visible so people can navigate to it.
        live = [granted for granted in self._direct if tree.by_id[granted].deleted_at is None]
        self._passage = {tree.root.id} | {f for granted in live for f in tree.ancestry(granted)}

    def rank(self, folder_id: int) -> int:
        if self.user.is_admin:
            return ADMIN_RANK
        rank = self._ranks.get(folder_id)
        if rank is None:
            parent = self.tree.by_id[folder_id].parent_id
            inherited = 0 if parent is None else self.rank(parent)
            rank = max(inherited, self._direct.get(folder_id, 0))
            self._ranks[folder_id] = rank
        return rank

    def role(self, folder_id: int) -> str | None:
        """'admin', 'lead', 'editor', 'viewer', or None when the folder is only a way through."""
        rank = self.rank(folder_id)
        if rank >= ADMIN_RANK:
            return "admin"
        return next((role.value for role in (Role.LEAD, Role.EDITOR, Role.VIEWER) if rank >= role.rank), None)

    def can(self, folder_id: int, role: Role) -> bool:
        return self.rank(folder_id) >= role.rank

    def visible(self, folder_id: int) -> bool:
        return self.can(folder_id, Role.VIEWER) or folder_id in self._passage

    def require(self, folder_id: int, role: Role, action: str) -> None:
        if self.can(folder_id, role):
            return
        if not self.visible(folder_id):
            raise NotFound("Not found")
        raise Forbidden(
            f"You need {role} access to {self.tree.label(folder_id)} to {action}",
            needed=role.value,
            folder=self.tree.path(folder_id),
        )
