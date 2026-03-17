"""
Data models for the nero-mem Python SDK.

These mirror the TypeScript interfaces in the nero-mem2 core:
- IngestConversationInput / RawConversation
- RecallQuery / RecallResult
- AppendMessageInput / RawMessage
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional


# ─── Shared Types ────────────────────────────────────────────

Role = Literal["user", "assistant", "system"]


# ─── Ingest Models ───────────────────────────────────────────


@dataclass
class IngestMessageInput:
    """A single message to ingest into a conversation."""

    role: Role
    content: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"role": self.role, "content": self.content}
        if self.metadata is not None:
            d["metadata"] = self.metadata
        return d


@dataclass
class IngestRequest:
    """Request payload for ingesting a full conversation."""

    source: str
    messages: List[IngestMessageInput]
    title: Optional[str] = None
    id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "source": self.source,
            "messages": [m.to_dict() for m in self.messages],
        }
        if self.title is not None:
            d["title"] = self.title
        if self.id is not None:
            d["id"] = self.id
        if self.metadata is not None:
            d["metadata"] = self.metadata
        return d


@dataclass
class Message:
    """An immutable message record returned from the server."""

    id: str
    conversation_id: str
    role: Role
    content: str
    turn_index: int
    created_at: str
    metadata: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Message":
        return cls(
            id=data["id"],
            conversation_id=data["conversationId"],
            role=data["role"],
            content=data["content"],
            turn_index=data["turnIndex"],
            created_at=data["createdAt"],
            metadata=data.get("metadata"),
        )


@dataclass
class Conversation:
    """An immutable conversation record returned from the server."""

    id: str
    source: str
    created_at: str
    updated_at: str
    messages: List[Message]
    title: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Conversation":
        return cls(
            id=data["id"],
            source=data["source"],
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
            messages=[Message.from_dict(m) for m in data.get("messages", [])],
            title=data.get("title"),
            metadata=data.get("metadata"),
        )


@dataclass
class IngestResponse:
    """Response from ingesting a conversation."""

    conversation: Conversation

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "IngestResponse":
        return cls(conversation=Conversation.from_dict(data["conversation"]))


# ─── Append Message Models ───────────────────────────────────


@dataclass
class AppendMessageRequest:
    """Request payload for appending a message to an existing conversation."""

    conversation_id: str
    role: Role
    content: str
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "conversationId": self.conversation_id,
            "role": self.role,
            "content": self.content,
        }
        if self.metadata is not None:
            d["metadata"] = self.metadata
        return d


@dataclass
class AppendMessageResponse:
    """Response from appending a message."""

    message: Message

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AppendMessageResponse":
        return cls(message=Message.from_dict(data["message"]))


# ─── Recall Models ───────────────────────────────────────────


@dataclass
class RecallRequest:
    """Request payload for recalling memories relevant to a query."""

    query_text: str
    max_results: Optional[int] = None
    min_score: Optional[float] = None
    vector_weight: Optional[float] = None
    convergence_bonus: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"queryText": self.query_text}
        config: Dict[str, Any] = {}
        if self.max_results is not None:
            config["maxResults"] = self.max_results
        if self.min_score is not None:
            config["minScore"] = self.min_score
        if self.vector_weight is not None:
            config["vectorWeight"] = self.vector_weight
        if self.convergence_bonus is not None:
            config["convergenceBonus"] = self.convergence_bonus
        if config:
            d["config"] = config
        return d


@dataclass
class RecallItem:
    """A single recalled memory item with its relevance score."""

    node_id: str
    node_type: str
    score: float
    content: str
    sources: List[str]
    source_scores: Dict[str, float]
    retrieval_metadata: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RecallItem":
        return cls(
            node_id=data["nodeId"],
            node_type=data["nodeType"],
            score=data["score"],
            content=data["content"],
            sources=data.get("sources", []),
            source_scores=data.get("sourceScores", {}),
            retrieval_metadata=data.get("retrievalMetadata"),
        )


@dataclass
class MergeStats:
    """Statistics about the merge operation."""

    vector_input_count: int
    graph_input_count: int
    overlap_count: int
    unique_count: int
    filtered_count: int
    output_count: int
    merge_time_ms: float

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MergeStats":
        return cls(
            vector_input_count=data.get("vectorInputCount", 0),
            graph_input_count=data.get("graphInputCount", 0),
            overlap_count=data.get("overlapCount", 0),
            unique_count=data.get("uniqueCount", 0),
            filtered_count=data.get("filteredCount", 0),
            output_count=data.get("outputCount", 0),
            merge_time_ms=data.get("mergeTimeMs", 0),
        )


@dataclass
class RecallDiagnostics:
    """Diagnostic information about the retrieval process."""

    activated_anchors: List[Dict[str, Any]]
    extracted_entities: List[str]
    graph_seed_count: int
    vector_time_ms: float
    graph_time_ms: float
    total_time_ms: float
    vector_item_count: int
    graph_item_count: int
    merge_stats: MergeStats
    edges_reinforced: int
    vector_timed_out: bool
    graph_timed_out: bool

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RecallDiagnostics":
        return cls(
            activated_anchors=data.get("activatedAnchors", []),
            extracted_entities=data.get("extractedEntities", []),
            graph_seed_count=data.get("graphSeedCount", 0),
            vector_time_ms=data.get("vectorTimeMs", 0),
            graph_time_ms=data.get("graphTimeMs", 0),
            total_time_ms=data.get("totalTimeMs", 0),
            vector_item_count=data.get("vectorItemCount", 0),
            graph_item_count=data.get("graphItemCount", 0),
            merge_stats=MergeStats.from_dict(data.get("mergeStats", {})),
            edges_reinforced=data.get("edgesReinforced", 0),
            vector_timed_out=data.get("vectorTimedOut", False),
            graph_timed_out=data.get("graphTimedOut", False),
        )


@dataclass
class RecallResponse:
    """Response from a recall query."""

    items: List[RecallItem]
    diagnostics: RecallDiagnostics

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RecallResponse":
        return cls(
            items=[RecallItem.from_dict(item) for item in data.get("items", [])],
            diagnostics=RecallDiagnostics.from_dict(data.get("diagnostics", {})),
        )
