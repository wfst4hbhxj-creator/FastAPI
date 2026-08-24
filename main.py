from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
import logging
import os
import time
import socket
import requests
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
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

@app.middleware("http")
async def add_charset_header(request, call_next):
    response = await call_next(request)
    if "application/json" in response.headers.get("content-type", ""):
        response.headers["content-type"] = "application/json; charset=utf-8"
    return response

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
# NOTE: Render free tier (Singapore/US) cannot reliably connect to Vietnam's DNSE API.
# DNSE is optional - all endpoints gracefully fallback to vnstock sources (VCI/TCBS/MSN).
_dnse_client = None
_dnse_last_init_attempt = 0
_DNSE_INIT_RETRY_INTERVAL = 300  # 5 phút - thử lại sau 5 phút nếu init thất bại
_dnse_unreachable_count = 0
_DNSE_MAX_UNREACHABLE = 2  # sau 2 lần thất bại liên tiếp, tạm ngừng gọi DNSE
_dnse_last_success = 0
_DNSE_QUICK_TIMEOUT = 8  # giây - timeout nhanh cho DNSE calls (tăng từ 5s)

def _get_dnse_client():
    """Khởi tạo DNSEClient dạng lazy singleton. Tự retry sau interval nếu env vars được set sau."""
    global _dnse_client, _dnse_last_init_attempt
    if _dnse_client is not None:
        return _dnse_client
    
    now = time.time()
    if now - _dnse_last_init_attempt < _DNSE_INIT_RETRY_INTERVAL:
        return None
    
    _dnse_last_init_attempt = now
    api_key = os.getenv("DNSE_API_KEY")
    api_secret = os.getenv("DNSE_API_SECRET")
    if not api_key or not api_secret:
        return None
    try:
        from dnse import DNSEClient
        _dnse_client = DNSEClient(
            api_key=api_key,
            api_secret=api_secret,
            base_url=os.getenv("DNSE_BASE_URL", "https://openapi.dnse.com.vn"),
            api_version=os.getenv("DNSE_API_VERSION") or None,
        )
        # Ép rút ngắn timeout nội bộ của SDK. Mặc định SDK hard-code connect=30s/read=60s
        # (dnse/api/client.py, dòng ~33: urllib3.PoolManager(timeout=urllib3.Timeout(...))),
        # KHÔNG có tham số constructor để override — đây là truy cập trực tiếp thuộc tính
        # nội bộ (_http) không được SDK chính thức hỗ trợ/document.
        # TODO: verify nếu nâng version dnse-sdk-openapi — thuộc tính _http có thể đổi tên.
        try:
            import urllib3
            _dnse_client._http.connection_pool_kw['timeout'] = urllib3.Timeout(connect=3.0, read=8.0)
            _dnse_client._http.connection_pool_kw['retries'] = urllib3.Retry(total=1, connect=1, backoff_factor=0)
            logger.info(f"DNSE SDK timeout đã ép xuống: {_dnse_client._http.connection_pool_kw.get('timeout')}")
        except Exception as e:
            logger.warning(f"Không override được timeout SDK DNSE (không chặn chức năng, chỉ mất tối ưu fail-fast): {e}")
        logger.info("DNSE client khởi tạo thành công")
        return _dnse_client
    except Exception as e:
        logger.warning(f"DNSE client init lỗi: {e}")
        return None

def _dnse_quick_call(call_func, *args, **kwargs):
    """
    Gọi DNSE API với timeout nhanh (5s) và circuit breaker.
    - Timeout 5s max
    - Circuit breaker sau 2 lần fail liên tiếp -> nghỉ 5 phút
    - Return (status, body) hoặc (None, error)
    """
    global _dnse_unreachable_count, _dnse_last_success
    now = time.time()
    
    # Circuit breaker: nếu quá nhiều lỗi liên tiếp, tạm ngừng 5 phút
    if _dnse_unreachable_count >= _DNSE_MAX_UNREACHABLE:
        if now - _dnse_last_success < 300:  # 5 phút
            return None, "circuit_open"
        else:
            _dnse_unreachable_count = 0  # reset sau 5 phút
    
    # Chạy trong thread riêng với timeout 5s — dùng _dnse_executor RIÊNG (không phải
    # _bounded_executor dùng chung với vnstock), để DNSE treo không kéo vnstock nghẽn theo.
    future = _dnse_executor.submit(call_func, *args, **kwargs)
    try:
        status, body = future.result(timeout=_DNSE_QUICK_TIMEOUT)
        _dnse_unreachable_count = 0
        _dnse_last_success = time.time()
        return status, body
    except Exception as e:
        err_msg = str(e).lower()
        # Check nếu là network timeout/connection error
        if any(kw in str(e).lower() for kw in ["timeout", "connect", "connection", "unreachable", "dns", "resolve", "timed out"]):
            _dnse_unreachable_count += 1
            logger.warning(f"DNSE unreachable ({_dnse_unreachable_count}/{_DNSE_MAX_UNREACHABLE}): {e}")
        else:
            logger.warning(f"DNSE call lỗi: {e}")
        return None, str(e)

_VNSTOCK_QUICK_TIMEOUT = 60  # giây - timeout cho vnstock calls (vnstock chậm hơn DNSE, server Render Singapore->Vietnam chậm)

def _vnstock_quick_call(call_func, *args, **kwargs):
    """
    Gọi vnstock API với timeout nhanh (60s).
    - Timeout 60s max (vnstock chậm hơn DNSE, server Render Singapore->Vietnam chậm)
    - Không có circuit breaker (vnstock ổn định hơn)
    - Return (result) hoặc (None, error)
    """
    logger.info(f"vnstock_quick_call: starting call_func={call_func.__name__ if hasattr(call_func, '__name__') else call_func}, args={args}, kwargs={kwargs}")
    future = _bounded_executor.submit(call_func, *args, **kwargs)
    try:
        result = future.result(timeout=_VNSTOCK_QUICK_TIMEOUT)
        logger.info(f"vnstock_quick_call: completed successfully, result type={type(result)}")
        return result, None
    except Exception as e:
        logger.exception(f"vnstock call lỗi/timeout: {e}")
        return None, str(e)

