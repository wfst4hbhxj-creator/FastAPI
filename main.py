from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
import logging
import os
import time
from datetime import date, timedelta, datetime

try:
    from importlib.metadata import version as _pkg_version
    VNSTOCK_VERSION = _pkg_version("vnstock")
except Exception:
    VNSTOCK_VERSION = "4.0.x"

from vnstock import Market, Reference, Fundamental

# =====================================
# 🔌 DNSE OpenAPI — nhóm dữ liệu có thể nâng cấp thêm sau (chưa cài đặt):
#   - Foreign flow (get_foreign_trading)
#   - Bid/ask depth (WebSocket quote())
#   - Time & sales / tick data (get_trades, WebSocket trade())
#   - Trạng thái phiên giao dịch (trading session)
#   - Giá dự khớp ATO/ATC (get_expected_price)
# Hiện tại CHỈ dùng get_latest_quote() cho /stock/{symbol}, xem _dnse_get_latest_quote() bên dưới.
# =====================================

app = FastAPI(title="VNStock API", version="4.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("vnstock-api")

class PortfolioRequest(BaseModel):
    stocks: List[str]

WATCHED_FUNDS = ["DCDS", "DCDE", "DCBF"]

_cache: dict = {}

def _cache_get(key):
    item = _cache.get(key)
    if item and time.time() < item["expires"]:
        return item["data"]
    return None

def _cache_set(key, data, ttl):
    _cache[key] = {"data": data, "expires": time.time() + ttl}

TTL_FUND    = 6 * 3600
TTL_COMPANY = 24 * 3600
TTL_FINANCE = 24 * 3600
TTL_NEWS    = 1 * 3600

def _safe_float(val):
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None

def _today():
    return date.today().strftime("%Y-%m-%d")

def _days_ago(n):
    return (date.today() - timedelta(days=n)).strftime("%Y-%m-%d")

def _err(detail, status=500):
    return JSONResponse(status_code=status, content={"success": False, "error": detail})

def _col(df, *names):
    for name in names:
        if name in df.columns:
            return name
        for col in df.columns:
            if str(col).lower() == name.lower():
                return col
    return None

def _serialize(obj):
    """Chuyển đổi DataFrame/list/dict an toàn cho JSON."""
    import pandas as pd
    if hasattr(obj, "to_dict"):
        records = obj.to_dict(orient="records")
    elif isinstance(obj, list):
        records = obj
    else:
        return obj
    clean = []
    for row in records:
        new_row = {}
        for k, v in row.items():
            if isinstance(v, (pd.Timestamp,)):
                new_row[k] = v.strftime("%Y-%m-%d")
            elif isinstance(v, float) and (v != v):  # NaN
                new_row[k] = None
            elif hasattr(v, "item"):  # numpy scalar
                new_row[k] = v.item()
            else:
                new_row[k] = v
        clean.append(new_row)
    return clean

# ===== DNSE OPENAPI CLIENT — lazy singleton, Market Data API only =====
_dnse_client = None
_dnse_init_failed = False

def _get_dnse_client():
    """Khởi tạo DNSEClient dạng lazy singleton. Không log secret. Trả None nếu thiếu cấu hình/lỗi."""
    global _dnse_client, _dnse_init_failed
    if _dnse_client is not None:
        return _dnse_client
    if _dnse_init_failed:
        return None
    api_key = os.getenv("DNSE_API_KEY")
    api_secret = os.getenv("DNSE_API_SECRET")
    if not api_key or not api_secret:
        _dnse_init_failed = True
        return None
    try:
        from dnse import DNSEClient
        _dnse_client = DNSEClient(
            api_key=api_key,
            api_secret=api_secret,
            base_url=os.getenv("DNSE_BASE_URL", "https://openapi.dnse.com.vn"),
            api_version=os.getenv("DNSE_API_VERSION") or None,
        )
        return _dnse_client
    except Exception as e:
        logger.warning(f"DNSE client init lỗi: {e}")
        _dnse_init_failed = True
        return None

TTL_DNSE_QUOTE = 20  # giây — cache riêng, ngắn, tách khỏi các TTL_* khác (giá realtime không nên cache lâu)

def _dnse_get_latest_quote(symbol):
    """
    Lấy báo giá mới nhất từ DNSE Market Data API (get_latest_quote).
    Trả về {"close": <nghìn đồng>, "volume": <int|None>} hoặc None nếu lỗi/không có client.
    LƯU Ý ĐƠN VỊ: DNSE trả giá theo VND thực (vd 60500), toàn hệ thống (vnstock, GAS bot)
    đang dùng đơn vị nghìn đồng (vd 60.5) — nên phải chia 1000 ở đây để KHÔNG phá vỡ quy ước cũ.
    """
    client = _get_dnse_client()
    if client is None:
        return None
    key = f"dnse_quote_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        # TODO: VERIFY WITH CURRENT DNSE SPEC — board_id chuẩn theo từng sàn (HOSE/HNX/UPCOM)
        # chưa được xác nhận rõ trong api.md (chỉ có ví dụ "G1" cho mã GAS). Dùng "G1" tạm thời;
        # nếu DNSE trả lỗi/rỗng, code sẽ tự fallback về vnstock bên dưới nên không ảnh hưởng độ tin cậy.
        status, body = client.get_latest_quote(symbol=symbol, board_id="G1", dry_run=False)
        if status == 200 and body:
            raw_close = (
                body.get("matchPrice") or body.get("closePrice")
                or body.get("close") or body.get("price")
            )
            raw_volume = body.get("matchQtty") or body.get("volume") or body.get("totalVolume")
            close_vnd = _safe_float(raw_close)
            if close_vnd is not None and close_vnd > 0:
                result = {
                    "close": round(close_vnd / 1000, 2),
                    "volume": int(raw_volume) if raw_volume is not None else None,
                }
                _cache_set(key, result, TTL_DNSE_QUOTE)
                return result
    except Exception as e:
        logger.warning(f"DNSE get_latest_quote {symbol}: {e}")
    return None

def _fetch_fund_holdings(fund_name):
    key = f"fund_holdings_{fund_name}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        data = Reference().fund(fund_name).top_holding()
    except Exception:
        data = Market().fund(fund_name).top_holding()
    result = _serialize(data)
    _cache_set(key, result, TTL_FUND)
    return result

# ===== META =====

@app.get("/")
async def home():
    return {"status": "ok", "service": "vnstock-api", "version": "4.2", "vnstock": VNSTOCK_VERSION}

@app.get("/health")
async def health():
    return {"status": "healthy"}

@app.get("/ping")
async def ping():
    return {"status": "ok"}

@app.get("/version")
async def api_version():
    return {"api_version": "4.2", "vnstock_version": VNSTOCK_VERSION}

@app.get("/info")
async def info():
    return {
        "service": "vnstock-api", "version": "4.2",
        "vnstock_version": VNSTOCK_VERSION,
        "watched_funds": WATCHED_FUNDS,
    }

# ===== GIÁ CỔ PHIẾU =====

@app.get("/stock/{symbol}")
def get_stock_price(symbol: str):
    symbol = symbol.upper()
    # Ưu tiên DNSE (nhanh, realtime hơn) — nếu lỗi/None thì fallback vnstock (logic cũ, không đổi)
    try:
        dnse_quote = _dnse_get_latest_quote(symbol)
        if dnse_quote and dnse_quote.get("close"):
            return {
                "symbol": symbol,
                "close": dnse_quote["close"],
                "volume": dnse_quote.get("volume") if dnse_quote.get("volume") is not None else 0,
                "source": "dnse",
            }
    except Exception as e:
        logger.warning(f"/stock/{symbol} DNSE lookup lỗi, fallback vnstock: {e}")
    try:
        quote = Market().equity(symbol).ohlcv(start=_days_ago(5), end=_today(), interval="1D")
        if quote is None or quote.empty:
            return _err(f"Không có dữ liệu giá cho {symbol}", 404)
        latest = quote.iloc[-1]
        close_col = _col(quote, "close", "Close") or quote.columns[-2]
        vol_col   = _col(quote, "volume", "Volume") or quote.columns[-1]
        return {"symbol": symbol, "close": float(latest[close_col]), "volume": int(latest[vol_col]), "source": "vnstock"}
    except Exception as e:
        logger.error(f"/stock/{symbol}: {e}")
        return _err(str(e))

# ===== THÔNG TIN CÔNG TY =====

@app.get("/company/{symbol}")
def get_company(symbol: str):
    symbol = symbol.upper()
    key = f"company_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        data = Reference().company(symbol).overview()
        if data is None or (hasattr(data, "empty") and data.empty):
            return _err(f"Không tìm thấy công ty {symbol}", 404)
        result = _serialize(data)
        _cache_set(key, result, TTL_COMPANY)
        return result
    except Exception as e:
        logger.error(f"/company/{symbol}: {e}")
        return _err(str(e))

# ===== CỔ TỨC =====

@app.get("/dividend/{symbol}")
def get_dividend(symbol: str):
    symbol = symbol.upper()
    key = f"dividend_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        try:
            events = Reference().company(symbol).events()
            if events is not None and not events.empty:
                div_mask = events.apply(
                    lambda r: any(kw in str(r).lower() for kw in ["cổ tức","dividend","chi tra","cash"]),
                    axis=1
                )
                divs = events[div_mask]
                if not divs.empty:
                    result = _serialize(divs)
                    _cache_set(key, result, TTL_COMPANY)
                    return result
        except Exception:
            pass
        try:
            ratio = Fundamental().equity(symbol).ratio()
            if ratio is not None and not ratio.empty:
                div_cols = [c for c in ratio.columns if "dividend" in str(c).lower() or "div" in str(c).lower()]
                if div_cols:
                    all_cols = ([c for c in ["period"] if c in ratio.columns]) + div_cols
                    result = _serialize(ratio[all_cols].head(8))
                    _cache_set(key, result, TTL_COMPANY)
                    return result
        except Exception:
            pass
        return _err(f"Không có dữ liệu cổ tức cho {symbol}", 404)
    except Exception as e:
        logger.error(f"/dividend/{symbol}: {e}")
        return _err(str(e))



# ===== CHỈ SỐ TÀI CHÍNH =====

@app.get("/financial-summary/{symbol}")
def get_financial_summary(symbol: str):
    symbol = symbol.upper()
    key = f"financial_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        ratios = Fundamental().equity(symbol).ratio()
        if ratios is None or ratios.empty:
            return _err(f"Không có dữ liệu tài chính cho {symbol}", 404)

        # ratio() trả pivot: rows=chỉ số(item_id), cols=periods (2026-Q1, 2025-Q4...)
        # Cột không phải period: "item", "item_id"
        period_cols = [c for c in ratios.columns if c not in ("item", "item_id")]

        def get_by_id(*ids):
            """Tìm hàng theo item_id, lấy giá trị period mới nhất."""
            if not period_cols:
                return None
            latest_col = period_cols[0]
            for iid in ids:
                if "item_id" in ratios.columns:
                    rows = ratios[ratios["item_id"].astype(str).str.lower() == iid.lower()]
                    if not rows.empty:
                        return _safe_float(rows.iloc[0][latest_col])
                if "item" in ratios.columns:
                    rows = ratios[ratios["item"].astype(str).str.lower().str.contains(iid.lower(), na=False)]
                    if not rows.empty:
                        return _safe_float(rows.iloc[0][latest_col])
            return None

        result = {
            "symbol": symbol,
            "periods": len(period_cols),
            "latest": {
                # ROE — item_id thực tế của vnstock v4
                "roe":            get_by_id("roe", "return_on_equity",
                                            "loi_nhuan_von_chu_so_huu",
                                            "roa_roe", "roe_ratio"),
                # ROA
                "roa":            get_by_id("roa", "return_on_assets",
                                            "loi_nhuan_tren_tai_san",
                                            "return_on_asset"),
                # EPS — trailing_eps là item_id chính xác
                "eps":            get_by_id("trailing_eps", "eps",
                                            "earnings_per_share",
                                            "thu_nhap_tren_co_phieu"),
                # P/E — pe_ratio là item_id chính xác
                "pe":             get_by_id("pe_ratio", "pe",
                                            "price_to_earnings",
                                            "p_e_ratio"),
                # P/B — pb_ratio là item_id chính xác
                "pb":             get_by_id("pb_ratio", "pb",
                                            "price_to_book",
                                            "p_b_ratio"),
                # D/E
                "debt_to_equity": get_by_id("debt_to_equity", "de_ratio",
                                            "no_tren_von_chu_so_huu",
                                            "debt_equity_ratio"),
            },
            "history": _serialize(ratios.head(8))
        }
        _cache_set(key, result, TTL_FINANCE)
        return result
    except Exception as e:
        logger.error(f"/financial-summary/{symbol}: {e}")
        return _err(str(e))

# ===== ETF =====

@app.get("/etf/{symbol}")
def get_etf(symbol: str):
    symbol = symbol.upper()
    try:
        data = Market().etf(symbol).ohlcv(start=_days_ago(30), end=_today())
        if data is None or data.empty:
            return _err(f"Không có dữ liệu ETF {symbol}", 404)
        return _serialize(data.tail(10))
    except Exception as e:
        return _err(str(e))

# ===== QUỸ MỞ =====

@app.get("/fund/{symbol}")
def get_fund_nav(symbol: str):
    symbol = symbol.upper()
    try:
        mkt = Market()
        try:
            nav = mkt.fund(symbol).nav()
        except Exception:
            nav = mkt.fund(symbol).history()
        if nav is None or nav.empty:
            return _err(f"Không có dữ liệu NAV cho quỹ {symbol}", 404)
        return _serialize(nav.tail(20))
    except Exception as e:
        return _err(str(e))

@app.get("/fund/{symbol}/top")
def get_fund_top_holdings(symbol: str):
    symbol = symbol.upper()
    try:
        data = _fetch_fund_holdings(symbol)
        if not data:
            return _err(f"Không có top holdings cho quỹ {symbol}", 404)
        return data
    except Exception as e:
        return _err(str(e))

@app.get("/fund/{symbol}/industry")
def get_fund_industry(symbol: str):
    symbol = symbol.upper()
    try:
        try:
            data = Reference().fund(symbol).industry_holding()
        except Exception:
            data = Market().fund(symbol).industry_holding()
        if data is None or data.empty:
            return _err(f"Không có dữ liệu phân bổ ngành cho quỹ {symbol}", 404)
        return _serialize(data)
    except Exception as e:
        return _err(str(e))

# ===== FUND FAVORITES =====

@app.get("/fund-favorites")
def get_fund_favorites():
    result = {}
    for fund_name in ["DCDS", "DCDE"]:
        try:
            holdings = _fetch_fund_holdings(fund_name)
            result[fund_name] = holdings[:10] if isinstance(holdings, list) else []
        except Exception:
            result[fund_name] = []
    return result

# ===== KIỂM TRA QUỸ NẮM GIỮ =====

@app.get("/fund-check/{symbol}")
def get_fund_check(symbol: str):
    symbol = symbol.upper()
    held_by = []
    for fund_name in WATCHED_FUNDS:
        try:
            holdings = _fetch_fund_holdings(fund_name)
            if not holdings:
                continue
            for row in holdings:
                code = str(row.get("stock_code") or row.get("symbol") or row.get("ticker") or "").upper()
                if code == symbol:
                    weight = _safe_float(row.get("net_asset_percent") or row.get("weight") or row.get("allocation")) or 0.0
                    held_by.append({"fund": fund_name, "weight": weight})
                    break
        except Exception:
            pass
    return {"symbol": symbol, "held_by": held_by, "fund_count": len(held_by)}

# ===== CHẤM ĐIỂM =====

@app.get("/score/{symbol}")
def get_score(symbol: str):
    symbol = symbol.upper()
    logger.info(f"/score/{symbol}")
    total_score = 0
    reasons = []

    try:
        fund_data = get_fund_check(symbol)
        held_by = fund_data.get("held_by", [])
        if held_by:
            fund_score = min(len(held_by) * 10, 20)
            total_score += fund_score
            for f in held_by:
                reasons.append(f"{f['fund']} nắm giữ {f['weight']:.2f}% NAV")
    except Exception:
        pass

    try:
        co = get_company(symbol)
        if isinstance(co, list) and len(co) > 0:
            total_score += 5
            reasons.append("Có dữ liệu doanh nghiệp")
    except Exception:
        pass

    try:
        div = get_dividend(symbol)
        if isinstance(div, list) and len(div) > 0:
            total_score += 15
            reasons.append(f"Có {len(div)} kỳ cổ tức/sự kiện")
    except Exception:
        pass

    try:
        fin = get_financial_summary(symbol)
        if isinstance(fin, dict) and fin.get("periods", 0) > 0:
            total_score += 5
            reasons.append("Có dữ liệu tài chính")
            l = fin.get("latest", {})
            roe = l.get("roe")
            if roe is not None:
                if roe >= 20:   total_score += 15; reasons.append(f"ROE xuất sắc ({roe:.1f}%)")
                elif roe >= 15: total_score += 10; reasons.append(f"ROE tốt ({roe:.1f}%)")
                elif roe >= 10: total_score += 5;  reasons.append(f"ROE khá ({roe:.1f}%)")
            roa = l.get("roa")
            if roa is not None:
                if roa >= 10:  total_score += 10; reasons.append(f"ROA cao ({roa:.1f}%)")
                elif roa >= 5: total_score += 5;  reasons.append(f"ROA khá ({roa:.1f}%)")
            eps = l.get("eps")
            if eps is not None and eps > 0:
                total_score += 5; reasons.append(f"EPS dương ({eps:,.0f})")
            debt = l.get("debt_to_equity")
            if debt is not None:
                if debt < 0.5:  total_score += 10; reasons.append(f"Nợ rất thấp D/E={debt:.2f}")
                elif debt < 1:  total_score += 5;  reasons.append(f"Nợ thấp D/E={debt:.2f}")
            pe = l.get("pe")
            if pe is not None and pe > 0:
                if pe < 15:   total_score += 5; reasons.append(f"P/E hấp dẫn ({pe:.1f})")
                elif pe < 25: total_score += 3; reasons.append(f"P/E hợp lý ({pe:.1f})")
            pb = l.get("pb")
            if pb is not None and pb > 0:
                if pb < 2:   total_score += 5; reasons.append(f"P/B hấp dẫn ({pb:.1f})")
                elif pb < 3: total_score += 3; reasons.append(f"P/B hợp lý ({pb:.1f})")
    except Exception:
        pass

    total_score = min(total_score, 100)
    if total_score >= 90:   rating = "Xuất sắc"
    elif total_score >= 75: rating = "Rất tốt"
    elif total_score >= 60: rating = "Tốt"
    elif total_score >= 40: rating = "Theo dõi"
    else:                    rating = "Yếu"

    return {"symbol": symbol, "score": total_score, "rating": rating, "reasons": reasons}

# ===== CHẤT LƯỢNG =====

@app.get("/quality/{symbol}")
def get_quality(symbol: str):
    symbol = symbol.upper()
    data = get_score(symbol)
    score_value = data.get("score", 0)
    rating = data.get("rating", "Yếu")
    fund_score = 0
    div_score  = 0
    try:
        fc = get_fund_check(symbol)
        fund_score = min(len(fc.get("held_by", [])) * 10, 20)
    except Exception:
        pass
    try:
        dv = get_dividend(symbol)
        if isinstance(dv, list) and len(dv) > 0:
            div_score = 15
    except Exception:
        pass
    quality_score = max(0, score_value - fund_score - div_score)
    if score_value >= 85:   recommendation = "Tích sản dài hạn"
    elif score_value >= 65: recommendation = "Theo dõi thêm"
    elif score_value >= 40: recommendation = "Quan sát"
    else:                    recommendation = "Không ưu tiên"
    return {
        "symbol": symbol, "score": score_value, "rating": rating,
        "recommendation": recommendation, "quality_score": quality_score,
        "fund_score": fund_score, "dividend_score": div_score,
        "reasons": data.get("reasons", [])
    }

# ===== HOLD =====

@app.get("/hold/{symbol}")
def get_hold(symbol: str):
    symbol = symbol.upper()
    try:
        price_data   = get_stock_price(symbol)
        quality_data = get_quality(symbol)
        fund_data    = get_fund_check(symbol)
        company_data = None
        try:
            co = get_company(symbol)
            if isinstance(co, list) and co:
                company_data = co[0]
        except Exception:
            pass
        events_data = None
        try:
            ev = Reference().company(symbol).events()
            if ev is not None and not ev.empty:
                events_data = _serialize(ev.head(5))
        except Exception:
            pass
        return {"symbol": symbol, "price": price_data, "quality": quality_data,
                "funds": fund_data, "company": company_data, "recent_events": events_data}
    except Exception as e:
        logger.error(f"/hold/{symbol}: {e}")
        return _err(str(e))

# ===== COMPARE =====

@app.get("/compare/{symbol1}/{symbol2}")
def compare(symbol1: str, symbol2: str):
    return {symbol1.upper(): get_quality(symbol1), symbol2.upper(): get_quality(symbol2)}

# ===== RECOMMEND =====

@app.get("/recommend")
def recommend():
    logger.info("/recommend — bắt đầu quét")
    best: dict = {}
    for fund_name in ["DCDS", "DCDE"]:
        try:
            holdings = _fetch_fund_holdings(fund_name)
            if not holdings:
                continue
            for row in holdings:
                symbol = str(row.get("stock_code") or row.get("symbol") or row.get("ticker") or "").upper()
                if not symbol or symbol in best:
                    continue
                try:
                    q = get_quality(symbol)
                    if isinstance(q, dict) and "score" in q:
                        best[symbol] = {"symbol": symbol, "score": q["score"],
                                        "rating": q["rating"], "recommendation": q["recommendation"]}
                except Exception as e:
                    logger.warning(f"/recommend — {symbol}: {e}")
        except Exception as e:
            logger.error(f"/recommend — {fund_name}: {e}")
    result = sorted(best.values(), key=lambda x: x["score"], reverse=True)
    return result[:10]

# ===== PORTFOLIO SCORE =====

@app.post("/portfolio-score")
def portfolio_score(data: PortfolioRequest):
    if not data.stocks:
        return _err("Danh sách cổ phiếu không được rỗng", 400)
    details = []
    total = 0
    for symbol in data.stocks:
        q = get_quality(symbol)
        total += q.get("score", 0) if isinstance(q, dict) else 0
        details.append(q)
    return {"portfolio_score": round(total / len(data.stocks), 2),
            "stock_count": len(data.stocks), "details": details}

# ===== MARKET =====

@app.get("/market")
def get_market():
    result = {}
    # VNINDEX và VN30 dùng symbol chuẩn
    # HNX → "HNX" thường không được hỗ trợ, fallback sang mã tương đương
    indices = {
        "vnindex": "VNINDEX",
        "vn30":    "VN30",
        "hnx":     "HNX30",
        "upcom":   "UPCOM",
    }
    for key, idx in indices.items():
        for attempt_idx in ([idx] + (["HNX"] if key == "hnx" else []) + (["UpcomIndex"] if key == "upcom" else [])):
            try:
                df = Market().index(attempt_idx).ohlcv(start=_days_ago(3), end=_today(), interval="1D")
                if df is not None and not df.empty:
                    latest = df.iloc[-1]
                    close_col = _col(df, "close", "Close") or df.columns[-2]
                    idx_date = ""
                    try:
                        idx_date = str(df.index[-1])[:10]
                    except Exception:
                        idx_date = _today()
                    result[key] = {"index": attempt_idx, "close": float(latest[close_col]), "date": idx_date}
                    break
            except Exception as e:
                result[key] = {"index": idx, "close": None, "error": str(e)}
    return result

# ===== NEWS =====

@app.get("/news/{symbol}")
def get_news(symbol: str):
    symbol = symbol.upper()
    key = f"news_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        ref = Reference()
        news_data = None
        try:
            news_data = ref.company(symbol).news()
        except Exception:
            pass
        if news_data is None or (hasattr(news_data, "empty") and news_data.empty):
            try:
                news_data = ref.company(symbol).events()
            except Exception:
                pass
        if news_data is None or (hasattr(news_data, "empty") and news_data.empty):
            return _err(f"Không có tin tức cho {symbol}", 404)
        records = _serialize(news_data)
        result = []
        for r in records[:20]:
            item = {}
            for k in ["title","headline","name","event"]:
                if r.get(k): item["title"] = str(r[k]); break
            for k in ["date","time","published_at","publish_date","event_date"]:
                if r.get(k): item["date"] = str(r[k])[:19]; break
            for k in ["source","publisher","url"]:
                if r.get(k): item["source"] = str(r[k]); break
            if item:
                result.append(item)
        _cache_set(key, result, TTL_NEWS)
        return result
    except Exception as e:
        logger.error(f"/news/{symbol}: {e}")
        return _err(str(e))

# ===== ANALYZE =====

@app.get("/analyze/{symbol}")
def get_analyze(symbol: str):
    symbol = symbol.upper()
    result: dict = {"symbol": symbol}

    def safe_call(fn, *args):
        try:
            r = fn(*args)
            if hasattr(r, "status_code"):
                return None
            return r
        except Exception:
            return None

    result["price"]    = safe_call(get_stock_price, symbol)
    result["company"]  = safe_call(get_company, symbol)
    result["score"]    = safe_call(get_score, symbol)
    result["quality"]  = safe_call(get_quality, symbol)
    result["dividend"] = safe_call(get_dividend, symbol)
    result["funds"]    = safe_call(get_fund_check, symbol)
    result["news"]     = safe_call(get_news, symbol)
    return result

# ===== INDEX =====

@app.get("/index/{symbol}")
def get_index(symbol: str):
    symbol = symbol.upper()
    try:
        df = Market().index(symbol).ohlcv(start=_days_ago(30), end=_today(), interval="1D")
        if df is None or df.empty:
            return _err(f"Không có dữ liệu chỉ số {symbol}", 404)
        latest = df.iloc[-1]
        close_col = _col(df, "close", "Close") or df.columns[-2]
        vol_col   = _col(df, "volume", "Volume") or df.columns[-1]
        prev = df.iloc[-2] if len(df) >= 2 else None
        change_pct = None
        if prev is not None:
            prev_close = float(prev[close_col])
            cur_close  = float(latest[close_col])
            if prev_close:
                change_pct = round((cur_close - prev_close) / prev_close * 100, 2)
        return {
            "symbol": symbol, "close": float(latest[close_col]),
            "volume": int(latest[vol_col]), "change_pct": change_pct,
            "history": _serialize(df.tail(30))
        }
    except Exception as e:
        return _err(str(e))

# ===== GROWTH STOCKS =====

@app.get("/growth-stocks")
def get_growth_stocks():
    candidates = []
    seen = set()
    for fund_name in ["DCDS", "DCDE", "DCBF"]:
        try:
            holdings = _fetch_fund_holdings(fund_name)
            for row in holdings:
                sym = str(row.get("stock_code") or row.get("symbol") or "").upper()
                if not sym or sym in seen:
                    continue
                seen.add(sym)
                try:
                    fin = get_financial_summary(sym)
                    if not isinstance(fin, dict) or fin.get("periods", 0) == 0:
                        continue
                    l = fin.get("latest", {})
                    roe = l.get("roe"); eps = l.get("eps")
                    if roe and roe >= 15 and eps and eps > 0:
                        candidates.append({"symbol": sym, "roe": roe, "eps": eps,
                                           "debt_to_equity": l.get("debt_to_equity"),
                                           "pe": l.get("pe"), "pb": l.get("pb")})
                except Exception:
                    pass
        except Exception:
            pass
    result = sorted(candidates, key=lambda x: x.get("roe", 0), reverse=True)
    return {"count": len(result), "stocks": result[:20]}

# ===== DIVIDEND KINGS =====

@app.get("/dividend-kings")
def get_dividend_kings():
    candidates = []
    seen = set()
    for fund_name in ["DCDS", "DCDE", "DCBF"]:
        try:
            holdings = _fetch_fund_holdings(fund_name)
            for row in holdings:
                sym = str(row.get("stock_code") or row.get("symbol") or "").upper()
                if not sym or sym in seen:
                    continue
                seen.add(sym)
                try:
                    div = get_dividend(sym)
                    if not isinstance(div, list) or len(div) == 0:
                        continue
                    sc = get_score(sym)
                    score_val = sc.get("score", 0) if isinstance(sc, dict) else 0
                    candidates.append({"symbol": sym, "dividend_count": len(div),
                                       "score": score_val,
                                       "rating": sc.get("rating") if isinstance(sc, dict) else None})
                except Exception:
                    pass
        except Exception:
            pass
    result = sorted(candidates, key=lambda x: (x.get("dividend_count", 0), x.get("score", 0)), reverse=True)
    return {"count": len(result), "stocks": result[:20]}