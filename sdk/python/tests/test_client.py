"""Tests for the synchronous MemoryClient — uses mocked HTTP responses."""

import json
import urllib.error
import urllib.request
from http.client import HTTPResponse
from io import BytesIO
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import pytest

from nero_mem.client import MemoryClient
from nero_mem.exceptions import (
    AuthenticationError,
    ConnectionError,
    NotFoundError,
    ServerError,
    TimeoutError,
    ValidationError,
)
from nero_mem.models import (
    AppendMessageRequest,
    IngestMessageInput,
    IngestRequest,
    RecallRequest,
)


# ─── Helpers ─────────────────────────────────────────────────


def make_response(body: Dict[str, Any], status: int = 200) -> MagicMock:
    """Create a mock HTTP response with the given JSON body and status."""
    mock = MagicMock()
    encoded = json.dumps(body).encode("utf-8")
    mock.read.return_value = encoded
    mock.status = status
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


def make_http_error(body: Dict[str, Any], status: int) -> urllib.error.HTTPError:
    """Create a urllib HTTPError with a JSON body."""
    encoded = json.dumps(body).encode("utf-8")
    error = urllib.error.HTTPError(
        url="http://localhost:3000/api/v1/test",
        code=status,
        msg=f"HTTP {status}",
        hdrs=None,  # type: ignore
        fp=BytesIO(encoded),
    )
    return error


# ─── Client Construction ────────────────────────────────────


class TestClientConstruction:
    def test_default_base_url(self):
        client = MemoryClient()
        assert client.base_url == "http://localhost:3000"

    def test_custom_base_url_strips_trailing_slash(self):
        client = MemoryClient("http://example.com:8080/")
        assert client.base_url == "http://example.com:8080"

    def test_api_key(self):
        client = MemoryClient(api_key="test-key")
        headers = client._build_headers()
        assert headers["Authorization"] == "Bearer test-key"

    def test_no_auth_header_without_key(self):
        client = MemoryClient()
        headers = client._build_headers()
        assert "Authorization" not in headers

    def test_custom_headers(self):
        client = MemoryClient(default_headers={"X-Custom": "value"})
        headers = client._build_headers()
        assert headers["X-Custom"] == "value"

    def test_user_agent(self):
        client = MemoryClient()
        headers = client._build_headers()
        assert "nero-mem-python" in headers["User-Agent"]


# ─── Ingest ─────────────────────────────────────────────────


class TestIngest:
    @patch("urllib.request.urlopen")
    def test_ingest_success(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "conversation": {
                    "id": "conv-123",
                    "source": "test",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "messages": [
                        {
                            "id": "msg-1",
                            "conversationId": "conv-123",
                            "role": "user",
                            "content": "Hello",
                            "turnIndex": 0,
                            "createdAt": "2026-01-01T00:00:00Z",
                        }
                    ],
                }
            }
        )

        client = MemoryClient("http://localhost:3000")
        result = client.ingest(
            IngestRequest(
                source="test",
                messages=[IngestMessageInput(role="user", content="Hello")],
            )
        )

        assert result.conversation.id == "conv-123"
        assert len(result.conversation.messages) == 1
        assert result.conversation.messages[0].content == "Hello"

        # Verify the request was made correctly
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        assert req.full_url == "http://localhost:3000/api/v1/conversations"
        assert req.method == "POST"

    @patch("urllib.request.urlopen")
    def test_ingest_validation_error(self, mock_urlopen):
        mock_urlopen.side_effect = make_http_error(
            {"error": "At least one message is required"}, 400
        )

        client = MemoryClient()
        with pytest.raises(ValidationError) as exc_info:
            client.ingest(IngestRequest(source="test", messages=[]))

        assert exc_info.value.status_code == 400
        assert "message" in str(exc_info.value).lower()


# ─── Recall ──────────────────────────────────────────────────