def _dnse_get_latest_quote(symbol):
    """
    Lấy báo giá mới nhất từ DNSE Market Data API (get_latest_quote).
    Trả về {"close": <nghìn đồng>, "volume": <int|None>} hoặc None nếu lỗi/không có client.
    LƯU Ý ĐƠN VỊ: DNSE trả giá theo VND thực (vd 60500), toàn hệ thống (vnstock, GAS bot)
    đang dùng đơn vị nghìn đồng (vd 60.5) — nên phải chia 1000 ở đây để KHÔNG phá vỡ quy ước cũ.
    Có fallback vnstock qua endpoint /stock.
    """
    client = _get_dnse_client()
    if client is None:
        return None
    key = f"dnse_quote_{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    status, body = _dnse_quick_call(
        client.get_latest_quote, symbol=symbol, board_id="G1", dry_run=False
    )
    if status == 200 and body:
        raw_close = body.get("matchPrice") or body.get("closePrice") or body.get("close") or body.get("price")
        raw_volume = body.get("matchQtty") or body.get("volume") or body.get("totalVolume")
        close_vnd = _safe_float(raw_close)
        if close_vnd is not None and close_vnd > 0:
            result = {"close": round(close_vnd / 1000, 2), "volume": int(raw_volume) if raw_volume is not None else None}
            _cache_set(key, result, TTL_DNSE_QUOTE)
            return result
    
    # Fallback vnstock qua endpoint /stock (có timeout)
    try:
        logger.info(f"_dnse_get_latest_quote: calling _vnstock_quick_call for symbol={symbol}")
        quote, err = _vnstock_quick_call(_get_vnstock_quote, symbol)
        logger.info(f"_dnse_get_latest_quote fallback: symbol={symbol}, quote={quote}, err={err}, type={type(quote)}")
        if err is None and quote and quote.get("close"):
            result = {"close": quote["close"], "volume": quote.get("volume")}
            _cache_set(key, result, TTL_DNSE_QUOTE)
            return result
        if err:
            logger.warning(f"Fallback vnstock get_latest_quote lỗi: {err}")
    except Exception as e:
        logger.exception(f"Fallback vnstock get_latest_quote exception: {e}")
    return None


def _get_vnstock_quote(symbol):
    """Lấy quote từ vnstock Market().equity().ohlcv (5 ngày gần nhất)."""
    quote = Market().equity(symbol).ohlcv(start=_days_ago(5), end=_today(), interval="1D")
    if quote is not None and not quote.empty:
        latest = quote.iloc[-1]
        close_col = _col(quote, "close", "Close") or quote.columns[-2]
        vol_col = _col(quote, "volume", "Volume") or quote.columns[-1]
        return {"close": float(latest[close_col]), "volume": int(latest[vol_col])}
    return None

# =====================================
# 🏦 FUND HOLDINGS — 4 lớp fallback (dừng ở lớp đầu tiên thành công)
# Sửa lỗi "Không lấy được dữ liệu quỹ (DCDS/DCDE)": trước đây chỉ có 1 lệnh gọi vnstock
# (bọc trong except: pass ở tầng endpoint) nên fmarket.vn chập chờn là mất hết dữ liệu.
# =====================================

# Lớp 2 — gọi thẳng public API fmarket.vn, KHÔNG qua vnstock.
# Endpoint/method/headers/payload dưới đây COPY Y HỆT từ source code vnstock==4.0.4 đã cài
# (pip show vnstock -> Location: site-packages), cụ thể tại 2 file:
#   - site-packages/vnstock/explorer/fmarket/const.py  → _BASE_URL
#   - site-packages/vnstock/explorer/fmarket/fund.py    → Fund.filter() và Fund.top_holding()
#   - site-packages/vnstock/core/utils/user_agent.py    → get_headers(data_source="fmarket")
#     (Referer/Origin "https://fmarket.vn/", Content-Type application/json)
# Đây là fallback ĐỘC LẬP với lớp 1: nếu vnstock có bug/lỗi phiên bản trong wrapper (chứ không
# phải bản thân fmarket.vn chết), gọi thẳng endpoint gốc vẫn có thể thành công.
FMARKET_BASE_URL = "https://api.fmarket.vn/res/products"
FMARKET_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Referer": "https://fmarket.vn/",
    "Origin": "https://fmarket.vn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}

def _fmarket_direct_top_holding(fund_name):
    """
    Copy lại đúng 2 bước mà vnstock.explorer.fmarket.fund.Fund thực hiện nội bộ:
      1. POST {FMARKET_BASE_URL}/filter — tra fundId từ short_name (vd "DCDS")
      2. GET  {FMARKET_BASE_URL}/{fundId} — lấy productTopHoldingList + productTopHoldingBondList
    Trả về list[dict] cùng field name với kết quả lớp 1 (đã _serialize) để không phá vỡ schema.
    Raise Exception nếu lỗi — để hàm gọi (_fetch_fund_holdings) tự bắt và rơi xuống lớp 3.
    """
    fund_name = fund_name.upper()
    filter_payload = {"searchField": fund_name, "types": ["NEW_FUND", "TRADING_FUND"], "pageSize": 100}
    r1 = requests.post(f"{FMARKET_BASE_URL}/filter", json=filter_payload, headers=FMARKET_HEADERS, timeout=6)
    r1.raise_for_status()
    rows = ((r1.json() or {}).get("data") or {}).get("rows") or []
    match = next((row for row in rows if str(row.get("shortName", "")).upper() == fund_name), None)
    if not match:
        raise ValueError(f"fmarket trực tiếp: không tìm thấy quỹ '{fund_name}' trong kết quả filter")
    fund_id = int(match["id"])

    r2 = requests.get(f"{FMARKET_BASE_URL}/{fund_id}", headers=FMARKET_HEADERS, timeout=6)
    r2.raise_for_status()
    body = (r2.json() or {}).get("data") or {}

    rows_out = []
    for item in (body.get("productTopHoldingList") or []) + (body.get("productTopHoldingBondList") or []):
        rows_out.append({
            "stock_code": item.get("stockCode"),
            "industry": item.get("industry"),
            "net_asset_percent": item.get("netAssetPercent"),
            "type_asset": item.get("type"),
            "update_at": item.get("updateAt"),
            "fundId": fund_id,
            "short_name": fund_name,
        })
    if not rows_out:
        raise ValueError(f"fmarket trực tiếp: fundId={fund_id} không có top holding nào")
    return rows_out

