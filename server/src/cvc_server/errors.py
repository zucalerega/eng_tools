"""Errors the API returns as JSON: {"error": code, "message": ..., "details": {...}}."""

from typing import Any


class CvcError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, **details: Any):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class Unauthorized(CvcError):
    status = 401
    code = "unauthorized"


class Forbidden(CvcError):
    status = 403
    code = "forbidden"


class NotFound(CvcError):
    status = 404
    code = "not_found"


class Conflict(CvcError):
    status = 409
    code = "conflict"


class TooLarge(CvcError):
    status = 413
    code = "too_large"
