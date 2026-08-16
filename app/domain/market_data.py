from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from app.domain.provenance import ProvenanceField

class MarketData(BaseModel):
    close: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    open: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    high: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    low: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    volume: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)

class MarketIndices(BaseModel):
    indices: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    
class NewsItem(BaseModel):
    title: str
    url: str
    publish_date: Optional[str] = None

class NewsData(BaseModel):
    articles: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
