# Benchmark nhiều cơ sở

Trên máy Windows, chạy tại thư mục backend:

```powershell
powershell -NoProfile -File benchmarks/k6/run-local.ps1
```

Mặc định script kết nối `loql@192.168.1.200` bằng SSH key đã xác thực, tạo stack và database benchmark riêng, chạy smoke rồi chạy suite. Cần Docker Desktop, Node, SSH/SCP, tar, k6 và Python có Pillow/Matplotlib. `-Server`, `-SshUser`, `-Image`, `-K6`, `-Python` thay đường dẫn mặc định; `-Smoke` chỉ chạy smoke. `-Suite Small` chỉ chạy các mức 5–100 VU; `-Suite Main` chỉ chạy hai lượt 2.000 VU. Server cần cổng 18080 trống, Docker Compose và đủ chỗ lưu image, database và bản snapshot.

Suite có 10 cơ sở, 5 admin, 20 manager, 180 staff và 1.795 khách; seed 200 bản ghi nấm tổng hợp, 50 lô và lịch sử theo lô. Hai manager cùng cơ sở có cùng phạm vi quản lý staff. Kịch bản chọn tài nguyên trong từng cơ sở theo phân bố đều hoặc 80/20. Ảnh nhận diện được xác thực bằng Pillow và dùng chung fixture; kết quả không đo độ chính xác mô hình trên ảnh đa dạng.

Mỗi đối chứng nhỏ gồm tăng tải 10 giây, giữ 2 phút, giảm tải 10 giây và chờ job. Hai lượt chính đều dùng phân bố 80/20, với cache trống lúc bắt đầu hoặc đã làm nóng. Profile chính tăng đến 200, 500, 1.000 và 2.000 VU qua bốn chặng 1 phút, giữ 2.000 trong 5 phút, rồi giảm về 0 trong 1 phút. Thời gian chuẩn bị và chờ job tới 15 phút nằm ngoài 10 phút tải. Toàn bộ suite lâu hơn nhiều so với một lượt đo.

Trước từng biến thể, script khôi phục snapshot database benchmark, làm sạch Redis hàng đợi của **riêng project benchmark**, xác thực lại và dùng cùng cấu hình API pool 10, worker pool 4, classifier concurrency 2, PyTorch 1 thread. Không chạy suite trên database ứng dụng hoặc Redis dùng chung. Thao tác ghi benchmark có thể tạo thêm dữ liệu trong lượt đo; dữ liệu ban đầu được khôi phục giữa các lượt.

Preflight kiểm tra các endpoint và sau warmup runner đổi namespace cache. Lượt warm nạp dữ liệu bằng API thật và kiểm tra cache hit. Lượt cold bắt đầu với cache trống: cache được lấp dần trong thời gian tăng tải, do đó không coi toàn bộ lượt đo là cold. Kiểm tra truy cập chéo có chủ đích được ghi riêng khỏi lỗi nghiệp vụ; lỗi cách ly dừng suite. Nhận diện là dịch vụ dùng chung và không được gán cơ sở.

Smoke có một cơ sở thuộc manager và một cơ sở khác để kiểm tra từ chối truy cập. Manifest lưu cửa sổ lịch sử và tổng tài chính đối chứng theo cơ sở; kiểm tra báo cáo dùng cửa sổ này để tránh ảnh hưởng từ các thao tác ghi trong lúc chạy.

Kết quả nằm dưới `.cache/benchmark-results/<run>/<case>` gồm metadata, phiên bản, readiness, summary, JSON/CSV, biểu đồ và log. `analysis.json` chứa thống kê cache, kiểm tra cách ly và slot cơ sở; `timeseries.json` chứa độ phủ các slot dữ liệu. Các slot là thứ tự tổng hợp, không phải nhãn chứa ID database. Phân bố 80/20 là giả lập và cần so sánh với hành vi thực tế nếu có dữ liệu.

`sessions.json` trong `.cache/benchmark/<run>` chứa JWT và tên tài khoản, không chia sẻ hoặc commit file này. Prometheus/Grafana chỉ bind loopback. Các ngưỡng API đọc là p95 <500 ms, p99 <1 giây, HTTP lỗi <1%, checks ≥99%; các request bị từ chối do quá tải vẫn tính lỗi. Script lưu kết quả ngay cả khi ngưỡng hiệu năng thất bại; smoke và lỗi cách ly là điều kiện dừng.

Cache dùng Redis riêng (`CACHE_REDIS_URL`) và có thể bật/tắt bằng `CACHE_ENABLED`. TTL môi trường là `CACHE_SPECIES_TTL`, `CACHE_GALLERY_TTL` và `CACHE_PROGRESS_TTL`; không dùng `FLUSHDB` trên Redis ứng dụng. Cleanup chỉ dùng script `benchmarks/k6/cleanup.cjs` với đúng run ID và database `benchmark_*` hoặc dừng riêng project benchmark khi không còn cần dữ liệu.
