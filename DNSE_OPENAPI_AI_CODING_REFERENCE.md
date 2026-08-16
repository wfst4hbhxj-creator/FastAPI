# DNSE OpenAPI --- AI Coding Reference

## Tài liệu tổng hợp dành cho AI/Developer tích hợp DNSE LightSpeed OpenAPI

> **Mục tiêu:** Đây là một file Markdown trung tâm để đưa cho ChatGPT,
> Claude, Cursor, Antigravity hoặc AI coding agent khi xây dựng ứng dụng
> tích hợp DNSE OpenAPI.
>
> **Nguyên tắc quan trọng:** Không được tự suy đoán endpoint, field,
> enum, request body, response schema hoặc authentication flow nếu chưa
> có bằng chứng từ tài liệu DNSE hiện hành. Khi thiếu contract, phải
> đánh dấu `UNKNOWN / NEED VERIFY` thay vì tự tạo.

**Nguồn chính thức cần đối chiếu khi tài liệu thay đổi:** - DNSE
OpenAPI: https://developers.dnse.com.vn/ - DNSE API Platform:
https://developers.dnse.com.vn/docs/guide/intro/api_platform/ - Account:
https://developers.dnse.com.vn/docs/dnse/account - Market Data:
https://developers.dnse.com.vn/docs/dnse/market-data/

**Ngày biên soạn:** 2026-08-10\
**Nguồn:** DNSE OpenAPI chính thức\
**Trạng thái:** AI-oriented consolidated reference; các contract cụ thể
phải ưu tiên tài liệu/API schema hiện hành của DNSE.

------------------------------------------------------------------------

# 1. ROLE CỦA FILE NÀY

AI phải coi file này là **nguồn quy tắc tích hợp DNSE**, không phải một
tài liệu để tự suy đoán.

Khi viết code:

1.  Ưu tiên contract DNSE hơn mọi convention tự nghĩ ra.
2.  Không đổi tên field của DNSE trong tầng API client.
3.  Không tự đổi kiểu dữ liệu nếu chưa có lý do rõ ràng.
4.  Không hard-code API Key/API Secret vào source code.
5.  Không log secret, token, OTP hoặc thông tin xác thực nhạy cảm.
6.  Không giả định endpoint tồn tại chỉ vì tên endpoint "có vẻ hợp lý".
7.  Không tạo mock response rồi coi đó là response thật.
8.  Nếu contract chưa xác minh, ghi `NEED VERIFY`.
9.  Tách DNSE client khỏi business logic.
10. Khi DNSE thay đổi contract, cập nhật adapter thay vì làm hỏng toàn
    bộ ứng dụng.

------------------------------------------------------------------------

# 2. TỔNG QUAN DNSE OPENAPI

DNSE cung cấp OpenAPI theo hướng RESTful và có các nhóm dịch vụ chính:

-   Trading API
-   Market Data API
-   Broker API

Trading API hỗ trợ các hoạt động liên quan tới tài khoản, tài sản và
giao dịch. Market Data API cung cấp dữ liệu thị trường realtime và dữ
liệu lịch sử. Broker API phục vụ nhu cầu chuyên biệt cho môi giới/SACO.

DNSE mô tả OpenAPI là nền tảng để lập trình các hành trình từ theo dõi
thị trường, phân tích, quản lý tài sản tới đặt lệnh.

------------------------------------------------------------------------

# 3. KIẾN TRÚC TÍCH HỢP KHUYẾN NGHỊ

``` text
                    +----------------------+
                    |      Client/App      |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |     FastAPI API      |
                    |  Business / Routing  |
                    +----------+-----------+
                               |
             +-----------------+-----------------+
             |                                   |
             v                                   v
    +-------------------+              +-------------------+
    | DNSE REST Client  |              | DNSE WS Client    |
    | Auth / Account    |              | Realtime Data     |
    | Orders / Market   |              | Events / Updates  |
    +---------+---------+              +---------+---------+
              |                                  |
              +----------------+-----------------+
                               |
                               v
                    +----------------------+
                    |      DNSE API       |
                    +----------------------+
```

Khuyến nghị project:

``` text
app/
├── main.py
├── config.py
├── routers/
│   ├── account.py
│   ├── market.py
│   ├── trading.py
│   └── health.py
├── services/
│   ├── account_service.py
│   ├── market_service.py
│   └── trading_service.py
├── clients/
│   ├── dnse_rest.py
│   ├── dnse_auth.py
│   └── dnse_ws.py
├── schemas/
│   ├── account.py
│   ├── market.py
│   ├── trading.py
│   └── common.py
└── utils/
    ├── signing.py
    └── logging.py
```

------------------------------------------------------------------------

# 4. AUTHENTICATION & SECURITY

## 4.1 API Key

DNSE cung cấp API Key khi đăng ký sử dụng OpenAPI.

API Key:

-   là khóa định danh kết nối;
-   phải được bảo mật;
-   có thể được tạo mới hoặc thu hồi;
-   khi tạo mới/hủy key, key cũ có thể bị vô hiệu hóa theo cơ chế của
    DNSE.

Không được:

``` python
API_KEY = "abc123"
```

trong source code.

Phải dùng environment variable:

``` env
DNSE_API_KEY=...
DNSE_API_SECRET=...
```

và:

