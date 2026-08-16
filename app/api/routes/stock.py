from fastapi import APIRouter, HTTPException, Depends
from app.services.data_resolver import DataResolver
from app.services.scoring import ScoringService
import asyncio

router = APIRouter()
resolver = DataResolver()

@router.get("/stock/{symbol}")
async def get_stock(symbol: str):
    data = await resolver.get_market_data(symbol)
    return {"close": data.close.value}

@router.get("/hold/{symbol}")
async def get_hold(symbol: str):
    price_data = await resolver.get_market_data(symbol)
    fund_data = await resolver.get_fundamental_data(symbol)
    score_result = ScoringService.calculate_quality_score(fund_data)
    
    return {
        "price": {"close": price_data.close.value},
        "quality": score_result.score.value,
        "funds": fund_data.major_shareholders.value,
        "note": "using unofficial cafef endpoint for fundamentals"
    }

@router.get("/news/{symbol}")
async def get_news(symbol: str):
    data = await resolver.get_news(symbol)
    return data.articles.value if data.articles.value is not None else []

@router.get("/financial-summary/{symbol}")
async def get_financial_summary(symbol: str):
    fund_data = await resolver.get_fundamental_data(symbol)
    
    return {
        "latest": {
            "eps": fund_data.eps.model_dump(),
            "pe": fund_data.pe.model_dump(),
            "pb": fund_data.pb.model_dump(),
            "roe": fund_data.roe.model_dump(),
            "roa": fund_data.roa.model_dump(),
            "revenue": fund_data.revenue.model_dump(),
            "net_profit": fund_data.net_profit.model_dump(),
            "equity": fund_data.equity.model_dump(),
            "debt": fund_data.debt.model_dump()
        },
        "note": "using partial data from unofficical provider"
    }

@router.get("/score/{symbol}")
async def get_score(symbol: str):
    fund_data = await resolver.get_fundamental_data(symbol)
    score_result = ScoringService.calculate_quality_score(fund_data)
    
    return {
        "score": score_result.score.model_dump(),
        "rating": score_result.rating.model_dump(),
        "completeness": score_result.data_completeness
    }

@router.get("/market")
async def get_market():
    market_data = await resolver.get_market_indices()
    if market_data.indices.value is None:
        raise Exception("Không thể lấy dữ liệu thị trường từ nguồn động.")
    return market_data.indices.value

@router.get("/fund-favorites")
async def get_fund_favorites():
    return {"note": "chưa có nguồn dữ liệu động"}

@router.get("/growth-stocks")
async def get_growth_stocks():
    return {"stocks": [], "note": "chưa có nguồn dữ liệu động"}

@router.get("/dividend-kings")
async def get_dividend_kings():
    return {"stocks": [], "note": "chưa có nguồn dữ liệu động"}

@router.get("/analyze/{symbol}")
async def analyze_symbol(symbol: str):
    price_task = resolver.get_market_data(symbol)
    fund_task = resolver.get_fundamental_data(symbol)
    news_task = resolver.get_news(symbol)
    
    price_data, fund_data, news_data = await asyncio.gather(
        price_task, fund_task, news_task, return_exceptions=True
    )
    
    if isinstance(fund_data, Exception):
        score_val = None
        quality_val = None
        dividend_val = None
        funds_val = None
    else:
        score_result = ScoringService.calculate_quality_score(fund_data)
        score_val = score_result.rating.value
        quality_val = score_result.score.value
        dividend_val = fund_data.dividend.value
        funds_val = fund_data.major_shareholders.value

    return {
        "price": {"close": price_data.close.value} if not isinstance(price_data, Exception) else None,
        "company": symbol.upper(),
        "score": score_val,
        "quality": quality_val,
        "dividend": dividend_val,
        "funds": funds_val,
        "news": news_data.articles.value if not isinstance(news_data, Exception) else None,
        "note": "using unofficial provider for fundamentals"
    }

async def close_resolver():
    await resolver.close()
