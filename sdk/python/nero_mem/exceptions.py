"""
Exception hierarchy for the nero-mem Python SDK.

All SDK exceptions derive from NeroMemError, enabling
callers to catch all SDK errors with a single except clause.

HTTP status code mapping:
  400 → ValidationError
  401/403 → AuthenticationError
  404 → NotFoundError
  5xx → ServerError
  Connection failures → ConnectionError
  Timeouts → TimeoutError
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class NeroMemError(Exception):
    """Base exception for all nero-mem SDK errors."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class ConnectionError(NeroMemError):
    """Raised when the SDK cannot connect to the nero-mem server."""

    pass


class AuthenticationError(NeroMemError):
    """Raised on 401/403 responses."""

    pass


class NotFoundError(NeroMemError):
    """Raised on 404 responses (e.g., conversation not found)."""

    pass


class ValidationError(NeroMemError):
    """Raised on 400 responses (e.g., invalid input)."""

    pass


class ServerError(NeroMemError):
    """Raised on 5xx responses."""

    pass


class TimeoutError(NeroMemError):
    """Raised when a request exceeds the configured timeout."""

    pass


def raise_for_status(status_code: int, body: Dict[str, Any]) -> None:
    """
    Map an HTTP error status code to the appropriate SDK exception.

    Args:
        status_code: The HTTP status code from the response.
        body: The parsed JSON response body (may contain 'error' or 'message').
    """
    message = body.get("error") or body.get("message") or f"HTTP {status_code}"

    if status_code == 400:
        raise ValidationError(message, status_code=status_code, response_body=body)
    elif status_code in (401, 403):
        raise AuthenticationError(message, status_code=status_code, response_body=body)
    elif status_code == 404:
        raise NotFoundError(message, status_code=status_code, response_body=body)
    elif status_code == 408:
        raise TimeoutError(message, status_code=status_code, response_body=body)
    elif 500 <= status_code < 600:
        raise ServerError(message, status_code=status_code, response_body=body)
    elif status_code >= 400:
        raise NeroMemError(message, status_code=status_code, response_body=body)