``` python
import os

DNSE_API_KEY = os.getenv("DNSE_API_KEY")
DNSE_API_SECRET = os.getenv("DNSE_API_SECRET")
```

------------------------------------------------------------------------

# 5. API SECRET

API Secret là secret dùng cho xác thực/chữ ký của các REST API theo cơ
chế DNSE yêu cầu.

DNSE lưu ý API Secret chỉ hiển thị một lần khi đăng ký thành công.

Quy tắc:

-   Không commit vào Git.
-   Không gửi vào Telegram.
-   Không trả về frontend.
-   Không ghi vào log.
-   Không đưa vào exception message.
-   Không đưa vào prompt AI.
-   Không đưa vào file `.md` này.

Ví dụ `.gitignore`:

``` gitignore
.env
.env.*
*.secret
secrets/
```

------------------------------------------------------------------------

# 6. 2FA / OTP

DNSE áp dụng lớp xác thực thứ hai cho giao dịch đặt lệnh.

Các phương thức được DNSE mô tả:

-   Smart OTP
-   Email OTP

Tại một thời điểm, hệ thống chỉ chấp nhận phương thức 2FA đang được kích
hoạt.

## QUY TẮC CHO AI

Không được tự thiết kế OTP flow khác với DNSE.

Nếu cần implement:

``` text
Place Order
    |
    +--> Authentication
    |
    +--> 2FA/OTP requirement
    |
    +--> DNSE validation
    |
    +--> Order result
```

Nếu tài liệu endpoint OTP cụ thể chưa được cung cấp trong context:

``` text
OTP_ENDPOINT = NEED VERIFY
OTP_REQUEST = NEED VERIFY
OTP_RESPONSE = NEED VERIFY
```

Không tự đoán.

------------------------------------------------------------------------

# 7. ACCOUNT API

Trang Account của DNSE là nhóm API phục vụ thông tin tài khoản/giao
dịch.

Các nhóm chức năng cần được giữ nguyên theo tài liệu DNSE hiện hành, gồm
các loại thông tin như:

-   tài khoản giao dịch;
-   thông tin tiền;
-   sức mua/sức bán;
-   sổ lệnh;
-   trạng thái lệnh;
-   lịch sử lệnh;
-   vị thế;
-   thông tin liên quan tới tài sản/giao dịch.

## 7.1 Account

Mục tiêu:

``` text
Lấy thông tin tài khoản giao dịch
```

Contract cụ thể:

``` text
METHOD: NEED VERIFY
PATH: NEED VERIFY
QUERY: NEED VERIFY
HEADERS: NEED VERIFY
RESPONSE: NEED VERIFY
```

AI không được tự tạo endpoint.

------------------------------------------------------------------------

# 8. MONEY / CASH INFORMATION

Mục tiêu:

``` text
Lấy thông tin tiền/tài sản tiền của tài khoản.
```

Thông tin thường có thể bao gồm các thành phần như:

-   tiền mặt;
-   tiền khả dụng;
-   tiền chờ xử lý;
-   tiền có thể giao dịch;
-   các giá trị tài chính liên quan.

**Không tự suy luận field name.**

Ví dụ không được tự viết:

``` json
{
  "cash": 10000000,
  "available_cash": 9000000
}
```

nếu contract DNSE chưa xác nhận chính xác các field trên.

------------------------------------------------------------------------

# 9. BUYING POWER / SELLING POWER

Mục tiêu:

``` text
Xác định khả năng mua/bán của tài khoản.
```

Các khái niệm cần phân biệt:

-   tiền mặt;
-   sức mua;
-   sức bán;
-   tài sản;
-   margin/loan nếu tài khoản có sử dụng;
-   giá trị lệnh đang chờ.

**Lưu ý:** Không được tự biến "sức mua" thành "tiền mặt".

------------------------------------------------------------------------

# 10. ORDER BOOK

Order Book/Sổ lệnh dùng để truy vấn các lệnh của tài khoản.

AI phải phân biệt:

``` text
Order
├── order ID
├── symbol
├── side
├── price
├── quantity
├── status
├── created time
└── execution information
```

Đây chỉ là mô hình khái niệm.

Tên field chính thức phải lấy từ DNSE contract.

------------------------------------------------------------------------

# 11. ORDER STATUS

Trạng thái lệnh phải được lấy từ enum chính thức của DNSE.

Không tự tạo enum kiểu:

``` python
class OrderStatus(str, Enum):
    PENDING = "pending"
    FILLED = "filled"
    CANCELLED = "cancelled"
```

trừ khi tài liệu DNSE xác nhận chính xác giá trị.

Nếu cần mapping:

``` text
DNSE status -> Internal status
```

hãy tạo adapter riêng:

``` python
DNSE_TO_INTERNAL_STATUS = {
    # exact DNSE values only
}
```

------------------------------------------------------------------------

# 12. ORDER HISTORY

Mục tiêu:

``` text
Truy vấn lịch sử lệnh theo tài khoản/thời gian/điều kiện mà DNSE hỗ trợ.
```

Cần xác minh:

-   pagination;
-   page size;
-   time range;
-   order status;
-   symbol;
-   sort order;
-   timestamp format.

Không tự giả định pagination là:

``` text
page
page_size
```

nếu DNSE contract sử dụng tên khác.

