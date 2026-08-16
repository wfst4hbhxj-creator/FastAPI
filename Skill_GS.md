# GOOGLE APPS SCRIPT SAFE SKILL

## Mục tiêu
Khi làm việc với bất kỳ dự án Google Apps Script nào, luôn ưu tiên:
1. Giữ nguyên cấu hình hiện có.
2. Đồng bộ lệnh bot nếu có thay đổi.
3. Tối ưu và kiểm tra lại code trước khi trả kết quả.

## Quy tắc bắt buộc

### 1) Không tự ý thay đổi cấu hình
Tuyệt đối không thay đổi các phần cấu hình đã có sẵn nếu người dùng không yêu cầu rõ ràng.

Bao gồm, nhưng không giới hạn:
- API key
- Telegram token
- Chat ID
- Spreadsheet ID
- Sheet name
- Script Properties
- User Properties
- Cache keys
- Webhook URL
- Trigger
- Timezone
- Các hằng số cấu hình khác

Nếu bắt buộc phải đổi cấu hình:
- phải nêu rõ lý do
- phải chỉ ra chính xác dòng/biến cần đổi
- phải chờ xác nhận trước khi áp dụng

### 2) Nếu thay đổi lệnh thì phải đồng bộ toàn bộ
Mỗi khi thêm, xóa, đổi tên, hoặc đổi hành vi của lệnh:
- phải cập nhật `setupBotCommands()`
- phải cập nhật nội dung `/start`
- phải đảm bảo danh sách lệnh hiển thị khớp với lệnh đang xử lý thực tế

Không được để:
- lệnh đã xử lý nhưng không có trong `setupBotCommands()`
- lệnh có trong `/start` nhưng code không còn hỗ trợ
- lệnh mới thêm nhưng bỏ sót ở một trong hai nơi

### 3) Luôn tối ưu lại code
Sau khi sửa xong, luôn kiểm tra:
- có đoạn code nào lặp lại không
- có thể gom hàm chung không
- có thể giảm số lần gọi `getValue()/setValue()` không
- có thể dùng `getValues()/setValues()` không
- có thể giảm `UrlFetchApp.fetch()` không
- có cần cache bằng `CacheService` hoặc `PropertiesService` không
- có lỗi logic, lỗi tên hàm, lỗi biến, lỗi ngoặc, lỗi scope không

### 4) Giữ tương thích ngược
Không được làm hỏng chức năng cũ khi thêm chức năng mới.

Nếu sửa một phần:
- phải kiểm tra các phần liên quan
- phải giữ nguyên luồng hoạt động cũ nếu không có yêu cầu thay đổi

### 5) Trả kết quả theo kiểu dùng ngay
Khi sửa code:
- trả về mã hoàn chỉnh hoặc phần cần thay thế rõ ràng
- không trả lời mơ hồ
- không chỉ nói “sửa tương tự”
- nếu có nhiều file thì chỉ rõ file nào cần sửa

## Cách làm việc khi nhận yêu cầu
Trước khi viết code, hãy tự kiểm tra:
1. Có đụng tới cấu hình không?
2. Có thay đổi lệnh không?
3. Có cần cập nhật `setupBotCommands()` và `/start` không?
4. Có cách nào tối ưu hơn không?
5. Có phần nào dễ lỗi khi chạy trên Google Apps Script không?

## Tiêu chuẩn đầu ra
Khi trả lời, hãy ưu tiên:
- đúng
- gọn
- an toàn với cấu hình hiện có
- đồng bộ lệnh
- tối ưu code
- sẵn sàng copy-paste chạy được