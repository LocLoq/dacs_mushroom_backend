# Retry, giám sát classifier và rate limit

## Hành vi API và hàng đợi

Toàn bộ `/api` mặc định cho phép 300 yêu cầu/phút; riêng `POST /api/mushroom-classifier/classify` cho phép 10 yêu cầu/phút. Hai hạn mức độc lập, đếm theo tài khoản có JWT và `tokenver` hợp lệ, hoặc IP khách. `/api/test` và `OPTIONS` được miễn. Bộ đếm ở bộ nhớ của mỗi backend, reset khi restart; triển khai hiện tại dùng một backend.

Vượt hạn mức trả `429 {code: "RATE_LIMITED", message: ...}` kèm `Retry-After` (giây), `RateLimit`, `RateLimit-Policy`. Web đọc được các header này qua CORS. Rate limit và kiểm tra sức khỏe chạy trước Multer nên yêu cầu bị chặn không tạo ảnh hay lượt tra cứu.

Redis/Python chưa sẵn sàng trả `503` với `QUEUE_UNAVAILABLE` hoặc `CLASSIFIER_UNAVAILABLE`. `/health` của Python phải trả HTTP 200 và `status=ready`. Producer Redis không giữ lệnh offline hoặc tự phát lại lệnh chưa được xác nhận; worker có kết nối riêng để phục hồi khi Redis hoạt động lại. Enqueue có deadline 5 giây. Nếu xác nhận enqueue đến muộn sau khi lượt tra cứu đã FAILED, worker bỏ qua lượt đó.

Job được chạy tối đa 3 lần, chờ 30 rồi 60 giây giữa các lần. Retry lỗi kết nối, timeout, HTTP 429 và 5xx tạm thời. Lỗi ảnh, file đã mất, token nội bộ, cấu hình/model hoặc response sai schema dừng ngay. Khi chờ retry: trạng thái `QUEUED`, `completedAt=null`, ảnh được giữ lại. Thành công xóa lỗi cũ, lưu kết quả trước khi phát `finished` và dọn ảnh. Lỗi cuối cùng lưu `FAILED`, phát `failed`, ghi audit và dọn ảnh.

`startedAt` xác định lần xử lý hiện tại. Các ghi kết quả/lỗi đều kiểm tra trạng thái và thời điểm này để ngăn kết quả đến muộn hoặc một lần xử lý stalled ghi đè kết quả mới. Khi backend shutdown, request đang chạy được hủy; các job còn lượt thử được giữ để retry.

## Giám sát và phục hồi

Backend kiểm tra Redis/Python và đối chiếu database–Bull lúc khởi động, sau đó mỗi 10 giây, theo từng trang và không chạy chồng lượt. Mỗi phép kiểm tra health có timeout 2 giây; API chỉ dùng cache tối đa 5 giây.

- `QUEUED` quá 5 phút tính từ `updatedAt` của lần vào hàng đợi gần nhất: `QUEUE_WAIT_TIMEOUT`, kể cả Redis đang mất kết nối. `queuedAt` vẫn giữ thời điểm tiếp nhận ban đầu.
- Không có job trong Redis sau khoảng đệm 15 giây: `QUEUE_JOB_MISSING`.
- Bull đã thất bại nhưng database chưa kết thúc: `QUEUE_JOB_FAILED`. Sự kiện `failed` của một lần đang retry không kết thúc lượt tra cứu.
- Mỗi request Python có timeout 120 giây; lookup vẫn `PROCESSING` quá 150 giây/lần: `PROCESSING_TIMEOUT`, hủy request HTTP cục bộ khi có thể.
- Bull xử lý stalled theo cơ chế mặc định. Log chứa `jobId`, mã lỗi và lần chạy; health chỉ log khi trạng thái thay đổi.

Trường nullable `inputPath` chỉ dùng nội bộ để dọn ảnh sau khi Redis mất job hoặc backend restart. API/Socket.IO không trả đường dẫn này. Chỉ xóa file trong `uploads/classifier`; ảnh cũ hơn 24 giờ còn được lookup đang hoạt động tham chiếu vẫn được giữ. Lookup cũ có `inputPath=null` vẫn đọc được; ảnh không còn tham chiếu sẽ được dọn theo tuổi file.

`npm run start:stack` giám sát tiến trình Python trực tiếp, kể cả trên Windows dùng launcher `py`. Khi Python thoát ngoài dự kiến, restart sau 2/4/8 giây, tối đa 3 lần trong 5 phút; mỗi lần đợi health tối đa 60 giây. Hết lượt sau khi Node đã chạy vẫn giữ các API khác hoạt động. Nếu Python chưa từng sẵn sàng, stack báo lỗi khởi động. Shutdown chủ động không restart Python. Docker dùng chính sách `restart: unless-stopped` hiện có; API kiểm tra health liên tục trong cả hai cách chạy.