# Lớp 3 — "cache cuối cùng thành công", tách khỏi _cache/TTL_FUND (KHÔNG bao giờ tự hết hạn,
# chỉ bị ghi đè khi có lần fetch mới thành công). Đây là bộ nhớ trong process, sẽ mất khi Render
# restart instance — chấp nhận được vì mục đích chỉ là chống gián đoạn tạm thời của fmarket.vn.
_fund_holdings_last_good: dict = {}

# Lớp 4 — snapshot tĩnh dự phòng (last resort), CHỈ dùng khi lớp 1+2+3 đều thất bại và
# CHƯA TỪNG có lần fetch nào thành công kể từ khi service khởi động (ví dụ mới deploy lần đầu).
# ⚠️ Claude KHÔNG tự bịa số liệu — các list dưới đây để RỖNG, người dùng tự điền tay hàng tháng
# từ bài công bố định kỳ của Dragon Capital tại dautu.dragoncapital.com.vn/tin-tuc/...
# (trang bài viết văn bản thường, không bị chặn robots — khác 3 link sản phẩm dạng JS).
# Format mỗi phần tử PHẢI giống hệt các lớp trên để không phá vỡ schema, ví dụ:
#   {"stock_code": "HPG", "industry": "Vật liệu xây dựng", "net_asset_percent": 8.5,
#    "type_asset": "STOCK", "update_at": "2026-08-01", "fundId": None, "short_name": "DCDS"}
FUND_HOLDINGS_FALLBACK = {
    "DCDS": [],  # TODO: người dùng tự điền top 10 holding DCDS (xem format ở comment trên)
    "DCDE": [],  # TODO: người dùng tự điền top 10 holding DCDE
    "DCBF": [],  # TODO: người dùng tự điền top 10 holding DCBF
}

# Global executor for bounded calls - reuse to avoid thread exhaustion
_bounded_executor = ThreadPoolExecutor(max_workers=8)

# Executor RIÊNG cho DNSE — tách khỏi _bounded_executor (dùng cho vnstock + các việc khác)
# để khi DNSE treo, các luồng ngầm bị treo (Python không force-kill được thread) chỉ chiếm
# pool riêng của DNSE (4 workers), không kéo theo vnstock fallback bị nghẽn dây chuyền.
_dnse_executor = ThreadPoolExecutor(max_workers=4)


def _bounded_call(fn, args=(), kwargs=None, hard_timeout=6):
    """
    Chạy fn(*args, **kwargs) trong thread riêng với timeout CỨNG.
    Dùng shared executor để tránh tạo quá nhiều thread.
    Trả None nếu timeout hoặc lỗi.
    """
    kwargs = kwargs or {}
    future = _bounded_executor.submit(fn, *args, **kwargs)
    try:
        return future.result(timeout=hard_timeout)
    except FutureTimeoutError:
        logger.warning(f"_bounded_call: {getattr(fn, '__name__', fn)} vượt timeout cứng {hard_timeout}s")
        return None
    except Exception as e:
        logger.warning(f"_bounded_call: {getattr(fn, '__name__', fn)} lỗi: {e}")
        return None


def _bounded_vnstock_call(fn, args=(), kwargs=None, hard_timeout=10):
    """Wrapper cho vnstock calls với timeout 10s mặc định."""
    return _bounded_call(fn, args, kwargs, hard_timeout)

def _fetch_funds_sequential(fund_names):
    """
    Chạy _fetch_fund_holdings() cho nhiều quỹ TUẦN TỰ — tránh crash do thread-safety.
    """
    fund_names = list(fund_names)
    results = {}
    for fn in fund_names:
        try:
            results[fn] = _fetch_fund_holdings(fn) or []
        except Exception as e:
            logger.warning(f"_fetch_funds_sequential: quỹ {fn} lỗi: {e}")
            results[fn] = []
    return results

def _map_sequential(items, fn, timeout_per_item=15):
    """
    Chạy fn(item) cho từng item TUẦN TỰ — dùng cho các endpoint gọi vnstock
    để tránh crash do thread-safety của vnstock. Giữ timeout logic giống _map_parallel.
    """
    items = list(items)
    results = {}
    for item in items:
        try:
            # Gọi trực tiếp, không dùng thread pool
            results[item] = fn(item)
        except Exception as e:
            logger.warning(f"_map_sequential: item {item} lỗi: {e}")
            results[item] = None
    return results

