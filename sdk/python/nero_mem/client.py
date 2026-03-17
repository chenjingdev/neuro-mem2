"""
Synchronous MemoryClient for the nero-mem2 REST API.

Usage:
    from nero_mem import MemoryClient, IngestRequest, IngestMessageInput, RecallRequest

    client = MemoryClient("http://localhost:3000")

    # Ingest a conversation
    response = client.ingest(IngestRequest(
        source="claude-code",
        messages=[
            IngestMessageInput(role="user", content="What is Python?"),
            IngestMessageInput(role="assistant", content="Python is a programming language."),
        ],
    ))

    # Recall relevant memories
    result = client.recall(RecallRequest(query_text="Tell me about Python"))
    for item in result.items:
        print(f"[{item.node_type}] {item.content} (score={item.score:.3f})")
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from nero_mem.exceptions import (
    ConnectionError,
    NeroMemError,
    TimeoutError,
    raise_for_status,
)
from nero_mem.models import (
    AppendMessageRequest,
    AppendMessageResponse,
    Conversation,
    IngestRequest,
    IngestResponse,
    RecallRequest,
    RecallResponse,
)


class MemoryClient:
    """
    Synchronous client for the nero-mem2 memory REST API.

    Uses only the Python standard library (urllib) — no external dependencies.
    For async support, use AsyncMemoryClient instead.

    Args:
        base_url: The base URL of the nero-mem2 server (e.g., "http://localhost:3000").
        api_key: Optional API key for authentication.
        timeout: Request timeout in seconds (default: 30).
        default_headers: Additional headers to include in every request.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        default_headers: Optional[Dict[str, str]] = None,
    ):
        # Strip trailing slash for consistent URL joining
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._default_headers = default_headers or {}

    # ─── Public API ──────────────────────────────────────────

    def ingest(self, request: IngestRequest) -> IngestResponse:
        """
        Ingest a complete conversation with all its messages.

        Each message is stored as an immutable record. The server returns
        the full conversation with generated IDs and timestamps.

        Args:
            request: The conversation to ingest.

        Returns:
            IngestResponse with the stored conversation.

        Raises:
            ValidationError: If the input is invalid (empty messages, bad role, etc.).
            ConnectionError: If the server is unreachable.
            ServerError: If the server encounters an internal error.
        """
        body = self._post("/api/v1/conversations", request.to_dict())
        return IngestResponse.from_dict(body)

    def append_message(self, request: AppendMessageRequest) -> AppendMessageResponse:
        """
        Append a single message to an existing conversation.

        Supports per-turn ingestion for real-time use. The server emits
        extraction events for the new message.

        Args:
            request: The message to append.

        Returns:
            AppendMessageResponse with the stored message.

        Raises:
            NotFoundError: If the conversation does not exist.
            ValidationError: If the input is invalid.
        """
        body = self._post(
            f"/api/v1/conversations/{request.conversation_id}/messages",
            request.to_dict(),
        )
        return AppendMessageResponse.from_dict(body)

    def recall(self, request: RecallRequest) -> RecallResponse:
        """
        Recall memories relevant to a query using dual-path retrieval.

        Executes vector similarity search and graph traversal in parallel,
        then merges and ranks the results.

        Args:
            request: The recall query with optional configuration.

        Returns:
            RecallResponse with ranked memory items and diagnostics.

        Raises:
            ValidationError: If the query is empty.
            ConnectionError: If the server is unreachable.
            ServerError: If the server encounters an internal error.
        """
        body = self._post("/api/v1/recall", request.to_dict())
        return RecallResponse.from_dict(body)

    def get_conversation(self, conversation_id: str) -> Conversation:
        """
        Retrieve a conversation by ID.

        Args:
            conversation_id: The UUID of the conversation.

        Returns:
            The full conversation with all messages.

        Raises:
            NotFoundError: If the conversation does not exist.
        """
        body = self._get(f"/api/v1/conversations/{conversation_id}")
        return Conversation.from_dict(body["conversation"])

    def list_conversations(
        self,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        source: Optional[str] = None,
    ) -> List[Conversation]:
        """
        List conversations with optional filtering.

        Args:
            limit: Maximum number of conversations to return.
            offset: Number of conversations to skip.
            source: Filter by source application.

        Returns:
            List of conversations.
        """
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        if offset is not None:
            params["offset"] = str(offset)
        if source is not None:
            params["source"] = source

        body = self._get("/api/v1/conversations", params=params)
        return [Conversation.from_dict(c) for c in body.get("conversations", [])]

    def health(self) -> Dict[str, Any]:
        """
        Check server health status.

        Returns:
            Health check response dict.
        """
        return self._get("/api/v1/health")

    # ─── Internal HTTP Methods ───────────────────────────────

    def _build_headers(self) -> Dict[str, str]:
        """Build request headers with auth and content type."""
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "nero-mem-python/0.1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self._default_headers)
        return headers

    def _get(
        self, path: str, params: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """Execute a GET request."""
        url = self.base_url + path
        if params:
            query = "&".join(f"{k}={v}" for k, v in params.items())
            url = f"{url}?{query}"

        req = urllib.request.Request(url, headers=self._build_headers(), method="GET")
        return self._execute(req)

    def _post(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a POST request with JSON body."""
        url = self.base_url + path
        encoded = json.dumps(data).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=encoded,
            headers=self._build_headers(),
            method="POST",
        )
        return self._execute(req)

    def _execute(self, req: urllib.request.Request) -> Dict[str, Any]:
        """
        Execute an HTTP request and handle errors.

        Maps HTTP error codes to SDK exceptions via raise_for_status().
        Handles connection failures and timeouts gracefully.
        """
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body_bytes = resp.read()
                if not body_bytes:
                    return {}
                return json.loads(body_bytes)
        except urllib.error.HTTPError as e:
            # Parse error response body if available
            try:
                error_body = json.loads(e.read().decode("utf-8"))
            except (json.JSONDecodeError, AttributeError):
                error_body = {"error": str(e)}
            raise_for_status(e.code, error_body)
            # raise_for_status always raises, but mypy needs this
            raise  # pragma: no cover
        except urllib.error.URLError as e:
            if "timed out" in str(e.reason):
                raise TimeoutError(
                    f"Request timed out after {self.timeout}s: {e.reason}"
                ) from e
            raise ConnectionError(
                f"Failed to connect to {self.base_url}: {e.reason}"
            ) from e
        except TimeoutError:
            raise  # re-raise our own TimeoutError
        except ConnectionError:
            raise  # re-raise our own ConnectionError
        except json.JSONDecodeError as e:
            raise NeroMemError(f"Invalid JSON response: {e}") from e
        except Exception as e:
            raise NeroMemError(f"Unexpected error: {e}") from e