------------------------------------------------------------------------

# 13. POSITIONS

Position/Vị thế phải được tách khỏi Order.

``` text
Order = giao dịch/lệnh
Position = trạng thái nắm giữ/vị thế
```

Đối với cổ phiếu, hệ thống ứng dụng có thể cần:

``` text
symbol
quantity
available quantity
average price
market price
market value
profit/loss
```

Nhưng đây là **business model nội bộ**, không phải cam kết rằng DNSE trả
đúng các field này.

------------------------------------------------------------------------

# 14. MARKET DATA API

DNSE Market Data hiện liệt kê các nhóm dữ liệu chính:

1.  Thông tin giao dịch chứng khoán
2.  Giá đóng cửa
3.  Chi tiết mã chứng khoán
4.  Lịch sử OHLC
5.  Lịch sử khớp lệnh
6.  Dữ liệu khớp gần nhất
7.  Lịch sử bid/ask
8.  Dữ liệu bid/ask gần nhất
9.  Ngày làm việc
10. Dữ liệu nhà đầu tư nước ngoài
11. Phiên giao dịch

------------------------------------------------------------------------

# 15. SECURITY / TRADING INFORMATION

Mục tiêu:

``` text
Lấy trạng thái giao dịch và thông tin giá của mã chứng khoán.
```

Có thể liên quan tới:

-   giá trần;
-   giá sàn;
-   giá tham chiếu;
-   trạng thái mã;
-   thông tin phiên giao dịch.

Contract cụ thể:

``` text
METHOD: NEED VERIFY
PATH: NEED VERIFY
PARAMETERS: NEED VERIFY
RESPONSE SCHEMA: NEED VERIFY
```

------------------------------------------------------------------------

# 16. CLOSE PRICE

Mục tiêu:

``` text
Truy vấn giá đóng cửa của mã chứng khoán.
```

Cần xác minh:

-   symbol format;
-   exchange/board;
-   trading date;
-   response timestamp/date;
-   adjusted/unadjusted nếu có.

Không tự thêm `adjusted=true` nếu DNSE không hỗ trợ.

------------------------------------------------------------------------

# 17. SECURITY DETAIL

Mục tiêu:

``` text
Truy vấn danh sách/thông tin cơ bản của mã chứng khoán theo điều kiện lọc.
```

Có thể dùng cho:

``` text
symbol discovery
market scanner
stock metadata
exchange classification
```

Không tự suy đoán danh sách field.

------------------------------------------------------------------------

# 18. OHLC HISTORY

DNSE cung cấp lịch sử nến OHLC cho:

-   cổ phiếu;
-   phái sinh;
-   chỉ số thị trường.

Các thành phần khái niệm:

``` text
Open
High
Low
Close
Volume
```

Cần xác minh chính thức:

-   timeframe enum;
-   start/end;
-   timezone;
-   symbol;
-   board;
-   pagination/limit;
-   response schema.

------------------------------------------------------------------------

# 19. TRADE HISTORY

Lịch sử khớp lệnh dùng để lấy các giao dịch khớp theo mã và khoảng thời
gian.

Ứng dụng có thể dùng để:

``` text
price analysis
volume analysis
intraday analysis
market activity
```

Contract cụ thể phải lấy trực tiếp từ DNSE.

------------------------------------------------------------------------

# 20. LAST TRADE

Dữ liệu khớp gần nhất phục vụ:

``` text
latest price
latest trade
latest volume
intraday monitoring
```

Đây là nhóm API quan trọng nếu xây dựng bot cần giá hiện tại.

## QUY TẮC

Nếu người dùng yêu cầu:

``` text
"giá hiện tại"
```

phải ưu tiên endpoint dữ liệu realtime/last trade phù hợp của DNSE.

Không dùng giá lịch sử thay thế cho giá hiện tại.

------------------------------------------------------------------------

# 21. BID / ASK

DNSE cung cấp:

-   lịch sử bid/ask;
-   bid/ask gần nhất.

Có thể dùng cho:

``` text
market depth
spread
order book analysis
liquidity
entry analysis
```

Không tự tạo cấu trúc:

``` json
{
  "bid": [],
  "ask": []
}
```

nếu chưa xác minh schema.

------------------------------------------------------------------------

# 22. WORKING DAYS / TRADING CALENDAR

DNSE cung cấp danh sách ngày làm việc/giao dịch trong khoảng thời gian
được hệ thống hỗ trợ.

Ứng dụng có thể dùng để:

``` text
validate trading date
schedule market jobs
calculate trading sessions
avoid weekends/holidays
```

Không dùng:

``` python
datetime.weekday() < 5
```

làm nguồn duy nhất để xác định ngày giao dịch Việt Nam.

------------------------------------------------------------------------

# 23. FOREIGN INVESTOR DATA

DNSE có dữ liệu nhà đầu tư nước ngoài.

Có thể phục vụ:

``` text
foreign buy/sell analysis
foreign room analysis
market flow analysis
```

Field chính thức phải lấy từ DNSE.

------------------------------------------------------------------------

# 24. TRADING SESSION

Dữ liệu phiên giao dịch dùng để xác định trạng thái phiên hiện tại.

Ứng dụng có thể dùng để:

``` text
is_market_open
session_state
pre_open
continuous session
close
```