def _fetch_fund_holdings(fund_name):
    """
    Lấy top holding quỹ mở, 4 lớp fallback theo thứ tự, dừng ở lớp đầu tiên thành công:
      1. vnstock (Reference → Market), timeout CỨNG 6s/nguồn qua _bounded_call, KHÔNG retry
         (tối đa ~12s cho cả lớp — thay cho bản retry+backoff cũ có thể lên tới 360s/quỹ)
      2. Gọi thẳng fmarket.vn (_fmarket_direct_top_holding), timeout 6s/request (tối đa ~12s)
      3. Cache cũ nhất từng thành công (_fund_holdings_last_good), bất kể đã hết TTL_FUND
      4. Snapshot tĩnh FUND_HOLDINGS_FALLBACK do người dùng tự cập nhật tay
    Field "stale": true được thêm vào mỗi holding khi dữ liệu đến từ lớp 3 hoặc lớp 4.
    """
    key = f"fund_holdings_{fund_name}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    def _remember_success(result):
        _cache_set(key, result, TTL_FUND)
        _fund_holdings_last_good[fund_name] = {"data": result, "ts": time.time()}

    # ── Lớp 1: vnstock, timeout cứng 6s/nguồn, KHÔNG retry/sleep ──
    def _via_reference():
        return _serialize(Reference().fund(fund_name).top_holding())

    def _via_market():
        return _serialize(Market().fund(fund_name).top_holding())

    result = _bounded_call(_via_reference, hard_timeout=6)
    if result:
        _remember_success(result)
        return result

    result = _bounded_call(_via_market, hard_timeout=6)
    if result:
        _remember_success(result)
        return result

    logger.warning(f"_fetch_fund_holdings({fund_name}) — lớp 1 (vnstock) thất bại/timeout (Reference + Market, 6s/nguồn)")

    # ── Lớp 2: gọi thẳng fmarket.vn ──
    try:
        result = _fmarket_direct_top_holding(fund_name)
        if result:
            _remember_success(result)
            logger.info(f"_fetch_fund_holdings({fund_name}) — lớp 1 thất bại, lớp 2 (fmarket trực tiếp) thành công")
            return result
    except Exception as e:
        logger.warning(f"_fetch_fund_holdings({fund_name}) — lớp 2 (fmarket trực tiếp) lỗi: {e}")

    # ── Lớp 3: cache cũ (stale), không theo TTL ──
    stale = _fund_holdings_last_good.get(fund_name)
    if stale:
        age_min = round((time.time() - stale["ts"]) / 60, 1)
        logger.warning(f"_fetch_fund_holdings({fund_name}) — lớp 1+2 thất bại, dùng cache cũ (stale, {age_min} phút trước)")
        result = [dict(row, stale=True) for row in stale["data"]]
        return result

    # ── Lớp 4: snapshot tĩnh dự phòng ──
    fallback = FUND_HOLDINGS_FALLBACK.get(fund_name.upper()) or []
    if fallback:
        logger.warning(f"⚠️ _fetch_fund_holdings({fund_name}) — TẤT CẢ lớp 1/2/3 thất bại, dùng snapshot tĩnh FUND_HOLDINGS_FALLBACK (dữ liệu có thể đã cũ — cần cập nhật tay).")
        return [dict(row, stale=True) for row in fallback]

    logger.error(f"❌ _fetch_fund_holdings({fund_name}) — cả 4 lớp đều không có dữ liệu.")
    return []

# =====================================
# 🩺 CHẨN ĐOÁN fund-holdings — CHỈ phục vụ /debug/fund-holdings, KHÔNG dùng bởi bot/endpoint khác.
# Chạy ĐỘC LẬP với _fetch_fund_holdings() ở trên (không sửa/gọi lại hàm đó): chạy đủ CẢ 4 lớp
# bất kể lớp trước có thành công hay không, để đo được chính xác thời gian + lỗi của TỪNG lớp.
# KHÔNG ghi vào _cache/_fund_holdings_last_good — thuần túy chỉ quan sát, không có side-effect
# lên hành vi production của _fetch_fund_holdings().
# =====================================
def _bounded_call_diag(fn, args=(), kwargs=None, hard_timeout=6):
    """
    Biến thể của _bounded_call() CHỈ dùng cho /debug/fund-holdings — cùng cơ chế timeout cứng
    (executor thủ công, KHÔNG dùng `with`, shutdown(wait=False) trong finally), nhưng trả về
    (result, error_str) thay vì nuốt lỗi thành None, để endpoint chẩn đoán lấy được str(exception)
    THẬT thay vì thông báo chung chung. Không thay _bounded_call() gốc để không ảnh hưởng các
    nơi khác đang dùng nó (_fetch_fund_holdings, _fetch_funds_parallel, /fund-favorites...).
    """
    kwargs = kwargs or {}
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        future = executor.submit(fn, *args, **kwargs)
        return future.result(timeout=hard_timeout), None
    except FutureTimeoutError:
        return None, f"Timeout sau {hard_timeout}s"
    except Exception as e:
        return None, str(e)
    finally:
        executor.shutdown(wait=False)

def _diagnose_fund_holdings(fund_name):
    layer_errors = {"layer1": None, "layer2": None, "layer3": None, "layer4": None}
    layer_durations = {}
    layer_used = None
    total_start = time.time()

    # Lớp 1: vnstock, timeout cứng 6s/nguồn — cùng cấu hình với production, nhưng dùng
    # _bounded_call_diag để lấy được str(exception) thật của cả Reference lẫn Market
    t = time.time()
    layer1_result = None
    err_ref = err_mkt = None
    try:
        def _via_reference():
            return _serialize(Reference().fund(fund_name).top_holding())
        r, err_ref = _bounded_call_diag(_via_reference, hard_timeout=6)
        if not r:
            def _via_market():
                return _serialize(Market().fund(fund_name).top_holding())
            r, err_mkt = _bounded_call_diag(_via_market, hard_timeout=6)
        layer1_result = r
        if not layer1_result:
            layer_errors["layer1"] = f"Reference: {err_ref or 'rỗng, không lỗi cụ thể'} | Market: {err_mkt or 'rỗng, không lỗi cụ thể'}"
    except Exception as e:
        layer_errors["layer1"] = str(e)
    layer_durations["layer1"] = round(time.time() - t, 2)
    if layer1_result and layer_used is None:
        layer_used = "layer1"

    # Lớp 2: fmarket.vn trực tiếp
    t = time.time()
    layer2_result = None
    try:
        layer2_result = _fmarket_direct_top_holding(fund_name)
    except Exception as e:
        layer_errors["layer2"] = str(e)
    layer_durations["layer2"] = round(time.time() - t, 2)
    if layer2_result and layer_used is None:
        layer_used = "layer2"

    # Lớp 3: cache cũ — CHỈ ĐỌC, không ghi
    t = time.time()
    stale = _fund_holdings_last_good.get(fund_name)
    if not stale:
        layer_errors["layer3"] = "Chưa từng có cache thành công nào (_fund_holdings_last_good rỗng cho quỹ này)"
    layer_durations["layer3"] = round(time.time() - t, 3)
    if stale and layer_used is None:
        layer_used = "layer3"

    # Lớp 4: snapshot tĩnh — CHỈ ĐỌC
    t = time.time()
    fallback = FUND_HOLDINGS_FALLBACK.get(fund_name.upper()) or []
    if not fallback:
        layer_errors["layer4"] = "FUND_HOLDINGS_FALLBACK rỗng cho quỹ này — người dùng chưa tự điền tay"
    layer_durations["layer4"] = round(time.time() - t, 3)
    if fallback and layer_used is None:
        layer_used = "layer4"

    return {
        "layer_used": layer_used,  # None nếu CẢ 4 lớp đều không có dữ liệu
        "duration_sec": round(time.time() - total_start, 2),
        "layer_errors": layer_errors,
        "layer_durations_sec": layer_durations,
    }

