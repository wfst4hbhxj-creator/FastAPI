import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "DNSE Intermediary API"
    
    # Provider Secrets - Never hardcoded
    dnse_api_key: str = os.getenv("DNSE_API_KEY", "")
    dnse_api_secret: str = os.getenv("DNSE_API_SECRET", "")
    dnse_base_url: str = os.getenv("DNSE_BASE_URL", "https://services.entrade.com.vn/dnse-market/v1")
    
    ssi_consumer_id: str = os.getenv("SSI_CONSUMER_ID", "")
    ssi_consumer_secret: str = os.getenv("SSI_CONSUMER_SECRET", "")
    
    vietstock_api_key: str = os.getenv("VIETSTOCK_API_KEY", "")

    class Config:
        env_file = ".env"

settings = Settings()
