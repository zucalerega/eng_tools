"""`cvc-server` (or `python -m cvc_server`): run the server."""

import uvicorn

from .config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run("cvc_server.app:create_app", factory=True, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
