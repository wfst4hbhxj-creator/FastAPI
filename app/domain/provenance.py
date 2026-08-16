from enum import Enum
from pydantic import BaseModel, Field
from typing import Any, Optional
from datetime import datetime, timezone

class DataStatus(str, Enum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    ERROR = "error"
    INVALID = "invalid"

class ProvenanceField(BaseModel):
    value: Any = None
    status: DataStatus
    source: Optional[str] = None
    source_type: Optional[str] = None # "official_api", "unofficial_web_endpoint", "calculation", etc.
    reason: Optional[str] = None
    retrieved_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    calculated: bool = False
    calculation_method: Optional[str] = None
    
    @classmethod
    def unavailable(cls, reason: str = "no_verified_source") -> "ProvenanceField":
        return cls(
            value=None,
            status=DataStatus.UNAVAILABLE,
            reason=reason
        )
        
    @classmethod
    def error(cls, source: str, reason: str) -> "ProvenanceField":
        return cls(
            value=None,
            status=DataStatus.ERROR,
            source=source,
            reason=reason
        )
