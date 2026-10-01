"""Yorg's scripts (/api/yorg/scripts): Python that pulls a test's channels and works them over. They run in the browser
(Pyodide), never on the server; the server only keeps them, each with a name and a folder (a path like
"Hotfires/Injector"), for everyone. Anyone can save one, or a copy of another's; only whoever saved it, or an admin,
can change or delete it (as a view), and those saved before scripts were anyone's only an admin.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator

from ..api.deps import ActiveUser
from ..models import User
from .datasets import can_change, check_can_change
from .saved import Saved
from .schemas import FolderPath

router = APIRouter(prefix="/api/yorg/scripts", tags=["yorg-scripts"])

MAX_CODE = 512 * 1024  # characters: far more than a script, far less than a dataset


def get_scripts(request: Request) -> Saved:
    return request.app.state.yorg_scripts


SavedScripts = Annotated[Saved, Depends(get_scripts)]


class ScriptIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    folder: FolderPath = ""  # "" for none, or "Hotfires/Injector"
    code: str = Field(default="", max_length=MAX_CODE)
    # The tests it works on (dataset ids), the first the one yorg.channel() takes from unless told another.
    datasets: list[int] = Field(default_factory=list, max_length=20)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("a script needs a name")
        return value


def _out(user: User, script: dict[str, Any]) -> dict[str, Any]:
    """A script as someone sees it: with whether they can change it."""
    return {**script, "can_change": can_change(user, script.get("created_by_id"))}


@router.get("")
def get_saved_scripts(user: ActiveUser, scripts: SavedScripts) -> list[dict[str, Any]]:
    """Every script (without its code), the latest changed first."""
    return [_out(user, script) for script in scripts.all()]


@router.post("", status_code=201)
def post_script(body: ScriptIn, user: ActiveUser, scripts: SavedScripts) -> dict[str, Any]:
    return _out(user, scripts.add(user, **body.model_dump()))


@router.get("/{script_id}")
def get_script(script_id: str, user: ActiveUser, scripts: SavedScripts) -> dict[str, Any]:
    return _out(user, scripts.get(script_id))


@router.put("/{script_id}")
def put_script(script_id: str, body: ScriptIn, user: ActiveUser, scripts: SavedScripts) -> dict[str, Any]:
    check_can_change(user, scripts.get(script_id).get("created_by_id"), "script")
    return _out(user, scripts.change(user, script_id, **body.model_dump()))


@router.delete("/{script_id}", status_code=204)
def delete_script(script_id: str, user: ActiveUser, scripts: SavedScripts) -> Response:
    check_can_change(user, scripts.get(script_id).get("created_by_id"), "script")
    scripts.remove(script_id)
    return Response(status_code=204)