Nhưng enum chính thức phải lấy từ DNSE.

------------------------------------------------------------------------

# 25. REALTIME ARCHITECTURE

DNSE mô tả khả năng cập nhật realtime cho dữ liệu tài sản, trạng thái
tài khoản và sổ lệnh; Market Data cũng cung cấp dữ liệu realtime.

Kiến trúc ứng dụng nên tách:

``` text
REST
├── request/response
├── historical query
├── account query
└── order operations

WebSocket / realtime
├── market events
├── account events
├── order events
└── asset events
```

Không polling quá mức nếu realtime channel phù hợp đã tồn tại.

------------------------------------------------------------------------

# 26. WEBSOCKET

Nếu sử dụng WebSocket:

``` text
CONNECT
  |
AUTHENTICATE
  |
SUBSCRIBE
  |
RECEIVE EVENTS
  |
VALIDATE EVENT
  |
UPDATE STATE
```

Cần xác minh trực tiếp từ tài liệu DNSE:

``` text
WS URL = NEED VERIFY
AUTH MESSAGE = NEED VERIFY
SUBSCRIBE MESSAGE = NEED VERIFY
UNSUBSCRIBE MESSAGE = NEED VERIFY
EVENT TYPES = NEED VERIFY
PING/PONG = NEED VERIFY
RECONNECT RULE = NEED VERIFY
```

Không tự bịa WebSocket protocol.

------------------------------------------------------------------------

# 27. REST CLIENT DESIGN

FastAPI project nên có một DNSE client duy nhất chịu trách nhiệm giao
tiếp HTTP.

Ví dụ:

``` python
class DNSEClient:
    async def get(self, path, params=None):
        ...

    async def post(self, path, json=None):
        ...

    async def put(self, path, json=None):
        ...

    async def delete(self, path, params=None):
        ...
```

Không để router gọi `httpx` trực tiếp:

``` python
# KHÔNG KHUYẾN NGHỊ
@router.get("/account")
async def account():
    return await httpx.get(...)
```

Nên:

``` python
@router.get("/account")
async def account():
    return await account_service.get_account()
```

và service:

``` python
class AccountService:
    def __init__(self, dnse: DNSEClient):
        self.dnse = dnse
```

------------------------------------------------------------------------

# 28. CONFIGURATION

Dùng environment variables:

``` env
DNSE_API_KEY=
DNSE_API_SECRET=
DNSE_BASE_URL=
DNSE_TIMEOUT=
DNSE_ENV=
```

Nếu DNSE cung cấp nhiều môi trường:

``` text
sandbox
production
```

thì phải lấy URL chính thức từ DNSE.

Không tự đặt production URL.

------------------------------------------------------------------------

# 29. TIMEOUT / RETRY

HTTP client phải có:

``` text
connect timeout
read timeout
write timeout
pool timeout
```

Retry chỉ áp dụng có kiểm soát.

Không retry mù đối với:

``` text
POST order
POST cancel order
```

vì retry một operation giao dịch có thể gây duplicate action nếu server
đã nhận request nhưng client mất response.

Đối với operation có side effect:

``` text
idempotency
request ID
client order ID
```

phải tuân theo cơ chế DNSE nếu có.

------------------------------------------------------------------------

# 30. ERROR HANDLING

Tách:

``` text
HTTP error
DNSE business error
validation error
authentication error
network error
timeout
rate limit
unknown error
```

Không biến mọi lỗi thành:

``` http
500 Internal Server Error
```

Ví dụ kiến trúc:

``` python
class DNSEError(Exception):
    pass

class DNSEAuthError(DNSEError):
    pass

class DNSEValidationError(DNSEError):
    pass

class DNSERateLimitError(DNSEError):
    pass
```

Tên class nội bộ có thể thay đổi, nhưng mapping phải dựa trên contract
thực tế.

------------------------------------------------------------------------

# 31. JSON CONTRACT RULE

Đây là nguyên tắc quan trọng nhất khi AI code.

Nếu DNSE trả:

``` json
{
  "someField": "value"
}
```

thì tầng raw client phải giữ nguyên:

``` python
data["someField"]
```

Không tự đổi thành:

``` python
data["some_field"]
```

trừ khi có lớp mapping rõ ràng:

``` text
DNSE DTO
   ↓
Internal DTO
```

------------------------------------------------------------------------

# 32. PYDANTIC

Có thể dùng Pydantic để validate response.

Nhưng:

``` python
class Account(BaseModel):
    ...
```

chỉ được khai báo field khi contract đã xác minh.

Nếu chưa chắc:

``` text
DO NOT INVENT FIELD
```

Không dùng:

``` python
extra="ignore"
```

một cách vô thức nếu mục tiêu là phát hiện DNSE đã thay đổi schema.

Khuyến nghị trong lớp raw DTO:

``` python
extra="allow"
```

hoặc chiến lược tương thích phù hợp.

Trong lớp business model có thể strict hơn.

------------------------------------------------------------------------

# 33. DNSE DTO VS INTERNAL DTO

Khuyến nghị:

``` text
DNSE API
   ↓
DNSE DTO
   ↓
Mapper
   ↓
Internal Model
   ↓
Business Logic
   ↓
FastAPI Response
```

Ví dụ:

