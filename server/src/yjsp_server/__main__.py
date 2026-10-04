"""`yjsp-server` (or `python -m yjsp_server`): run the server."""

import uvicorn

from .config import Settings, refuse_old_settings


def main() -> None:
    refuse_old_settings()
    settings = Settings()
    uvicorn.run("yjsp_server.app:create_app", factory=True, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
