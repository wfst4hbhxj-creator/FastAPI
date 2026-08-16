# Hướng dẫn test `main.py` ở local

> Lưu ý: `CK.gs` KHÔNG chạy được ở local — nó bắt buộc phải chạy trên Google Apps Script
> (dán vào script.google.com hoặc `clasp push`) vì dùng các API riêng của GAS
> (`UrlFetchApp`, `PropertiesService`, `ScriptApp.newTrigger`...), không tồn tại ở Node/Python local.
> Phần dưới đây chỉ để test backend FastAPI (`main.py`).

## 1. Tạo virtual environment

```bash
python3 -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt --break-system-packages
```

(bỏ `--break-system-packages` nếu bạn dùng venv chuẩn, chỉ cần khi pip báo lỗi "externally-managed-environment")

## 2. Cấu hình biến môi trường

Copy `.env.example` thành `.env` rồi điền `DNSE_API_KEY` / `DNSE_API_SECRET` thật vào.

`main.py` đọc trực tiếp bằng `os.getenv(...)`, KHÔNG tự động load file `.env`
(để tránh thêm dependency `python-dotenv` ngoài phạm vi đã thống nhất). Trước khi chạy, export
biến môi trường vào shell bằng 1 trong 2 cách:

```bash
# Cách 1 — export thủ công
export DNSE_API_KEY="..."
export DNSE_API_SECRET="..."
export DNSE_BASE_URL="https://openapi.dnse.com.vn"

# Cách 2 — load từ file .env (không cần cài thêm gì)
export $(grep -v '^#' .env | xargs)
```

Nếu không set 2 biến trên, `/stock/{symbol}` vẫn chạy bình thường — chỉ tự fallback thẳng về vnstock
(vì `_get_dnse_client()` trả `None` khi thiếu key/secret).

## 3. Chạy server

```bash
uvicorn main:app --reload --port 8000
```

## 4. Test nhanh

```bash
curl http://localhost:8000/health
curl http://localhost:8000/stock/VNM        # xem field "source": "dnse" hay "vnstock"
curl http://localhost:8000/quality/FPT
curl http://localhost:8000/hold/HAG
```

Nếu thấy `"source":"dnse"` nghĩa là DNSE OpenAPI đang hoạt động và trả giá thật.
Nếu thấy `"source":"vnstock"` nghĩa là DNSE lỗi/thiếu cấu hình và đã fallback đúng như thiết kế.
