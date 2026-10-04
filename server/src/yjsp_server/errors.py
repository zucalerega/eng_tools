"""Errors the API returns as JSON: {"error": code, "message": ..., "details": {...}}."""

from typing import Any


class ApiError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, **details: Any):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


class Forbidden(ApiError):
    status = 403
    code = "forbidden"


class NotFound(ApiError):
    status = 404
    code = "not_found"


class Conflict(ApiError):
    status = 409
    code = "conflict"


class TooLarge(ApiError):
    status = 413
    code = "too_large"