@app.get("/debug/fund-holdings")
def debug_fund_holdings():
    """
    Endpoint CHẨN ĐOÁN THẬT — KHÔNG cache, luôn chạy live (chạy đủ 4 lớp cho cả DCDS/DCDE
    dù lớp nào thành công trước), mục đích DUY NHẤT là để người dùng tự curl lấy bằng chứng
    thật khi /recommend còn lỗi. KHÔNG được bot/endpoint nào khác gọi tới.
    """
    result = {}
    for fund_name in ["DCDS", "DCDE"]:
        try:
            result[fund_name] = _diagnose_fund_holdings(fund_name)
        except Exception as e:
            result[fund_name] = {"error": f"Lỗi chẩn đoán: {e}"}
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
        company_ref = Reference().company(symbol)
        # vnstock v4: sử dụng .info() cho company overview
        data = company_ref.info()
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
        company_ref = Reference().company(symbol)
        events = company_ref.events()
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
    def _run():
        holdings_map = _fetch_funds_sequential(["DCDS", "DCDE"])
        return {fn: (h[:10] if isinstance(h, list) else []) for fn, h in holdings_map.items()}
    result = _bounded_call(_run, hard_timeout=20)
    if result is None:
        logger.error("/fund-favorites — vượt timeout cứng 20s ở tầng endpoint, trả rỗng để tránh treo Render/GAS")
        return {"DCDS": [], "DCDE": []}
    return result

# ===== KIỂM TRA QUỸ NẮM GIỮ =====

@app.get("/fund-check/{symbol}")
def get_fund_check(symbol: str):
    symbol = symbol.upper()
    held_by = []
    holdings_map = _fetch_funds_sequential(WATCHED_FUNDS)
    for fund_name in WATCHED_FUNDS:
        try:
            holdings = holdings_map.get(fund_name) or []
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
            company_ref = Reference().company(symbol)
            ev = company_ref.events()
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
    # Pre-warm cache cho CẢ 3 quỹ trong WATCHED_FUNDS (kể cả DCBF, dù không dùng làm nguồn
    # ứng viên bên dưới) — vì get_quality()->get_score()->get_fund_check() sẽ tự gọi lại
    # WATCHED_FUNDS cho MỖI mã khi chấm điểm song song ở dưới; pre-warm ở đây để N mã đó
    # đều gặp cache-hit thay vì N lệnh gọi mạng trùng lặp cùng lúc tới cùng 1 quỹ.
    holdings_map = _fetch_funds_sequential(WATCHED_FUNDS)
    candidates = []
    seen = set()
    for fund_name in ["DCDS", "DCDE"]:  # giữ nguyên nguồn ứng viên như code gốc — chỉ DCDS/DCDE
        try:
            holdings = holdings_map.get(fund_name) or []
            for row in holdings:
                symbol = str(row.get("stock_code") or row.get("symbol") or row.get("ticker") or "").upper()
                if symbol and symbol not in seen:
                    seen.add(symbol)
                    candidates.append(symbol)
        except Exception as e:
            logger.error(f"/recommend — {fund_name}: {e}")
    
    # Giới hạn số lượng ứng viên để tránh timeout Render (30s)
    candidates = candidates[:5]
    
    quality_map = _map_sequential(candidates, get_quality, timeout_per_item=30)
    for symbol, q in quality_map.items():
        try:
            if isinstance(q, dict) and "score" in q:
                best[symbol] = {"symbol": symbol, "score": q["score"],
                                "rating": q["rating"], "recommendation": q["recommendation"]}
        except Exception as e:
            logger.warning(f"/recommend — {symbol}: {e}")
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
        company_ref = Reference().company(symbol)
        news_data = company_ref.news()
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


@app.get("/test/vnstock/{symbol}")
def test_vnstock(symbol: str):
    """Test endpoint to debug vnstock calls."""
    import pandas as pd
    symbol = symbol.upper()
    try:
        quote = Market().equity(symbol).ohlcv(start=_days_ago(5), end=_today(), interval="1D")
        logger.info(f"Test vnstock: symbol={symbol}, rows={len(quote) if quote is not None else 0}, empty={quote.empty if quote is not None else True}")
        if quote is not None and not quote.empty:
            # Serialize manually to avoid _serialize_dnse issues
            sample = quote.tail(3).to_dict(orient="records")
            # Convert timestamps to strings
            for row in sample:
                for k, v in row.items():
                    if isinstance(v, (pd.Timestamp,)):
                        row[k] = v.strftime("%Y-%m-%d")
                    elif isinstance(v, float) and (v != v):  # NaN
                        row[k] = None
                    elif hasattr(v, "item"):
                        row[k] = v.item()
            return {"success": True, "rows": len(quote), "sample": sample}
        return {"success": False, "error": "No data"}
    except Exception as e:
        logger.exception(f"Test vnstock exception: {e}")
        return {"success": False, "error": str(e)}


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
    holdings_map = _fetch_funds_sequential(["DCDS", "DCDE", "DCBF"])
    
    # Collect unique symbols first
    symbols = []
    for fund_name in ["DCDS", "DCDE", "DCBF"]:
        try:
            holdings = holdings_map.get(fund_name) or []
            for row in holdings:
                sym = str(row.get("stock_code") or row.get("symbol") or "").upper()
                if sym and sym not in seen:
                    seen.add(sym)
                    symbols.append(sym)
        except Exception:
            pass
    
    if not symbols:
        return {"count": 0, "stocks": []}
    
    # Giới hạn số lượng symbols để tránh timeout Render (30s)
    symbols = symbols[:5]
    
    # Sequential fetch financial summary (vnstock not thread-safe)
    fin_map = _map_sequential(symbols, get_financial_summary, timeout_per_item=10)
    
    for sym in symbols:
        try:
            fin = fin_map.get(sym)
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
    
    result = sorted(candidates, key=lambda x: x.get("roe", 0), reverse=True)
    return {"count": len(result), "stocks": result[:20]}

# ===== DIVIDEND KINGS =====

