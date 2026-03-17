"""Tests for nero_mem data models — serialization and deserialization."""

import pytest

from nero_mem.models import (
    AppendMessageRequest,
    AppendMessageResponse,
    Conversation,
    IngestMessageInput,
    IngestRequest,
    IngestResponse,
    MergeStats,
    Message,
    RecallDiagnostics,
    RecallItem,
    RecallRequest,
    RecallResponse,
)


# ─── IngestMessageInput ─────────────────────────────────────


class TestIngestMessageInput:
    def test_to_dict_minimal(self):
        msg = IngestMessageInput(role="user", content="Hello")
        assert msg.to_dict() == {"role": "user", "content": "Hello"}

    def test_to_dict_with_metadata(self):
        msg = IngestMessageInput(
            role="assistant", content="Hi", metadata={"model": "claude-3"}
        )
        d = msg.to_dict()
        assert d["metadata"] == {"model": "claude-3"}


# ─── IngestRequest ───────────────────────────────────────────


class TestIngestRequest:
    def test_to_dict_minimal(self):
        req = IngestRequest(
            source="test",
            messages=[IngestMessageInput(role="user", content="Hello")],
        )
        d = req.to_dict()
        assert d["source"] == "test"
        assert len(d["messages"]) == 1
        assert "title" not in d
        assert "id" not in d

    def test_to_dict_full(self):
        req = IngestRequest(
            source="claude-code",
            messages=[
                IngestMessageInput(role="user", content="Q"),
                IngestMessageInput(role="assistant", content="A"),
            ],
            title="Test Conversation",
            id="custom-id",
            metadata={"key": "value"},
        )
        d = req.to_dict()
        assert d["title"] == "Test Conversation"
        assert d["id"] == "custom-id"
        assert d["metadata"] == {"key": "value"}
        assert len(d["messages"]) == 2


# ─── Message / Conversation ─────────────────────────────────


class TestMessage:
    def test_from_dict(self):
        data = {
            "id": "msg-1",
            "conversationId": "conv-1",
            "role": "user",
            "content": "Hello",
            "turnIndex": 0,
            "createdAt": "2026-01-01T00:00:00Z",
        }
        msg = Message.from_dict(data)
        assert msg.id == "msg-1"
        assert msg.conversation_id == "conv-1"
        assert msg.role == "user"
        assert msg.turn_index == 0
        assert msg.metadata is None

    def test_from_dict_with_metadata(self):
        data = {
            "id": "msg-2",
            "conversationId": "conv-1",
            "role": "assistant",
            "content": "World",
            "turnIndex": 1,
            "createdAt": "2026-01-01T00:00:01Z",
            "metadata": {"tokens": 5},
        }
        msg = Message.from_dict(data)
        assert msg.metadata == {"tokens": 5}


class TestConversation:
    def test_from_dict(self):
        data = {
            "id": "conv-1",
            "source": "test",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:01Z",
            "messages": [
                {
                    "id": "msg-1",
                    "conversationId": "conv-1",
                    "role": "user",
                    "content": "Hello",
                    "turnIndex": 0,
                    "createdAt": "2026-01-01T00:00:00Z",
                }
            ],
            "title": "Test",
        }
        conv = Conversation.from_dict(data)
        assert conv.id == "conv-1"
        assert conv.title == "Test"
        assert len(conv.messages) == 1
        assert conv.messages[0].content == "Hello"


class TestIngestResponse:
    def test_from_dict(self):
        data = {
            "conversation": {
                "id": "conv-1",
                "source": "test",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "messages": [],
            }
        }
        resp = IngestResponse.from_dict(data)
        assert resp.conversation.id == "conv-1"


# ─── AppendMessage ───────────────────────────────────────────


class TestAppendMessageRequest:
    def test_to_dict(self):
        req = AppendMessageRequest(
            conversation_id="conv-1", role="user", content="Follow up"
        )
        d = req.to_dict()
        assert d["conversationId"] == "conv-1"
        assert d["role"] == "user"
        assert "metadata" not in d

    def test_to_dict_with_metadata(self):
        req = AppendMessageRequest(
            conversation_id="conv-1",
            role="assistant",
            content="Reply",
            metadata={"model": "claude"},
        )
        d = req.to_dict()
        assert d["metadata"] == {"model": "claude"}


class TestAppendMessageResponse:
    def test_from_dict(self):
        data = {
            "message": {
                "id": "msg-3",
                "conversationId": "conv-1",
                "role": "user",
                "content": "Another turn",
                "turnIndex": 2,
                "createdAt": "2026-01-01T00:00:02Z",
            }
        }
        resp = AppendMessageResponse.from_dict(data)
        assert resp.message.id == "msg-3"
        assert resp.message.turn_index == 2


# ─── RecallRequest ───────────────────────────────────────────


class TestRecallRequest:
    def test_to_dict_minimal(self):
        req = RecallRequest(query_text="What is Python?")
        d = req.to_dict()
        assert d == {"queryText": "What is Python?"}
        assert "config" not in d

    def test_to_dict_with_config(self):
        req = RecallRequest(
            query_text="Python",
            max_results=10,
            min_score=0.1,
            vector_weight=0.7,
            convergence_bonus=0.2,
        )
        d = req.to_dict()
        assert d["queryText"] == "Python"
        assert d["config"]["maxResults"] == 10
        assert d["config"]["minScore"] == 0.1
        assert d["config"]["vectorWeight"] == 0.7
        assert d["config"]["convergenceBonus"] == 0.2


# ─── RecallResponse ──────────────────────────────────────────


class TestRecallItem:
    def test_from_dict(self):
        data = {
            "nodeId": "fact-1",
            "nodeType": "fact",
            "score": 0.85,
            "content": "Python is a programming language",
            "sources": ["vector", "graph"],
            "sourceScores": {"vector": 0.9, "graph": 0.7},
        }
        item = RecallItem.from_dict(data)
        assert item.node_id == "fact-1"
        assert item.node_type == "fact"
        assert item.score == 0.85
        assert "vector" in item.sources
        assert item.source_scores["vector"] == 0.9


class TestRecallResponse:
    def test_from_dict_full(self):
        data = {
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
                "activatedAnchors": [
                    {"anchorId": "a-1", "label": "python", "similarity": 0.9}
                ],
                "extractedEntities": ["Python"],
                "graphSeedCount": 3,
                "vectorTimeMs": 12.5,
                "graphTimeMs": 8.3,
                "totalTimeMs": 15.2,
                "vectorItemCount": 5,
                "graphItemCount": 3,
                "mergeStats": {
                    "vectorInputCount": 5,
                    "graphInputCount": 3,
                    "overlapCount": 1,
                    "uniqueCount": 7,
                    "filteredCount": 6,
                    "outputCount": 6,
                    "mergeTimeMs": 0.5,
                },
                "edgesReinforced": 2,
                "vectorTimedOut": False,
                "graphTimedOut": False,
            },
        }
        resp = RecallResponse.from_dict(data)
        assert len(resp.items) == 1
        assert resp.items[0].node_id == "fact-1"
        assert resp.diagnostics.total_time_ms == 15.2
        assert resp.diagnostics.merge_stats.overlap_count == 1
        assert resp.diagnostics.vector_timed_out is False

    def test_from_dict_empty(self):
        data = {"items": [], "diagnostics": {}}
        resp = RecallResponse.from_dict(data)
        assert len(resp.items) == 0
        assert resp.diagnostics.total_time_ms == 0
