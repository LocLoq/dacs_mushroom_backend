# Chạy backend bằng Docker Compose

Docker Compose chạy trọn backend: Node API/Socket.IO, Python classifier, MariaDB và Redis. Bull worker chạy trong tiến trình Node. Flutter gọi API qua cổng `8080`; classifier chạy CPU và không cần CUDA/GPU trên máy chủ.

## 1. Chuẩn bị

Cài Docker Desktop và chọn **Linux containers** trên Windows, hoặc Docker Engine kèm Compose v2 trên Linux. Các lệnh dưới đây chạy tại thư mục gốc repository; ví dụ sao chép file dùng PowerShell.

```powershell
docker --version
docker compose version
Copy-Item .env.docker.example .env.docker
```

Sửa `.env.docker`, thay toàn bộ `CHANGE_ME` bằng giá trị riêng. Có thể tạo mỗi khóa bằng lệnh PowerShell sau, chạy lại cho từng khóa:

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Lệnh tạo khóa trên cần PowerShell 7. Nếu dùng Windows PowerShell 5.1, dùng:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[BitConverter]::ToString($bytes).Replace('-', '')
$rng.Dispose()
```

| Biến trong `.env.docker` | Ý nghĩa |
| --- | --- |
| `API_PORT` | Cổng trên máy chủ, mặc định `8080` |
| `DB_NAME`, `DB_USER` | Database và tài khoản ứng dụng; giữ mặc định cho lần đầu |
| `DB_PASSWORD` | Mật khẩu database của ứng dụng |
| `DB_ROOT_PASSWORD` | Mật khẩu quản trị MariaDB, khác mật khẩu ứng dụng |
| `JWT_SECRET` | Khóa ký JWT; thay khóa sẽ làm token hiện tại không dùng được |
| `CLASSIFIER_SERVICE_TOKEN` | Khóa nội bộ được Compose truyền giống nhau cho Node và Python |
| `CLASSIFIER_MAX_CONCURRENCY` | Số lượt inference đồng thời, mặc định `1` |
| `CLASSIFIER_TIMEOUT_MS` | Thời gian Node chờ Python, mặc định `120000` ms |
| `CORS_ALLOWED_ORIGINS` | Danh sách origin web cách nhau bằng dấu phẩy; để trống giữ `*` |

Đặt mật khẩu có `$` hoặc `#` trong dấu nháy đơn, như mẫu. `.env.docker` được bỏ qua bởi Git và Docker build context. Compose chỉ truyền các biến được khai báo vào container; không sao chép `.env` của môi trường chạy trực tiếp vào image.

Luôn dùng `--env-file .env.docker` trong các lệnh Compose bên dưới để tách cấu hình Docker khỏi `.env` đang dùng trên máy. Không cần cài Node, Python, MariaDB hay Redis riêng trên máy chủ.