@app.get("/dividend-kings")
def get_dividend_kings():
    candidates = []
    seen = set()
    holdings_map = _fetch_funds_sequential(["DCDS", "DCDE", "DCBF"])
    
    # Collect unique symbols first
    symbols = []
    for fund_name in ["DCDS", "DCDE", "DCBF"]:
        try:
            holdings = holdings_map.get(fund_name) or []
            for row in holdings:
                sym = str(row.get("stock_code") or row.get("symbol") or "").upper()
                if sym and sym not in seen:
                    seen.add(sym)
                    symbols.append(sym)
        except Exception:
            pass
    
    if not symbols:
        return {"count": 0, "stocks": []}
    
    # Giới hạn số lượng symbols để tránh timeout Render (30s)
    symbols = symbols[:5]
    
    # Sequential fetch dividend and score data (vnstock not thread-safe)
    div_map = _map_sequential(symbols, get_dividend, timeout_per_item=10)
    score_map = _map_sequential(symbols, get_score, timeout_per_item=10)
    
    for sym in symbols:
        try:
            div = div_map.get(sym)
            if not isinstance(div, list) or len(div) == 0:
                continue
            sc = score_map.get(sym)
            score_val = sc.get("score", 0) if isinstance(sc, dict) else 0
            candidates.append({"symbol": sym, "dividend_count": len(div),
                               "score": score_val,
                               "rating": sc.get("rating") if isinstance(sc, dict) else None})
        except Exception:
            pass
    
    result = sorted(candidates, key=lambda x: (x.get("dividend_count", 0), x.get("score", 0)), reverse=True)
    return {"count": len(result), "stocks": result[:20]}


# ===== DNSE MARKET DATA API =====

TTL_DNSE_SECDEF = 24 * 3600  # 24h - tham chiếu mã ít thay đổi
TTL_DNSE_OHLC = 300  # 5 phút - OHLC cache lâu hơn vì DNSE hay fail
TTL_DNSE_TRADES = 60  # 1 phút - tick data
TTL_DNSE_LATEST_TRADE = 10  # 10 giây - giá khớp mới nhất
TTL_DNSE_INSTRUMENTS = 3600  # 1h - danh sách mã
TTL_DNSE_QUOTE = 20  # 20 giây - giá khớp realtime, tương đương mức đã dùng cho TTL_DNSE_LATEST_TRADE

def _dnse_cache_get(key, ttl):
    """Cache với TTL riêng cho từng loại dữ liệu DNSE."""
    item = _cache.get(key)
    if item and time.time() < item["expires"]:
        return item["data"]
    return None

def _dnse_cache_set(key, data, ttl):
    _cache[key] = {"data": data, "expires": time.time() + ttl}

def _serialize_dnse(obj):
    """Serialize DNSE response (dict/list) an toàn cho JSON."""
    import pandas as pd
    if hasattr(obj, "to_dict"):
        records = obj.to_dict(orient="records")
    elif isinstance(obj, list):
        records = obj
    elif isinstance(obj, dict):
        records = [obj]
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

