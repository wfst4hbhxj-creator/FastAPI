from typing import Protocol, Optional
from app.domain.fundamental import FundamentalData
from app.domain.market_data import MarketData, MarketIndices, NewsData

class MarketDataProvider(Protocol):
    async def get_market_data(self, symbol: str) -> MarketData:
        ...
        
    async def get_market_indices(self) -> MarketIndices:
        ...
        
    async def get_news(self, symbol: str) -> NewsData:
        ...

class FundamentalDataProvider(Protocol):
    async def get_fundamental_data(self, symbol: str) -> FundamentalData:
        ...
