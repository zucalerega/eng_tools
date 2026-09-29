"""Yorg's scripts (/api/yorg/scripts), for admins while the Python window is tried out: Python that pulls a test's
channels and works them over. They run in the browser (Pyodide), never on the server; the server only keeps them,
each with a name and a folder (a path like "Hotfires/Injector"), for every admin.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator

from .saved import Saved
from .system.api import AdminUser

router = APIRouter(prefix="/api/yorg/scripts", tags=["yorg-scripts"])

MAX_CODE = 512 * 1024  # characters: far more than a script, far less than a dataset


def get_scripts(request: Request) -> Saved:
    return request.app.state.yorg_scripts


SavedScripts = Annotated[Saved, Depends(get_scripts)]


class ScriptIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    folder: str = Field(default="", max_length=300)  # "" for none, or "Hotfires/Injector"
    code: str = Field(default="", max_length=MAX_CODE)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("a script needs a name")
        return value

    @field_validator("folder")
    @classmethod
    def _folder(cls, value: str) -> str:
        """A folder path, tidied: forward slashes, no empty or padded parts."""
        return "/".join(part.strip() for part in value.replace("\\", "/").split("/") if part.strip())


@router.get("")
def get_saved_scripts(user: AdminUser, scripts: SavedScripts) -> list[dict[str, Any]]:
    """Every script (without its code), the latest changed first."""
    return scripts.all()


@router.post("", status_code=201)
def post_script(body: ScriptIn, user: AdminUser, scripts: SavedScripts) -> dict[str, Any]:
    return scripts.add(user, **body.model_dump())


@router.get("/{script_id}")
def get_script(script_id: str, user: AdminUser, scripts: SavedScripts) -> dict[str, Any]:
    return scripts.get(script_id)


@router.put("/{script_id}")
def put_script(script_id: str, body: ScriptIn, user: AdminUser, scripts: SavedScripts) -> dict[str, Any]:
    return scripts.change(user, script_id, **body.model_dump())


@router.delete("/{script_id}", status_code=204)
def delete_script(script_id: str, user: AdminUser, scripts: SavedScripts) -> Response:
    scripts.remove(script_id)
    return Response(status_code=204)