@app.get("/debug/dnse-connectivity")
def debug_dnse_connectivity():
    """
    Chẩn đoán kết nối DNSE THẬT từ chính server đang chạy (Render) — thay cho việc cần
    Render Shell (gói Free không có tab Shell). Chạy 3 test ĐỘC LẬP, mỗi test tự bắt lỗi
    riêng để 1 bước lỗi không làm hỏng 2 bước còn lại. Đo thời gian thật từng bước.

    KHÔNG cache, luôn chạy live. Endpoint này CHỈ để người dùng tự gọi bằng trình duyệt/curl
    để chẩn đoán — KHÔNG được dùng trong luồng xử lý bot bình thường.

    Ngân sách thời gian tối đa dù mọi thứ đều fail: 5s (TCP) + 5s (HTTPS) + 8s (SDK) = ~18s,
    dưới mức 20s yêu cầu — không bị treo bởi timeout 30s mặc định gốc của SDK.
    """
    result = {
        "region_hint": "Server chạy tại Render (Singapore) - đây là test THẬT từ server, không phải từ máy cá nhân",
        "tcp_connect": {"success": False, "duration_sec": None, "error": None},
        "https_request": {"success": False, "status_code": None, "duration_sec": None, "error": None},
        "dnse_sdk_call": {"success": False, "duration_sec": None, "error": None},
    }

    # ── Test 1: Raw TCP handshake — chỉ dùng socket chuẩn của Python, KHÔNG phụ thuộc SDK DNSE ──
    t0 = time.time()
    try:
        sock = socket.create_connection(("openapi.dnse.com.vn", 443), timeout=5)
        sock.close()
        result["tcp_connect"]["success"] = True
    except socket.gaierror as e:
        result["tcp_connect"]["error"] = f"Lỗi phân giải DNS: {e}"
    except (TimeoutError, socket.timeout) as e:
        result["tcp_connect"]["error"] = f"Timeout kết nối TCP: {e}"
    except ConnectionRefusedError as e:
        result["tcp_connect"]["error"] = f"Bị từ chối kết nối: {e}"
    except Exception as e:
        result["tcp_connect"]["error"] = f"{type(e).__name__}: {e}"
    finally:
        result["tcp_connect"]["duration_sec"] = round(time.time() - t0, 2)

    # ── Test 2: HTTPS request thật. verify=False vì bản thân SDK DNSE cũng tắt xác thực SSL
    # (cert_reqs='CERT_NONE' hard-code trong dnse/api/client.py) — đây là hành vi của SDK,
    # không phải do code bot, chỉ test theo đúng cách SDK thật sự kết nối.
    t0 = time.time()
    try:
        import urllib3 as _urllib3
        _urllib3.disable_warnings(_urllib3.exceptions.InsecureRequestWarning)
        resp = requests.get("https://openapi.dnse.com.vn", timeout=5, verify=False)
        result["https_request"]["success"] = True
        result["https_request"]["status_code"] = resp.status_code
    except requests.exceptions.SSLError as e:
        result["https_request"]["error"] = f"Lỗi SSL: {e}"
    except requests.exceptions.ConnectTimeout as e:
        result["https_request"]["error"] = f"Timeout kết nối HTTPS: {e}"
    except requests.exceptions.ConnectionError as e:
        result["https_request"]["error"] = f"Lỗi kết nối: {e}"
    except Exception as e:
        result["https_request"]["error"] = f"{type(e).__name__}: {e}"
    finally:
        result["https_request"]["duration_sec"] = round(time.time() - t0, 2)

    # ── Test 3: DNSE SDK thật — get_security_definition cho mã cố định VCB.
    # Gọi trực tiếp qua _dnse_executor (KHÔNG qua _dnse_quick_call/circuit breaker) vì đây
    # là 1 lần chẩn đoán độc lập, không muốn bị circuit breaker (nếu đang mở do lỗi trước
    # đó) chặn ngang — nhưng vẫn có timeout cứng để không treo.
    t0 = time.time()
    try:
        client = _get_dnse_client()
        if client is None:
            result["dnse_sdk_call"]["error"] = (
                "Không khởi tạo được DNSE client (thiếu DNSE_API_KEY/SECRET, hoặc đang trong "
                "retry-interval 5 phút sau lần init lỗi trước — xem log server để biết chi tiết)"
            )
        else:
            def _call():
                return client.get_security_definition(symbol="VCB", board_id="G1", dry_run=False)
            future = _dnse_executor.submit(_call)
            try:
                status, body = future.result(timeout=8)  # khớp read timeout đã ép ở Bước 0b
                if status == 200 and body:
                    result["dnse_sdk_call"]["success"] = True
                else:
                    result["dnse_sdk_call"]["error"] = f"status={status}, body={str(body)[:300]}"
            except FutureTimeoutError:
                result["dnse_sdk_call"]["error"] = "Timeout sau 8s (đã ép rút ngắn ở Bước 0b)"
    except Exception as e:
        result["dnse_sdk_call"]["error"] = f"{type(e).__name__}: {e}"
    finally:
        result["dnse_sdk_call"]["duration_sec"] = round(time.time() - t0, 2)

    # ── Kết luận tự động dựa trên bằng chứng — tránh người dùng phải tự đoán ──
    tcp_ok = result["tcp_connect"]["success"]
    https_ok = result["https_request"]["success"]
    sdk_ok = result["dnse_sdk_call"]["success"]
    if not tcp_ok and not https_ok and not sdk_ok:
        result["conclusion"] = (
            "Cả 3 test đều thất bại, kể cả raw TCP (không phụ thuộc code/SDK, chỉ dùng socket "
            "chuẩn) — bằng chứng mạnh cho việc DNSE chặn theo IP/dải mạng của Render (Singapore), "
            "KHÔNG phải lỗi code. Khuyến nghị: liên hệ DNSE hỗ trợ để whitelist IP của Render, "
            "KHÔNG tiếp tục sửa code — sửa code không tự nhiên làm DNSE mở kết nối được."
        )
    elif tcp_ok and not sdk_ok:
        result["conclusion"] = (
            "TCP thông (mạng không bị chặn) nhưng SDK/HTTPS lỗi — nhiều khả năng là vấn đề "
            "xác thực (API key/secret) hoặc lỗi tầng ứng dụng, KHÔNG phải chặn mạng. Kiểm tra "
            "lại DNSE_API_KEY/DNSE_API_SECRET và xem chi tiết lỗi cụ thể ở trên."
        )
    elif sdk_ok:
        result["conclusion"] = "Kết nối DNSE hoạt động bình thường từ server — có thể tiếp tục triển khai Bước 1-4."
    else:
        result["conclusion"] = "Kết quả hỗn hợp — xem chi tiết từng test ở trên để đánh giá."

    return result

@app.get("/dnse/secdef/{symbol}")
def dnse_secdef(symbol: str):
    """Lấy thông tin tham chiếu mã: ceiling, floor, lot size, tick size, board."""
    symbol = symbol.upper()
    key = f"dnse_secdef_{symbol}"
    cached = _dnse_cache_get(key, TTL_DNSE_SECDEF)
    if cached is not None:
        return cached
    client = _get_dnse_client()
    if client is None:
        return _err("DNSE client chưa cấu hình (thiếu DNSE_API_KEY/SECRET)", 503)
    status, body = _dnse_quick_call(
        client.get_security_definition, symbol=symbol, board_id="G1", dry_run=False
    )
    if status == 200 and body:
        result = _serialize_dnse(body)
        _dnse_cache_set(key, result, TTL_DNSE_SECDEF)
        return result
    if status == "circuit_open":
        return _err("DNSE tạm thời không khả dụng (circuit breaker), thử lại sau", 503)
    if cached is not None:
        return cached
    return _err(f"DNSE không khả dụng, không có cache cho {symbol} - check logs", 503)


@app.get("/dnse/ohlc/{symbol}")
def dnse_ohlc(symbol: str, resolution: str = "1", from_ts: Optional[int] = None, to_ts: Optional[int] = None, limit: int = 500):
    """
    Lấy nến OHLC từ DNSE (có fallback vnstock).
    resolution: "1" (1m), "5" (5m), "15" (15m), "60" (1H), "D" (1D)
    from_ts/to_ts: Unix timestamp (mặc định 30 ngày gần nhất)
    limit: số lượng nến tối đa
    """
    symbol = symbol.upper()
    key = f"dnse_ohlc_{symbol}_{resolution}_{from_ts}_{to_ts}_{limit}"
    cached = _dnse_cache_get(key, TTL_DNSE_OHLC)
    if cached is not None:
        return cached
    client = _get_dnse_client()
    if from_ts is None:
        from_ts = int((datetime.now() - timedelta(days=30)).timestamp())
    if to_ts is None:
        to_ts = int(datetime.now().timestamp())
    query = {"symbol": symbol, "resolution": resolution, "from": from_ts, "to": to_ts}
    
    # Thử DNSE trước (timeout nhanh 3s)
    dnse_success = False
    if client is not None:
        status, body = _dnse_quick_call(client.get_ohlc, "STOCK", query, dry_run=False)
        if status == 200 and body:
            result = _serialize_dnse(body)
            _dnse_cache_set(key, result, TTL_DNSE_OHLC)
            dnse_success = True
            return result
    
    if dnse_success:
        return result
    
    # Fallback vnstock - gọi trực tiếp như /stock endpoint
    try:
        interval_map = {"1": "1m", "5": "5m", "15": "15m", "60": "1H", "D": "1D"}
        vn_interval = interval_map.get(resolution, "1D")
        quote = Market().equity(symbol).ohlcv(start=_days_ago(5), end=_today(), interval=vn_interval)
        logger.info(f"vnstock OHLC fallback: symbol={symbol}, interval={vn_interval}, rows={len(quote) if quote is not None else 0}, empty={quote.empty if quote is not None else True}")
        if quote is not None and not quote.empty:
            result = _serialize_dnse(quote.tail(limit))
            _dnse_cache_set(key, result, TTL_DNSE_OHLC)
            return result
    except Exception as e:
        logger.exception(f"Fallback vnstock OHLC exception: {e}")
    
    if cached is not None:
        return cached
    return _err(f"Không có dữ liệu OHLC cho {symbol} (DNSE & vnstock đều fail). Last error logged.", 503)


