import httpx
from typing import Dict, Any
from app.core.config import settings
from app.domain.provenance import DataStatus, ProvenanceField
from app.domain.market_data import MarketData, MarketIndices, NewsData
import datetime
from app.core.exceptions import DataNotFoundException

class DNSEProvider:
    def __init__(self):
        self.base_url = settings.dnse_base_url
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        self.source_name = "dnse_openapi"
        self.source_type = "official_api"
        # Shared client for connection pooling
        self.client = httpx.AsyncClient(base_url=self.base_url, headers=self.headers, timeout=10.0)

    async def get_market_data(self, symbol: str) -> MarketData:
        try:
            res = await self.client.get(f"/quotes/{symbol}")
            if res.status_code == 200:
                data = res.json()
                if "c" in data:
                    return MarketData(
                        close=ProvenanceField(
                            value=data["c"],
                            status=DataStatus.AVAILABLE,
                            source=self.source_name,
                            source_type=self.source_type
                        )
                    )
                raise DataNotFoundException("No close price found in response", self.source_name)
            
            return MarketData(
                close=ProvenanceField.error(source=self.source_name, reason=f"HTTP {res.status_code}")
            )
        except Exception as e:
            return MarketData(
                close=ProvenanceField.error(source=self.source_name, reason=str(e))
            )

    async def get_market_indices(self) -> MarketIndices:
        try:
            res = await self.client.get("/indices")
            if res.status_code == 200:
                return MarketIndices(
                    indices=ProvenanceField(
                        value=res.json(),
                        status=DataStatus.AVAILABLE,
                        source=self.source_name,
                        source_type=self.source_type
                    )
                )
            return MarketIndices(
                indices=ProvenanceField.error(source=self.source_name, reason=f"HTTP {res.status_code}")
            )
        except Exception as e:
            return MarketIndices(
                indices=ProvenanceField.error(source=self.source_name, reason=str(e))
            )

    async def get_news(self, symbol: str) -> NewsData:
        try:
            res = await self.client.get(f"/news?symbol={symbol}")
            if res.status_code == 200:
                return NewsData(
                    articles=ProvenanceField(
                        value=res.json(),
                        status=DataStatus.AVAILABLE,
                        source=self.source_name,
                        source_type=self.source_type
                    )
                )
            return NewsData(
                articles=ProvenanceField.error(source=self.source_name, reason=f"HTTP {res.status_code}")
            )
        except Exception as e:
            return NewsData(
                articles=ProvenanceField.error(source=self.source_name, reason=str(e))
            )

    async def close(self):
        await self.client.aclose()
