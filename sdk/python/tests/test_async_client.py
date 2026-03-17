"""Tests for the AsyncMemoryClient — uses mocked HTTP via sync fallback."""

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

from nero_mem.async_client import AsyncMemoryClient
from nero_mem.exceptions import ConnectionError, ValidationError
from nero_mem.models import (
    IngestMessageInput,
    IngestRequest,
    RecallRequest,
)


# ─── Helpers ─────────────────────────────────────────────────


def make_response(body, status=200):
    mock = MagicMock()
    encoded = json.dumps(body).encode("utf-8")
    mock.read.return_value = encoded
    mock.status = status
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


# ─── Tests ───────────────────────────────────────────────────


@pytest.mark.asyncio
class TestAsyncClientFallback:
    """Test AsyncMemoryClient with sync fallback (no aiohttp)."""

    @patch("urllib.request.urlopen")
    async def test_ingest_async(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "conversation": {
                    "id": "conv-async-1",
                    "source": "test",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "messages": [
                        {
                            "id": "msg-1",
                            "conversationId": "conv-async-1",
                            "role": "user",
                            "content": "Hello async",
                            "turnIndex": 0,
                            "createdAt": "2026-01-01T00:00:00Z",
                        }
                    ],
                }
            }
        )

        # Force sync fallback by patching _use_aiohttp
        client = AsyncMemoryClient("http://localhost:3000")
        client._use_aiohttp = False
        async with client as c:
            result = await c.ingest(
                IngestRequest(
                    source="test",
                    messages=[IngestMessageInput(role="user", content="Hello async")],
                )
            )

        assert result.conversation.id == "conv-async-1"

    @patch("urllib.request.urlopen")
    async def test_recall_async(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "items": [
                    {
                        "nodeId": "fact-async",
                        "nodeType": "fact",
                        "score": 0.9,
                        "content": "Async test fact",
                        "sources": ["vector"],
                        "sourceScores": {"vector": 0.9},
                    }
                ],
                "diagnostics": {
                    "activatedAnchors": [],
                    "extractedEntities": [],
                    "graphSeedCount": 0,
                    "vectorTimeMs": 5,
                    "graphTimeMs": 3,
                    "totalTimeMs": 8,
                    "vectorItemCount": 1,
                    "graphItemCount": 0,
                    "mergeStats": {},
                    "edgesReinforced": 0,
                    "vectorTimedOut": False,
                    "graphTimedOut": False,
                },
            }
        )

        client = AsyncMemoryClient("http://localhost:3000")
        client._use_aiohttp = False
        async with client as c:
            result = await c.recall(RecallRequest(query_text="async test"))

        assert len(result.items) == 1
        assert result.items[0].node_id == "fact-async"

    async def test_context_manager_cleanup(self):
        client = AsyncMemoryClient()
        client._use_aiohttp = False
        async with client as c:
            # Sync fallback is initialized lazily
            pass
        # After exit, fallback should be None
        assert client._sync_fallback is None