## Socket.IO

Client chỉ upload một lần khi nhận `202`, sau đó gửi `subscribe_job(jobId)`. Retry backend không cần upload lại.

Sự kiện bổ sung:

```json
{
  "event": "retrying",
  "payload": {
    "jobId": "UUID",
    "status": "QUEUED",
    "attempt": 1,
    "maxAttempts": 3,
    "retryDelayMs": 30000,
    "message": "Đang chờ thử lại nhận diện"
  }
}
```

`processing` thêm `attempt` và `maxAttempts`; `failed` thêm `code` khi lỗi xảy ra trực tiếp. Giữ các sự kiện `finished`, `failed` và cơ chế replay khi subscribe/reconnect. Replay dựa trên database nên trạng thái đang chờ được trả dưới sự kiện `processing` với `status=QUEUED` như trước.

## Cấu hình

Các giá trị thời gian dùng millisecond; cấu hình số phải là số nguyên dương.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Cửa sổ giới hạn chung và classifier |
| `API_RATE_LIMIT_MAX` | 300 | Quota API chung |
| `CLASSIFIER_RATE_LIMIT_MAX` | 10 | Quota nhận diện |
| `TRUST_PROXY` | false | Địa chỉ/subnet proxy tin cậy hoặc số hop; không chấp nhận `true` |
| `CLASSIFIER_JOB_ATTEMPTS` | 3 | Tổng số lần chạy |
| `CLASSIFIER_RETRY_BACKOFF_MS` | 30000 | Thời gian chờ đầu tiên, nhân đôi sau mỗi thất bại |
| `CLASSIFIER_TIMEOUT_MS` | 120000 | Timeout request Python |
| `CLASSIFIER_PROCESSING_TIMEOUT_MS` | timeout Python + 30000 | Giới hạn PROCESSING của monitor; Compose mặc định 150000 |
| `CLASSIFIER_HEALTH_TIMEOUT_MS` | 2000 | Timeout mỗi health probe/lệnh producer Redis |
| `CLASSIFIER_HEALTH_CACHE_MS` | 5000 | Tuổi cache health tối đa |
| `CLASSIFIER_ENQUEUE_TIMEOUT_MS` | 5000 | Deadline enqueue |
| `CLASSIFIER_MONITOR_INTERVAL_MS` | 10000 | Chu kỳ monitor |
| `CLASSIFIER_MONITOR_PAGE_SIZE` | 100 | Số lookup/trang |
| `CLASSIFIER_QUEUE_WAIT_MS` | 300000 | Giới hạn chờ xử lý |
| `CLASSIFIER_MISSING_JOB_GRACE_MS` | 15000 | Khoảng đệm trước khi kết luận job mất |
| `CLASSIFIER_RESTART_LIMIT` | 3 | Số restart Python local/cửa sổ |
| `CLASSIFIER_RESTART_WINDOW_MS` | 300000 | Cửa sổ restart local |
| `CLASSIFIER_RESTART_BACKOFF_MS` | 2000 | Thời gian chờ restart đầu tiên |
| `CLASSIFIER_STARTUP_TIMEOUT_MS` | 60000 | Thời gian đợi Python sẵn sàng mỗi lần |

Khi tăng timeout Python, tăng giới hạn PROCESSING tương ứng; trong Compose cần chỉnh cả hai biến. Proxy phải được cấu hình theo topology triển khai thật để IP khách chính xác.

## Cập nhật và kiểm thử

Cập nhật schema trước khi chạy backend mới, giữ dữ liệu hiện có:

```powershell
npx prisma db push
npm run prisma:generate
```

Docker chạy `db-init` theo quy trình hiện có. Nếu quản lý schema bằng SQL, chạy `sql/classifier_resilience.sql` trên database đã có bảng classifier; script thêm cột nullable và chạy lại được. Không cần seed hoặc reset database.

```powershell
npm test
npm run test:python
npm run test:db
npm run test:classifier
npm run prisma:validate
```

`test:classifier` dùng Redis thật và Python HTTP fixture riêng, giết Python giữa một request rồi xác nhận supervisor/Bull phục hồi và phát kết quả đúng một lần. Queue có tên ngẫu nhiên, mặc định Redis database 15; chỉ xóa các key thuộc queue đó, không flush Redis. Có thể đặt `CLASSIFIER_TEST_REDIS_URL` và `CLASSIFIER_TEST_PYTHON_BIN` để dùng môi trường kiểm thử riêng. Các bài tích hợp chỉ chạy khi gọi script tương ứng; `npm test` chạy unit/route tests cùng đồng hồ giả cho các deadline dài.
