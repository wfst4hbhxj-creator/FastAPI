import asyncio
import json
from app.services.data_resolver import DataResolver
from app.services.scoring import ScoringService

async def main():
    resolver = DataResolver()
    
    print("Testing get_market_data for FPT...")
    market_data = await resolver.get_market_data("FPT")
    print(market_data.model_dump_json(indent=2))
    
    print("\nTesting get_fundamental_data for FPT...")
    fund_data = await resolver.get_fundamental_data("FPT")
    print(fund_data.model_dump_json(indent=2))
    
    print("\nTesting scoring for FPT...")
    score_result = ScoringService.calculate_quality_score(fund_data)
    print(score_result.model_dump_json(indent=2))
    
    await resolver.close()

if __name__ == "__main__":
    asyncio.run(main())