class TestRecall:
    @patch("urllib.request.urlopen")
    def test_recall_success(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "items": [
                    {
                        "nodeId": "fact-1",
                        "nodeType": "fact",
                        "score": 0.85,
                        "content": "Python is a programming language",
                        "sources": ["vector"],
                        "sourceScores": {"vector": 0.85},
                    }
                ],
                "diagnostics": {
                    "activatedAnchors": [],
                    "extractedEntities": ["Python"],
                    "graphSeedCount": 0,
                    "vectorTimeMs": 10,
                    "graphTimeMs": 5,
                    "totalTimeMs": 12,
                    "vectorItemCount": 1,
                    "graphItemCount": 0,
                    "mergeStats": {
                        "vectorInputCount": 1,
                        "graphInputCount": 0,
                        "overlapCount": 0,
                        "uniqueCount": 1,
                        "filteredCount": 1,
                        "outputCount": 1,
                        "mergeTimeMs": 0.1,
                    },
                    "edgesReinforced": 0,
                    "vectorTimedOut": False,
                    "graphTimedOut": False,
                },
            }
        )

        client = MemoryClient()
        result = client.recall(RecallRequest(query_text="What is Python?"))

        assert len(result.items) == 1
        assert result.items[0].node_id == "fact-1"
        assert result.items[0].score == 0.85
        assert result.diagnostics.total_time_ms == 12

    @patch("urllib.request.urlopen")
    def test_recall_with_config(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {"items": [], "diagnostics": {}}
        )

        client = MemoryClient()
        client.recall(
            RecallRequest(
                query_text="test",
                max_results=5,
                min_score=0.2,
                vector_weight=0.8,
            )
        )

        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        body = json.loads(req.data)
        assert body["queryText"] == "test"
        assert body["config"]["maxResults"] == 5
        assert body["config"]["minScore"] == 0.2
        assert body["config"]["vectorWeight"] == 0.8


# ─── Append Message ──────────────────────────────────────────


class TestAppendMessage:
    @patch("urllib.request.urlopen")
    def test_append_success(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "message": {
                    "id": "msg-2",
                    "conversationId": "conv-1",
                    "role": "assistant",
                    "content": "Hi there!",
                    "turnIndex": 1,
                    "createdAt": "2026-01-01T00:00:01Z",
                }
            }
        )

        client = MemoryClient()
        result = client.append_message(
            AppendMessageRequest(
                conversation_id="conv-1", role="assistant", content="Hi there!"
            )
        )

        assert result.message.id == "msg-2"
        assert result.message.turn_index == 1


# ─── Get / List Conversations ───────────────────────────────


class TestConversationCRUD:
    @patch("urllib.request.urlopen")
    def test_get_conversation(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "conversation": {
                    "id": "conv-1",
                    "source": "test",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "messages": [],
                }
            }
        )

        client = MemoryClient()
        conv = client.get_conversation("conv-1")
        assert conv.id == "conv-1"

    @patch("urllib.request.urlopen")
    def test_get_conversation_not_found(self, mock_urlopen):
        mock_urlopen.side_effect = make_http_error(
            {"error": "Conversation not found"}, 404
        )

        client = MemoryClient()
        with pytest.raises(NotFoundError):
            client.get_conversation("nonexistent")

    @patch("urllib.request.urlopen")
    def test_list_conversations(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {
                "conversations": [
                    {
                        "id": "conv-1",
                        "source": "test",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                        "messages": [],
                    }
                ]
            }
        )

        client = MemoryClient()
        convs = client.list_conversations(limit=10, source="test")

        assert len(convs) == 1
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        assert "limit=10" in req.full_url
        assert "source=test" in req.full_url


# ─── Error Handling ──────────────────────────────────────────


class TestErrorHandling:
    @patch("urllib.request.urlopen")
    def test_server_error(self, mock_urlopen):
        mock_urlopen.side_effect = make_http_error(
            {"error": "Internal server error"}, 500
        )

        client = MemoryClient()
        with pytest.raises(ServerError) as exc_info:
            client.recall(RecallRequest(query_text="test"))
        assert exc_info.value.status_code == 500

    @patch("urllib.request.urlopen")
    def test_auth_error(self, mock_urlopen):
        mock_urlopen.side_effect = make_http_error(
            {"error": "Unauthorized"}, 401
        )

        client = MemoryClient()
        with pytest.raises(AuthenticationError):
            client.recall(RecallRequest(query_text="test"))

    @patch("urllib.request.urlopen")
    def test_connection_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        client = MemoryClient()
        with pytest.raises(ConnectionError):
            client.recall(RecallRequest(query_text="test"))

    @patch("urllib.request.urlopen")
    def test_timeout_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("timed out")

        client = MemoryClient(timeout=1)
        with pytest.raises(TimeoutError):
            client.recall(RecallRequest(query_text="test"))

    @patch("urllib.request.urlopen")
    def test_health_check(self, mock_urlopen):
        mock_urlopen.return_value = make_response(
            {"status": "ok", "version": "0.1.0"}
        )

        client = MemoryClient()
        health = client.health()
        assert health["status"] == "ok"
