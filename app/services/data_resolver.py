from app.providers.dnse_provider import DNSEProvider
from app.providers.cafef_unofficial import CafeFUnofficialProvider
from app.domain.market_data import MarketData, MarketIndices, NewsData
from app.domain.fundamental import FundamentalData
from app.services.data_validator import DataValidator
from app.domain.provenance import DataStatus, ProvenanceField

class DataResolver:
    def __init__(self):
        self.dnse = DNSEProvider()
        self.cafef = CafeFUnofficialProvider()
        self.validator = DataValidator()

    async def get_market_data(self, symbol: str) -> MarketData:
        # Priority 1: DNSE
        data = await self.dnse.get_market_data(symbol)
        data.close = self.validator.validate_number(data.close, min_val=0)
        # Note: If DNSE fails, we could fallback to SSI here if implemented.
        # But we only have DNSE for now.
        return data

    async def get_market_indices(self) -> MarketIndices:
        data = await self.dnse.get_market_indices()
        return data

    async def get_news(self, symbol: str) -> NewsData:
        data = await self.dnse.get_news(symbol)
        return data

    async def get_fundamental_data(self, symbol: str) -> FundamentalData:
        # Priority 1: CafeF (Unofficial)
        data = await self.cafef.get_fundamental_data(symbol)
        
        # Validate critical fields
        data.eps = self.validator.validate_number(data.eps)
        data.pe = self.validator.validate_number(data.pe, min_val=0) # PE should generally be positive but can be negative, so we omit min_val or keep relaxed
        data.pb = self.validator.validate_number(data.pb, min_val=0)
        
        # Fields not supported by CafeF endpoint
        data.roe = ProvenanceField.unavailable("no_verified_source_yet")
        data.roa = ProvenanceField.unavailable("no_verified_source_yet")
        data.revenue = ProvenanceField.unavailable("no_verified_source_yet")
        data.net_profit = ProvenanceField.unavailable("no_verified_source_yet")
        data.equity = ProvenanceField.unavailable("no_verified_source_yet")
        data.debt = ProvenanceField.unavailable("no_verified_source_yet")
        data.dividend = ProvenanceField.unavailable("no_verified_source_yet")
        data.major_shareholders = ProvenanceField.unavailable("no_verified_source_yet")
        
        return data

    async def close(self):
        await self.dnse.close()
        await self.cafef.close()
