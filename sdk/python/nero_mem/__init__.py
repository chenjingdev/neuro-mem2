"""
nero-mem Python SDK — Client library for the nero-mem2 memory infrastructure.

Provides sync and async clients for ingesting conversations and recalling
contextual memories via the nero-mem2 REST API.
"""

from nero_mem.client import MemoryClient
from nero_mem.async_client import AsyncMemoryClient
from nero_mem.models import (
    IngestRequest,
    IngestMessageInput,
    IngestResponse,
    AppendMessageRequest,
    AppendMessageResponse,
    RecallRequest,
    RecallResponse,
    RecallItem,
    RecallDiagnostics,
    MergeStats,
    Conversation,
    Message,
)
from nero_mem.exceptions import (
    NeroMemError,
    ConnectionError,
    AuthenticationError,
    NotFoundError,
    ValidationError,
    ServerError,
    TimeoutError,
)

__version__ = "0.1.0"

__all__ = [
    # Clients
    "MemoryClient",
    "AsyncMemoryClient",
    # Models
    "IngestRequest",
    "IngestMessageInput",
    "IngestResponse",
    "AppendMessageRequest",
    "AppendMessageResponse",
    "RecallRequest",
    "RecallResponse",
    "RecallItem",
    "RecallDiagnostics",
    "MergeStats",
    "Conversation",
    "Message",
    # Exceptions
    "NeroMemError",
    "ConnectionError",
    "AuthenticationError",
    "NotFoundError",
    "ValidationError",
    "ServerError",
    "TimeoutError",
]