``` python
class DNSEQuote(BaseModel):
    # exact DNSE fields
    pass


class InternalQuote(BaseModel):
    symbol: str
    price: float
    volume: int
```

Điều này giúp DNSE thay đổi API mà không làm toàn bộ business layer phụ
thuộc trực tiếp.

------------------------------------------------------------------------

# 34. CURRENT PRICE REQUIREMENT

Đối với ứng dụng phân tích cổ phiếu:

``` text
CURRENT PRICE != CLOSE PRICE
CURRENT PRICE != HISTORICAL OHLC
```

Khi người dùng yêu cầu giá hiện tại:

1.  Kiểm tra market status.
2.  Lấy dữ liệu realtime/last trade phù hợp.
3.  Ghi nhận timestamp.
4.  Nếu market đóng, phải nói rõ đây là giá gần nhất/giá cuối phiên nếu
    API trả như vậy.
5.  Không gọi giá lịch sử rồi gắn nhãn "current".

------------------------------------------------------------------------

# 35. STOCK SCANNER

Nếu xây dựng scanner:

``` text
Universe
   ↓
Security metadata
   ↓
Current price
   ↓
OHLC history
   ↓
Volume
   ↓
Fundamental source (nếu có)
   ↓
Strategy
   ↓
Score
   ↓
Recommendation
```

DNSE Market Data không mặc nhiên có toàn bộ dữ liệu fundamental mà một
stock scanner có thể cần.

Nếu thiếu:

``` text
Revenue
Profit
EPS
Dividend
ROE
Debt
```

phải lấy từ nguồn fundamental phù hợp khác.

Không giả định DNSE Market Data cung cấp tất cả các dữ liệu trên.

------------------------------------------------------------------------

# 36. SEPARATE MARKET DATA FROM ACCOUNT DATA

Không trộn:

``` text
Market Data
```

với:

``` text
Private Account Data
```

Market Data:

``` text
symbol
price
OHLC
volume
bid/ask
indices
foreign data
```

Account:

``` text
cash
buying power
orders
positions
portfolio
```

Trading:

``` text
place order
modify/cancel
order status
execution
```

------------------------------------------------------------------------

# 37. ORDER FLOW

Kiến trúc khuyến nghị:

``` text
User
 ↓
FastAPI
 ↓
Validation
 ↓
Business Rules
 ↓
DNSE Auth
 ↓
OTP / 2FA nếu required
 ↓
DNSE Order API
 ↓
DNSE Response
 ↓
Normalize
 ↓
Audit Log
 ↓
User
```

Không được:

``` text
User -> raw DNSE endpoint
```

trừ khi đang xây dựng một thin proxy có chủ đích.

------------------------------------------------------------------------

# 38. ORDER SAFETY

Đặt lệnh là operation có side effect.

Trước khi gửi:

``` text
validate symbol
validate side
validate quantity
validate price
validate trading session
validate account
validate available funds/shares
validate order type
validate business rules
```

Sau khi gửi:

``` text
store request metadata
store response metadata
track order ID
poll/subscribe order status
```

Không coi:

``` text
HTTP 200
```

đồng nghĩa chắc chắn với:

``` text
order filled
```

Phải phân biệt:

``` text
request accepted
order accepted
order pending
partial fill
filled
cancelled
rejected
```

theo enum thực tế của DNSE.

------------------------------------------------------------------------

# 39. AUDIT LOG

Không log secret.

Nên log:

``` text
timestamp
request ID
operation
symbol
side
quantity
price
DNSE order ID
HTTP status
business status
latency
```

Không log:

``` text
API Secret
OTP
Authorization token
full sensitive account credentials
```

------------------------------------------------------------------------

# 40. RATE LIMIT

Nếu DNSE công bố rate limit:

``` text
requests/minute
requests/second
WebSocket connection limits
subscription limits
```

thì code phải tuân theo giá trị chính thức.

Nếu chưa xác minh:

``` text
RATE_LIMIT = NEED VERIFY
```

Không tự ghi:

``` text
100 requests/minute
```

và coi đó là DNSE contract.

------------------------------------------------------------------------

# 41. PAGINATION

Không giả định tất cả API sử dụng cùng một kiểu pagination.

Có thể gặp các kiểu:

``` text
page/pageSize
limit/offset
cursor
from/to
```

Phải đọc contract từng endpoint.

------------------------------------------------------------------------

# 42. TIMESTAMP

Không tự giả định:

``` text
UTC
UTC+7
Unix seconds
Unix milliseconds
ISO 8601
```

Phải xác minh từng API.

Trong ứng dụng nội bộ, nên normalize về:

``` text
UTC internally
```

và convert sang:

``` text
Asia/Ho_Chi_Minh
```

ở presentation layer nếu cần.

------------------------------------------------------------------------

# 43. DATA TYPES

Đặc biệt cẩn thận với:

``` text
price
quantity
money
percentage
timestamp
ID
```

Không tự convert mọi số thành float.

Tiền và giá có thể cần:

``` python
Decimal
```

thay vì:

``` python
float
```

nếu yêu cầu độ chính xác cao.

------------------------------------------------------------------------

# 44. DO NOT GUESS ENUMS

Các field như:

``` text
side
order type
order status
board
exchange
timeframe
session
asset type
```

phải lấy enum từ DNSE.