## 2. Build và khởi động

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 300
docker compose --env-file .env.docker ps -a
```

Lần build đầu tải Node/Python image và PyTorch CPU, có thể mất vài phút. File model `helper/mushroom_classifier/nammushroom_efficientnet_b0.pth`, labels và catalog trong repository được đóng vào image classifier; không tải model lúc khởi động.

| Service | Chức năng / điều kiện khởi động |
| --- | --- |
| `db` | MariaDB 11.4; healthcheck chờ kết nối và InnoDB sẵn sàng |
| `redis` | Redis 7, bật AOF để lưu hàng đợi |
| `classifier` | Python 3.12 / PyTorch 2.10 CPU; healthy sau khi model được nạp |
| `db-init` | Chạy `prisma db push` một lần, kết thúc với mã `0` khi schema sẵn sàng |
| `api` | Node 24; chờ `db-init` thành công, Redis và classifier healthy |

`db-init` ở trạng thái **Exited (0)** là bình thường. Compose dùng điều kiện hoàn tất và healthcheck để chờ dependency theo [tài liệu Docker](https://docs.docker.com/compose/how-tos/startup-order/). MariaDB dùng [healthcheck.sh chính thức](https://mariadb.com/docs/server/server-management/automated-mariadb-deployment-and-administration/docker-and-mariadb/using-healthcheck-sh).

Compose tạo database riêng trong named volume. Dữ liệu MySQL/MariaDB đang chạy trực tiếp trên máy **không tự được nhập** vào database Docker. `db-init` tạo/cập nhật schema từ `prisma/schema.prisma`, bao gồm bảng công việc; không cần chạy thêm các SQL bổ sung cho database mới này. Không dùng `--accept-data-loss` hoặc `--force-reset`; thay đổi schema có nguy cơ mất dữ liệu sẽ khiến bước này dừng để xử lý thủ công.

## 3. Tạo dữ liệu demo khi cần

Database mới có schema nhưng chưa có tài khoản. Để thử app trong môi trường phát triển, chạy seed chủ động một lần:

```powershell
docker compose --env-file .env.docker exec -e NODE_ENV=development api npm run db:seed
```

Lệnh seed upsert tài khoản, nấm ăn được, cơ sở và lô demo; tạo lại nhật ký, thu hoạch, tiến trình, lịch sử classifier và audit demo. Chỉ dùng khi chấp nhận cập nhật các dữ liệu demo đó. Lịch sử classifier vẫn có mẫu nấm độc để thử nhận diện; lô nuôi trồng demo chỉ dùng nấm ăn được.

| Role | Username | Mật khẩu mặc định |
| --- | --- | --- |
| Admin | `demo_admin` | `Demo@12345` |
| Manager | `demo_manager` | `Demo@12345` |
| Staff | `demo_staff` | `Demo@12345` |

Có thể thay mật khẩu demo bằng `exec -e NODE_ENV=development -e DEMO_PASSWORD=your-demo-password api npm run db:seed`. Biến `NODE_ENV` ở lệnh `exec` chỉ áp dụng cho tiến trình seed; API tiếp tục chạy với `NODE_ENV=production`.

Container khởi động bằng `node server.cjs`, **không tự seed**, nên không cần `SKIP_SEED`. Khi triển khai với dữ liệu thật, phục hồi database đã có tài khoản hoặc chuẩn bị tài khoản quản trị riêng; không dùng dữ liệu/tài khoản demo làm tài khoản vận hành.

## 4. Kiểm tra và kết nối Flutter

```powershell
Invoke-RestMethod http://localhost:8080/api/test
docker compose --env-file .env.docker exec classifier python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8001/health').read().decode())"
```

API trả `{"status":"running"}`; classifier trả `status=ready`, `device=cpu` và số class. Healthcheck API kiểm tra HTTP hoạt động; không thực hiện truy vấn DB hoặc enqueue job. Để kiểm tra đầy đủ luồng, đăng nhập trong Swagger và gửi ảnh đến `POST /api/mushroom-classifier`, sau đó theo dõi job theo hướng dẫn tích hợp.

- Swagger: **http://localhost:8080/api-docs**; các request thử API tự dùng host/cổng đang mở Swagger.
- Flutter Desktop / web cùng máy: `http://localhost:8080/api`.
- Android Emulator: `http://10.0.2.2:8080/api`.
- Điện thoại thật: `http://<LAN-IP-máy-chủ>:8080/api`; cho phép cổng API qua firewall.
- Socket.IO dùng cùng server origin, bỏ phần `/api`.

Nếu đổi `API_PORT`, thay cổng tương ứng trong các URL trên. Chỉ cổng API được publish ra máy chủ. Database, Redis và classifier dùng mạng Compose nội bộ; app không gọi tên service `api`, `db` hay `classifier`.

Flutter web cần origin cố định, ví dụ chạy với `--web-port=5173`, rồi đặt:

