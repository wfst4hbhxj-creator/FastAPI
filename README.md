# DNSE Intermediary API

API trung gian (Intermediary API) được xây dựng bằng FastAPI, lấy dữ liệu từ DNSE OpenAPI để phục vụ cho Telegram Bot.

## Tính năng

- Fetch dữ liệu chứng khoán, tin tức, tài chính từ DNSE.
- Tự động fallback/mock data cho các trường hợp DNSE API không hỗ trợ sẵn (ví dụ: điểm chất lượng, quỹ nắm giữ).
- Cơ chế TTL Caching giúp tránh rate-limit khi gọi các endpoint nặng (`/market`).
- Cấu trúc Response được giữ nguyên để tương thích 100% với Google Apps Script Bot hiện tại.

## Biến môi trường (Environment Variables)

Khi deploy trên Render, cần cấu hình các biến sau:
- `DNSE_API_KEY`: API Key được cấp bởi DNSE.
- `DNSE_API_SECRET`: (Tuỳ chọn) API Secret nếu có.
- `DNSE_BASE_URL`: (Mặc định: `https://services.entrade.com.vn/dnse-market/v1`) Endpoint gốc của DNSE OpenAPI.

## Chạy thử (Local)

1. Cài đặt các thư viện:
   ```bash
   pip install -r requirements.txt
   ```
2. Chạy server:
   ```bash
   uvicorn main:app --reload
   ```
3. Truy cập Swagger UI tại: `http://localhost:8000/docs`

## Deploy lên Render

Dự án đã có sẵn `Dockerfile` và `render.yaml`. 
Bạn chỉ cần kết nối repository này với Render, chọn **Blueprint** để triển khai qua `render.yaml` hoặc triển khai bằng **Docker** thông thường. Render sẽ tự động build và chạy với cổng 8000.