Nếu tài liệu nói:

``` text
BUY / SELL
```

thì không tự đổi thành:

``` text
B / S
```

trừ khi API contract yêu cầu.

------------------------------------------------------------------------

# 45. WEBHOOK / CALLBACK

Không giả định DNSE có webhook nếu tài liệu không xác nhận.

Nếu cần realtime:

``` text
REST polling
```

hoặc:

``` text
WebSocket
```

phải dựa trên khả năng thực tế của DNSE.

------------------------------------------------------------------------

# 46. TESTING

Mỗi endpoint nên có:

``` text
happy path
invalid parameter
authentication failure
permission failure
empty result
rate limit
timeout
server error
schema change
```

Ví dụ:

``` text
tests/
├── test_auth.py
├── test_account.py
├── test_market_data.py
├── test_orders.py
├── test_positions.py
└── test_error_mapping.py
```

------------------------------------------------------------------------

# 47. CONTRACT TESTING

Nên có test kiểm tra:

``` text
HTTP method
path
required headers
request body
response status
response JSON
required fields
enum
```

Nếu DNSE cung cấp OpenAPI specification chính thức, ưu tiên sinh
contract tests từ specification.

------------------------------------------------------------------------

# 48. MOCKING

Không mock theo suy đoán.

Mock phải được xây từ:

``` text
official DNSE example
official response
captured sanitized response
OpenAPI schema
```

Ví dụ:

``` text
tests/fixtures/dnse/
├── account.json
├── money.json
├── orders.json
├── positions.json
├── quote.json
└── ohlc.json
```

------------------------------------------------------------------------

# 49. FASTAPI RESPONSE DESIGN

Không nhất thiết expose raw DNSE response trực tiếp.

Có thể:

``` text
GET /api/v1/stocks/{symbol}/quote
```

trả internal schema:

``` json
{
  "symbol": "ABC",
  "price": 22.35,
  "timestamp": "...",
  "source": "DNSE"
}
```

Nhưng phải giữ mapping rõ ràng.

Nếu dự án yêu cầu **exact DNSE passthrough**, không được normalize.

------------------------------------------------------------------------

# 50. API VERSIONING

FastAPI:

``` text
/api/v1/...
```

Khi DNSE thay đổi:

``` text
DNSE API
   ↓
DNSE adapter v2
   ↓
same internal service
```

Tránh để mọi router phụ thuộc trực tiếp vào contract DNSE.

------------------------------------------------------------------------

# 51. OBSERVABILITY

Nên theo dõi:

``` text
DNSE request count
DNSE latency
DNSE error rate
HTTP status distribution
authentication errors
rate-limit events
WebSocket reconnects
order failures
schema validation failures
```

Không thu thập secret.

------------------------------------------------------------------------

# 52. DEPLOYMENT

Với Render/Railway/VPS:

``` text
Environment Variables
        ↓
FastAPI
        ↓
DNSE Client
        ↓
DNSE
```

Không commit:

``` text
.env
API Secret
tokens
private certificates
```

Health endpoint:

``` http
GET /health
```

nên kiểm tra ứng dụng, không nhất thiết gọi DNSE mỗi lần nếu không cần.

Có thể thêm:

``` http
GET /health/dnse
```

để kiểm tra dependency riêng.

------------------------------------------------------------------------

# 53. AI CODING RULES

Khi được yêu cầu viết code DNSE, AI phải làm theo thứ tự:

## Step 1 --- Identify endpoint

``` text
What exact DNSE operation?
```

## Step 2 --- Verify contract

``` text
METHOD
PATH
AUTH
PARAMS
BODY
RESPONSE
ERROR
```

## Step 3 --- Create DTO

``` text
DNSE request/response model
```

## Step 4 --- Create client

``` text
DNSEClient
```

## Step 5 --- Create service

``` text
Business logic
```

## Step 6 --- Create FastAPI router

``` text
HTTP interface
```

## Step 7 --- Add tests

``` text
contract tests
unit tests
error tests
```

------------------------------------------------------------------------

# 54. AI MUST NOT DO THESE THINGS

### Không được tự bịa endpoint

``` text
GET /api/account
```

chỉ vì nghe hợp lý.

### Không được tự bịa field

``` text
availableCash
buyingPower
```

### Không được tự bịa enum

``` text
MARKET
LIMIT
STOP
```

### Không được tự bịa base URL

### Không được tự bịa authentication header

### Không được tự bịa WebSocket message

### Không được tự bịa response

### Không được tự coi HTTP 200 là order filled

### Không được dùng giá đóng cửa thay giá realtime

### Không được log secret

------------------------------------------------------------------------

# 55. CONTRACT CONFIDENCE LEVEL

Mỗi thông tin kỹ thuật trong code/document nên được đánh dấu:

``` text
VERIFIED
```

nếu lấy trực tiếp từ tài liệu DNSE.

``` text
INFERRED
```

nếu chỉ là suy luận kỹ thuật.

``` text
INTERNAL
```

nếu là thiết kế của ứng dụng.

``` text
NEED VERIFY
```

nếu chưa đủ dữ liệu.

Ví dụ:

``` text
DNSE_API_KEY authentication: VERIFIED

Internal AccountService: INTERNAL

OrderStatus enum: NEED VERIFY

HTTP retry strategy: INTERNAL
```