```dotenv
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Sau khi sửa, chạy lại `up -d` để container nhận cấu hình mới. HTTP và Socket.IO dùng chung CORS; cho phép `Authorization`, `Content-Type` và expose `Content-Disposition` để đọc tên file báo cáo.

## 5. Dừng, khởi động lại và cập nhật

```powershell
docker compose --env-file .env.docker logs --tail 100 api classifier db-init
docker compose --env-file .env.docker stop
docker compose --env-file .env.docker up -d --wait --wait-timeout 300
```

Khi cập nhật source hoặc schema, sao lưu dữ liệu trước, rồi tạo lại stack để chắc chắn `db-init` chạy theo schema mới:

```powershell
docker compose --env-file .env.docker down
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 300
```

`down` giữ các volume `dacs-mushroom_database`, `dacs-mushroom_redis`, `dacs-mushroom_uploads`. Database, hàng đợi và ảnh `/uploads/...` tồn tại qua các lần tạo lại container. **Không thêm `-v` vào `down` khi cần giữ dữ liệu.** Không đổi Compose project name nếu muốn dùng lại các volume này.

Thay mật khẩu trong `.env.docker` không đổi mật khẩu của database đã khởi tạo: các biến `MARIADB_*` chỉ dùng để tạo database/tài khoản lần đầu. Khi đổi mật khẩu thật, cập nhật tài khoản trong MariaDB và cấu hình ứng dụng tương ứng. Đổi `JWT_SECRET` hoặc token classifier cần tạo lại container bằng `up -d`; `restart` không nạp cấu hình env mới.

## 6. Sao lưu database và ảnh

Ví dụ sau không dùng chuyển hướng SQL ra PowerShell, tránh lỗi encoding của Windows PowerShell 5.1:

Lệnh dump dùng `--%` để Windows PowerShell truyền nguyên dấu nháy và biến shell vào container, kể cả khi mật khẩu có khoảng trắng. Chạy đoạn này bằng PowerShell trên Windows.

```powershell
New-Item -ItemType Directory -Force backups
docker --% compose --env-file .env.docker exec -T db sh -c "mariadb-dump -uroot -p\"$MARIADB_ROOT_PASSWORD\" --single-transaction --routines --events \"$MARIADB_DATABASE\" > /tmp/mushroom-backup.sql"
docker compose --env-file .env.docker cp db:/tmp/mushroom-backup.sql backups/database.sql
docker compose --env-file .env.docker exec -T api tar -czf /tmp/uploads-backup.tar.gz -C /app/uploads .
docker compose --env-file .env.docker cp api:/tmp/uploads-backup.tar.gz backups/uploads.tar.gz
```

Sao lưu cả SQL và upload; SQL chỉ lưu đường dẫn ảnh. Thư mục `backups/` được Git và Docker build bỏ qua. Khi cần bản sao đồng bộ, dừng các client ghi dữ liệu trong thời gian sao lưu.

## 7. Kiểm thử image API và xuất image

Dockerfile API có target `test`, chứa các kiểm thử Node mà image chạy chính không cần mang theo:

```powershell
docker build --target test -f docker/Dockerfile.api -t dacs-mushroom-api:test .
docker run --rm dacs-mushroom-api:test
```

Sau khi build stack thành công, có thể đóng gói hai image của ứng dụng để chuyển máy:

```powershell
docker save -o backups/mushroom-images.tar dacs-mushroom-api:local dacs-mushroom-classifier:local
```

Máy nhận chạy `docker load -i backups/mushroom-images.tar`, sao chép `compose.yaml` cùng `.env.docker` đã cấu hình riêng, rồi `docker compose --env-file .env.docker up -d --no-build --wait --wait-timeout 300`. Máy nhận vẫn cần tải image MariaDB/Redis nếu chưa có; dữ liệu volume không nằm trong file image và phải phục hồi riêng.

## 8. Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| Không tìm thấy `docker` / không kết nối daemon | Cài và mở Docker Desktop, chọn Linux containers; kiểm tra `docker info` |
| Thiếu biến DB/JWT/token | Sao chép và sửa `.env.docker`; truyền `--env-file .env.docker` |
| Cổng `8080` đã dùng | Dừng API chạy trực tiếp hoặc đổi `API_PORT` |
| `db-init` thoát khác `0` | Xem `logs db-init`; kiểm tra DB credentials và thay đổi schema; không ép reset dữ liệu |
| DB báo access denied sau khi đổi env | Volume cũ vẫn giữ tài khoản/mật khẩu cũ; cập nhật DB và env đồng bộ |
| Classifier chưa healthy | Xem `logs classifier`; chờ nạp model, kiểm tra file model và RAM được cấp cho Docker |
| Không đăng nhập được trên DB mới | Chưa tạo tài khoản; dùng seed chủ động cho demo ở mục 3 hoặc phục hồi DB đã có user |
| Flutter web lỗi CORS | Kiểm tra đúng scheme/host/port của origin; sửa env và tạo lại API bằng `up -d` |
| Ảnh không hiển thị | Ghép URL `/uploads/...` với server origin; giữ và phục hồi volume upload cùng database |

Bản CPU dùng phiên bản torch/torchvision tương ứng với baseline của dự án theo [hướng dẫn PyTorch](https://pytorch.org/get-started/previous-versions/). Chạy trực tiếp với CUDA trên Windows vẫn dùng `helper/mushroom_classifier/requirements.txt` và [RUN_BACKEND.md](RUN_BACKEND.md).
