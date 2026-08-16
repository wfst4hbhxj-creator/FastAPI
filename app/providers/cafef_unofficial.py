import httpx
from typing import Dict, Any
from app.domain.provenance import DataStatus, ProvenanceField
from app.domain.fundamental import FundamentalData
from app.core.exceptions import DataNotFoundException

class CafeFUnofficialProvider:
    def __init__(self):
        self.base_url = "https://cafef.vn/du-lieu/Ajax/PageNew/ChiSoTaiChinh.ashx"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        self.source_name = "cafef"
        self.source_type = "unofficial_web_endpoint"
        self.client = httpx.AsyncClient(headers=self.headers, timeout=10.0)

    async def get_fundamental_data(self, symbol: str) -> FundamentalData:
        try:
            res = await self.client.get(f"{self.base_url}?symbol={symbol.upper()}")
            
            fund = FundamentalData()
            if res.status_code == 200:
                data = res.json()
                if data.get("Data"):
                    for item in data["Data"]:
                        code = item.get("Code")
                        val_str = str(item.get("Value", "")).replace(",", "")
                        try:
                            val = float(val_str)
                        except ValueError:
                            continue
                            
                        if code == "EPScoBan":
                            fund.eps = ProvenanceField(
                                value=val * 1000, # Vnd instead of nghìn đồng
                                status=DataStatus.AVAILABLE,
                                source=self.source_name,
                                source_type=self.source_type
                            )
                        elif code == "P/E":
                            fund.pe = ProvenanceField(
                                value=val,
                                status=DataStatus.AVAILABLE,
                                source=self.source_name,
                                source_type=self.source_type
                            )
                        elif code == "Beta": # CafeF uses Beta code for P/B in this specific JSON
                            fund.pb = ProvenanceField(
                                value=val,
                                status=DataStatus.AVAILABLE,
                                source=self.source_name,
                                source_type=self.source_type
                            )
                            
                    return fund
                else:
                    msg = data.get("Message", "Empty data")
                    fund.eps = ProvenanceField.error(source=self.source_name, reason=msg)
                    fund.pe = ProvenanceField.error(source=self.source_name, reason=msg)
                    fund.pb = ProvenanceField.error(source=self.source_name, reason=msg)
                    return fund
            
            # Non-200
            err_reason = f"HTTP {res.status_code}"
            fund.eps = ProvenanceField.error(source=self.source_name, reason=err_reason)
            fund.pe = ProvenanceField.error(source=self.source_name, reason=err_reason)
            fund.pb = ProvenanceField.error(source=self.source_name, reason=err_reason)
            return fund
        except Exception as e:
            err_reason = str(e)
            fund = FundamentalData()
            fund.eps = ProvenanceField.error(source=self.source_name, reason=err_reason)
            fund.pe = ProvenanceField.error(source=self.source_name, reason=err_reason)
            fund.pb = ProvenanceField.error(source=self.source_name, reason=err_reason)
            return fund

    async def close(self):
        await self.client.aclose()