------------------------------------------------------------------------

# 56. SOURCE OF TRUTH HIERARCHY

Khi có mâu thuẫn:

``` text
1. Official DNSE OpenAPI specification
2. Official DNSE developer documentation
3. Official DNSE API examples
4. Official DNSE support/developer clarification
5. Existing verified implementation
6. Community code
7. AI inference
```

AI phải ưu tiên nguồn ở trên.

**AI inference luôn là mức thấp nhất.**

------------------------------------------------------------------------

# 57. CURRENT OFFICIAL DOCUMENTATION MAP

## Root

``` text
https://developers.dnse.com.vn/
```

## API Platform

``` text
https://developers.dnse.com.vn/docs/guide/intro/api_platform/
```

## Account

``` text
https://developers.dnse.com.vn/docs/dnse/account
```

## Market Data

``` text
https://developers.dnse.com.vn/docs/dnse/market-data/
```

------------------------------------------------------------------------

# 58. DOCUMENTATION COVERAGE

Những nhóm đã xác nhận tồn tại trong tài liệu DNSE:

``` text
[VERIFIED]
Trading API
Market Data API
Broker API
API Key
API Secret
2FA
Smart OTP
Email OTP
Account documentation
Market Data documentation
Realtime capability
RESTful API
```

Market Data đã xác nhận các nhóm:

``` text
[VERIFIED]
Trading information
Close price
Security detail
OHLC history
Trade history
Last trade
Historical bid/ask
Latest bid/ask
Working days
Foreign investor data
Trading session
```

Các contract chi tiết như:

``` text
exact HTTP method
exact endpoint path
exact request JSON
exact response JSON
exact enum
exact WebSocket message
exact rate limits
exact pagination
```

phải được lấy từ trang endpoint/specification tương ứng trước khi code.

------------------------------------------------------------------------

# 59. OPENAPI SPECIFICATION PRIORITY

Nếu tìm được file:

``` text
openapi.json
openapi.yaml
swagger.json
swagger.yaml
```

thì đây phải trở thành nguồn contract ưu tiên.

AI nên đọc specification để lấy:

``` text
paths
operations
parameters
requestBody
responses
schemas
securitySchemes
enums
```

Sau đó mới viết Pydantic/FastAPI.

------------------------------------------------------------------------

# 60. RECOMMENDED GENERATION PIPELINE

Nếu có OpenAPI:

``` text
DNSE OpenAPI
      |
      v
openapi.yaml/json
      |
      v
Contract validation
      |
      +----> Pydantic models
      |
      +----> API client
      |
      +----> FastAPI schemas
      |
      +----> Tests
```

Nếu chưa có OpenAPI file:

``` text
DNSE Documentation
      |
      v
Endpoint extraction
      |
      v
Manual contract verification
      |
      v
Internal OpenAPI specification
      |
      v
Code generation
```

------------------------------------------------------------------------

# 61. DNSE INTEGRATION CHECKLIST

## Authentication

-   [ ] API Key verified
-   [ ] API Secret verified
-   [ ] Signature algorithm verified
-   [ ] Authorization header verified
-   [ ] Token lifecycle verified
-   [ ] OTP mechanism verified
-   [ ] Smart OTP verified
-   [ ] Email OTP verified

## Account

-   [ ] Account endpoint verified
-   [ ] Money endpoint verified
-   [ ] Buying power verified
-   [ ] Selling power verified
-   [ ] Orders endpoint verified
-   [ ] Order history verified
-   [ ] Order status verified
-   [ ] Positions verified

## Market Data

-   [ ] Trading information
-   [ ] Close price
-   [ ] Security detail
-   [ ] OHLC
-   [ ] Trade history
-   [ ] Last trade
-   [ ] Historical bid/ask
-   [ ] Latest bid/ask
-   [ ] Working days
-   [ ] Foreign investor
-   [ ] Trading session

## Trading

-   [ ] Place order
-   [ ] Cancel order
-   [ ] Modify order if supported
-   [ ] Order status
-   [ ] Execution/fill
-   [ ] OTP
-   [ ] Error handling

## Realtime

-   [ ] WebSocket URL
-   [ ] Authentication
-   [ ] Subscribe
-   [ ] Unsubscribe
-   [ ] Event schema
-   [ ] Reconnect
-   [ ] Heartbeat
-   [ ] Subscription limits

------------------------------------------------------------------------

# 62. FINAL RULE FOR AI

Khi user yêu cầu:

> "Viết API DNSE cho tôi"

AI phải **không được bắt đầu bằng việc đoán code**.

Phải xác định:

``` text
1. User cần API nào?
2. Endpoint chính thức là gì?
3. Authentication thế nào?
4. Request schema là gì?
5. Response schema là gì?
6. Error schema là gì?
7. Có realtime/WebSocket không?
8. Có pagination không?
9. Có rate limit không?
10. Contract đã được verify chưa?
```

Nếu tất cả đã xác minh:

``` text
IMPLEMENT
```

Nếu chưa:

``` text
DO NOT INVENT
```

và đánh dấu:

``` text
NEED VERIFY
```

------------------------------------------------------------------------

# 63. DÀNH RIÊNG CHO DỰ ÁN FASTAPI

Mục tiêu kiến trúc:

