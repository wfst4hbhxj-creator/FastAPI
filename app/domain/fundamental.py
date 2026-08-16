from pydantic import BaseModel, Field
from typing import Optional
from app.domain.provenance import ProvenanceField

class FundamentalData(BaseModel):
    eps: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    pe: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    pb: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    roe: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    roa: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    revenue: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    net_profit: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    equity: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    debt: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    dividend: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
    major_shareholders: ProvenanceField = Field(default_factory=ProvenanceField.unavailable)
