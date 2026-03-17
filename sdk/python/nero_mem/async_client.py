"""
Asynchronous AsyncMemoryClient for the nero-mem2 REST API.

Uses aiohttp for non-blocking HTTP. Falls back to a threadpool executor
wrapping the sync client if aiohttp is not installed.

Usage:
    import asyncio
    from nero_mem import AsyncMemoryClient, IngestRequest, IngestMessageInput, RecallRequest

    async def main():
        async with AsyncMemoryClient("http://localhost:3000") as client:
            response = await client.ingest(IngestRequest(
                source="claude-code",
                messages=[
                    IngestMessageInput(role="user", content="What is Python?"),
                    IngestMessageInput(role="assistant", content="Python is a language."),
                ],
            ))

            result = await client.recall(RecallRequest(query_text="Tell me about Python"))
            for item in result.items:
                print(f"[{item.node_type}] {item.content} (score={item.score:.3f})")

    asyncio.run(main())
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional

from nero_mem.exceptions import (
    AuthenticationError,
    ConnectionError,
    NeroMemError,
    NotFoundError,
    ServerError,
    TimeoutError,
    ValidationError,
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


class AsyncMemoryClient:
    """
    Async client for the nero-mem2 memory REST API.

    Attempts to use aiohttp if available. Falls back to running the
    synchronous MemoryClient in a thread pool executor.

    Args:
        base_url: The base URL of the nero-mem2 server.
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
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._default_headers = default_headers or {}
        self._session: Any = None  # aiohttp.ClientSession or None
        self._use_aiohttp = False
        self._sync_fallback: Any = None  # MemoryClient instance for fallback

        try:
            import aiohttp  # noqa: F401

            self._use_aiohttp = True
        except ImportError:
            pass

    async def __aenter__(self) -> "AsyncMemoryClient":
        if self._use_aiohttp:
            import aiohttp

            timeout_obj = aiohttp.ClientTimeout(total=self.timeout)
            headers = self._build_headers()
            self._session = aiohttp.ClientSession(
                base_url=self.base_url,
                headers=headers,
                timeout=timeout_obj,
            )
        else:
            from nero_mem.client import MemoryClient

            self._sync_fallback = MemoryClient(
                base_url=self.base_url,
                api_key=self.api_key,
                timeout=self.timeout,
                default_headers=self._default_headers,
            )
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None
        self._sync_fallback = None

    # ─── Public API ──────────────────────────────────────────

    async def ingest(self, request: IngestRequest) -> IngestResponse:
        """
        Ingest a complete conversation (async).

        See MemoryClient.ingest() for full documentation.
        """
        body = await self._post("/api/v1/conversations", request.to_dict())
        return IngestResponse.from_dict(body)

    async def append_message(
        self, request: AppendMessageRequest
    ) -> AppendMessageResponse:
        """
        Append a single message to an existing conversation (async).

        See MemoryClient.append_message() for full documentation.
        """
        body = await self._post(
            f"/api/v1/conversations/{request.conversation_id}/messages",
            request.to_dict(),
        )
        return AppendMessageResponse.from_dict(body)

    async def recall(self, request: RecallRequest) -> RecallResponse:
        """
        Recall memories relevant to a query (async).

        See MemoryClient.recall() for full documentation.
        """
        body = await self._post("/api/v1/recall", request.to_dict())
        return RecallResponse.from_dict(body)

    async def get_conversation(self, conversation_id: str) -> Conversation:
        """Retrieve a conversation by ID (async)."""
        body = await self._get(f"/api/v1/conversations/{conversation_id}")
        return Conversation.from_dict(body["conversation"])

    async def list_conversations(
        self,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        source: Optional[str] = None,
    ) -> List[Conversation]:
        """List conversations with optional filtering (async)."""
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        if offset is not None:
            params["offset"] = str(offset)
        if source is not None:
            params["source"] = source

        body = await self._get("/api/v1/conversations", params=params)
        return [Conversation.from_dict(c) for c in body.get("conversations", [])]

    async def health(self) -> Dict[str, Any]:
        """Check server health status (async)."""
        return await self._get("/api/v1/health")

    # ─── Internal HTTP Methods ───────────────────────────────

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "nero-mem-python/0.1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self._default_headers)
        return headers

    async def _get(
        self, path: str, params: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        if self._use_aiohttp and self._session is not None:
            return await self._aiohttp_get(path, params)
        return await self._fallback_get(path, params)

    async def _post(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if self._use_aiohttp and self._session is not None:
            return await self._aiohttp_post(path, data)
        return await self._fallback_post(path, data)

    # ─── aiohttp Implementation ──────────────────────────────

    async def _aiohttp_get(
        self, path: str, params: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        import aiohttp

        try:
            async with self._session.get(path, params=params) as resp:
                body = await resp.json()
                if resp.status >= 400:
                    raise_for_status(resp.status, body or {})
                return body
        except (
            ValidationError,
            AuthenticationError,
            NotFoundError,
            ServerError,
            TimeoutError,
        ):
            raise
        except aiohttp.ClientError as e:
            if "timeout" in str(e).lower():
                raise TimeoutError(f"Request timed out: {e}") from e
            raise ConnectionError(f"Connection failed: {e}") from e
        except Exception as e:
            if isinstance(e, NeroMemError):
                raise
            raise NeroMemError(f"Unexpected error: {e}") from e

    async def _aiohttp_post(
        self, path: str, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        import aiohttp

        try:
            async with self._session.post(path, json=data) as resp:
                body = await resp.json()
                if resp.status >= 400:
                    raise_for_status(resp.status, body or {})
                return body
        except (
            ValidationError,
            AuthenticationError,
            NotFoundError,
            ServerError,
            TimeoutError,
        ):
            raise
        except aiohttp.ClientError as e:
            if "timeout" in str(e).lower():
                raise TimeoutError(f"Request timed out: {e}") from e
            raise ConnectionError(f"Connection failed: {e}") from e
        except Exception as e:
            if isinstance(e, NeroMemError):
                raise
            raise NeroMemError(f"Unexpected error: {e}") from e

    # ─── Sync Fallback (threadpool) ──────────────────────────

    async def _fallback_get(
        self, path: str, params: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        if self._sync_fallback is None:
            from nero_mem.client import MemoryClient

            self._sync_fallback = MemoryClient(
                base_url=self.base_url,
                api_key=self.api_key,
                timeout=self.timeout,
                default_headers=self._default_headers,
            )
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._sync_fallback._get, path, params
        )

    async def _fallback_post(
        self, path: str, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        if self._sync_fallback is None:
            from nero_mem.client import MemoryClient

            self._sync_fallback = MemoryClient(
                base_url=self.base_url,
                api_key=self.api_key,
                timeout=self.timeout,
                default_headers=self._default_headers,
            )
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._sync_fallback._post, path, data
        )