``` text
DNSE
 ↓
clients/dnse_*
 ↓
services/*
 ↓
routers/*
 ↓
FastAPI
```

Không:

``` text
Router
 ↓
DNSE raw HTTP
```

Khuyến nghị:

``` text
app/
├── main.py
├── config.py
├── clients/
│   ├── dnse_client.py
│   ├── dnse_auth.py
│   └── dnse_ws.py
├── schemas/
│   ├── dnse_account.py
│   ├── dnse_market.py
│   └── dnse_trading.py
├── services/
│   ├── account_service.py
│   ├── market_service.py
│   └── trading_service.py
├── routers/
│   ├── account.py
│   ├── market.py
│   └── trading.py
└── tests/
```

------------------------------------------------------------------------

# 64. IMPORTANT: EXACT CONTRACT MODE

Nếu dự án yêu cầu:

``` text
"giữ nguyên contract"
```

thì AI phải hiểu:

``` text
DNSE field name
DNSE field type
DNSE enum
DNSE endpoint
DNSE HTTP method
DNSE authentication
DNSE response structure
```

đều là **immutable external contract**.

Chỉ được thay đổi ở:

``` text
Internal DTO
Internal business logic
FastAPI public response
```

nếu user yêu cầu.

------------------------------------------------------------------------

# 65. KẾT LUẬN

DNSE OpenAPI có ba nhóm lớn:

``` text
Trading API
Market Data API
Broker API
```

Đối với ứng dụng FastAPI lấy dữ liệu chứng khoán và quản lý tài khoản,
trọng tâm là:

``` text
Authentication
      ↓
Account
      ↓
Market Data
      ↓
Trading
      ↓
Realtime
```

File này là **AI coding reference**, không thay thế contract endpoint
chính thức.

Nguyên tắc tối cao:

> **Không có contract → không được đoán.**

> **Có contract DNSE → giữ nguyên contract ở tầng adapter/client.**

> **Business logic nằm ở service layer.**

> **FastAPI chỉ là lớp interface.**

> **Secret không bao giờ xuất hiện trong source code, log, response hoặc
> tài liệu.**

------------------------------------------------------------------------

# APPENDIX A --- PROMPT CHO AI CODING AGENT

Sử dụng prompt sau khi đưa file này cho AI:

``` text
Bạn đang làm việc với DNSE OpenAPI.

Đọc file DNSE_OPENAPI_AI_CODING_REFERENCE.md trước khi viết code.

QUY TẮC TUYỆT ĐỐI:

1. Không được tự bịa endpoint.
2. Không được tự bịa request/response field.
3. Không được tự bịa enum.
4. Không được tự bịa authentication.
5. Không được tự bịa WebSocket protocol.
6. Không được tự bịa rate limit.
7. Không được tự bịa pagination.
8. Không dùng giá đóng cửa thay cho giá realtime.
9. Không log API Secret, token hoặc OTP.
10. Không hard-code credential.
11. Tách DNSE client khỏi business logic.
12. Dùng Pydantic cho schema khi contract đã xác minh.
13. Nếu một chi tiết chưa xác minh, ghi NEED VERIFY.
14. Không biến suy đoán thành fact.
15. Ưu tiên tài liệu DNSE chính thức hơn mọi nguồn khác.
16. Khi user yêu cầu giữ nguyên contract, không đổi tên field của DNSE.
17. Đối với order/trading, phải xử lý operation có side effect an toàn.
18. HTTP 200 không đồng nghĩa order đã filled.
19. Current price phải lấy từ realtime/last-trade phù hợp.
20. Trước khi code, liệt kê contract endpoint đã xác minh.

Mỗi implementation phải có:

- endpoint
- method
- auth
- request schema
- response schema
- error handling
- client
- service
- router
- tests

Nếu thiếu thông tin contract, KHÔNG ĐOÁN.
```

------------------------------------------------------------------------

# APPENDIX B --- CONTRACT RECORD TEMPLATE

Dùng template này để bổ sung từng endpoint DNSE:

``` markdown
## [ENDPOINT NAME]

Status: VERIFIED / NEED VERIFY

### Purpose

...

### HTTP

Method:
Path:

### Authentication

...

### Headers

| Header | Required | Description |
|---|---:|---|
| ... | ... | ... |

### Path Parameters

| Name | Type | Required | Description |
|---|---|---:|---|
| ... | ... | ... | ... |

### Query Parameters

| Name | Type | Required | Description |
|---|---|---:|---|
| ... | ... | ... | ... |

### Request Body

```json
{}
```

### Response

``` json
{}
```

### Response Schema

  Field   Type     Nullable Description
  ------- ------ ---------- -------------
  ...     ...           ... ...

### Enum

...

### Errors

    HTTP DNSE Code   Meaning
  ------ ----------- ---------
     ... ...         ...

### Notes

...

### Official Source

...


    ---

    # APPENDIX C — SOURCE VALIDATION

    Khi cập nhật file này:

    ```text
    Source:
    DNSE official documentation

    Checked:
    YYYY-MM-DD

    Changed:
    ...

    Impact:
    ...

    Verified:
    YES / NO

Không cập nhật endpoint bằng cách sao chép từ blog/forum/GitHub không
chính thức nếu chưa đối chiếu DNSE.