@app.get("/dnse/latest-trade/{symbol}")
def dnse_latest_trade(symbol: str):
    """Lấy giá khớp lệnh mới nhất (tick realtime) từ DNSE (có fallback vnstock)."""
    symbol = symbol.upper()
    key = f"dnse_latest_trade_{symbol}"
    cached = _dnse_cache_get(key, TTL_DNSE_LATEST_TRADE)
    if cached is not None:
        return cached
    client = _get_dnse_client()
    
    # Thử DNSE trước
    if client is not None:
        status, body = _dnse_quick_call(
            client.get_latest_trade, symbol=symbol, board_id="G1", dry_run=False
        )
        if status == 200 and body:
            result = _serialize_dnse(body)
            _dnse_cache_set(key, result, TTL_DNSE_LATEST_TRADE)
            return result
    
    # Fallback vnstock - lấy giá từ /stock endpoint
    try:
        logger.info(f"vnstock latest-trade fallback: symbol={symbol}, calling _get_vnstock_quote directly")
        quote = _get_vnstock_quote(symbol)
        logger.info(f"vnstock latest-trade fallback: symbol={symbol}, quote={quote}, type={type(quote)}")
        if quote and quote.get("close"):
            result = {"matchPrice": quote["close"] * 1000, "matchQtty": quote.get("volume")}
            result = _serialize_dnse([result])[0]
            _dnse_cache_set(key, result, TTL_DNSE_LATEST_TRADE)
            return result
        else:
            logger.warning(f"Fallback vnstock latest-trade: quote is None or missing close: {quote}")
    except Exception as e:
        logger.exception(f"Fallback vnstock latest-trade exception: {e}")
    
    if cached is not None:
        return cached
    return _err(f"Không có tick mới nhất cho {symbol} (DNSE & vnstock đều fail) - check logs", 503)


@app.get("/dnse/trades/{symbol}")
def dnse_trades(symbol: str, board_id: str = "G1", from_date: Optional[str] = None, to_date: Optional[str] = None, limit: int = 1000, order: str = "DESC"):
    """
    Lấy lịch sử tick (time & sales) từ DNSE (có fallback vnstock OHLC).
    from_date/to_date: format "YYYY-MM-DD" (mặc định hôm nay)
    limit: tối đa 5000
    order: "ASC" hoặc "DESC"
    """
    symbol = symbol.upper()
    key = f"dnse_trades_{symbol}_{board_id}_{from_date}_{to_date}_{limit}_{order}"
    cached = _dnse_cache_get(key, TTL_DNSE_TRADES)
    if cached is not None:
        return cached
    client = _get_dnse_client()
    
    # Thử DNSE trước
    if client is not None:
        if from_date is None:
            from_date = _today()
        if to_date is None:
            to_date = _today()
        status, body = _dnse_quick_call(
            client.get_trades,
            symbol=symbol, board_id=board_id,
            from_date=from_date, to_date=to_date,
            limit=min(limit, 5000), order=order, dry_run=False
        )
        if status == 200 and body:
            result = _serialize_dnse(body)
            _dnse_cache_set(key, result, TTL_DNSE_TRADES)
            return result
    
    # Fallback: không có tick data từ vnstock, trả cache nếu có
    if cached is not None:
        return cached
    return _err(f"Không có tick data cho {symbol} (DNSE unreachable, vnstock không có tick data) - check logs", 503)


@app.get("/dnse/instruments")
def dnse_instruments(
    symbol: Optional[str] = None,
    market_id: Optional[str] = None,
    security_group_id: Optional[str] = None,
    index_name: Optional[str] = None,
    limit: int = 100,
    page: int = 1
):
    """
    Tìm kiếm mã chứng khoán theo filter: symbol, market, group, index (VN30, HNX30...).
    Fallback: vnstock Reference().listing()
    """
    key = f"dnse_instruments_{symbol}_{market_id}_{security_group_id}_{index_name}_{limit}_{page}"
    cached = _dnse_cache_get(key, TTL_DNSE_INSTRUMENTS)
    if cached is not None:
        return cached
    client = _get_dnse_client()
    
    # Thử DNSE trước
    if client is not None:
        params = {"limit": limit, "page": page}
        if symbol:
            params["symbol"] = symbol
        if market_id:
            params["market_id"] = market_id
        if security_group_id:
            params["security_group_id"] = security_group_id
        if index_name:
            params["index_name"] = index_name
        status, body = _dnse_quick_call(client.get_instruments, dry_run=False, **params)
        if status == 200 and body:
            result = _serialize_dnse(body)
            _dnse_cache_set(key, result, TTL_DNSE_INSTRUMENTS)
            return result
    
    # Fallback vnstock Reference().listing()
    try:
        listing = Reference().listing()
        logger.info(f"vnstock listing fallback: rows={len(listing) if listing is not None else 0}")
        if listing is not None and not listing.empty:
            result = _serialize_dnse(listing)
            _dnse_cache_set(key, result, TTL_DNSE_INSTRUMENTS)
            return result
    except Exception as e:
        logger.exception(f"Fallback vnstock listing exception: {e}")
    
    if cached is not None:
        return cached
    return _err("Không tìm thấy mã phù hợp (DNSE & vnstock đều fail) - check logs", 503)