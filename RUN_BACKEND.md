# Hướng dẫn chạy backend quản lý nuôi trồng nấm

Để chạy trọn backend bằng Docker Compose, xem [RUN_DOCKER.md](RUN_DOCKER.md). Compose đóng gói API, classifier CPU, MariaDB và Redis; giữ database/ảnh trong volume và không tự seed. Hướng dẫn bên dưới dành cho chạy trực tiếp trên Windows.

Các lệnh dưới đây dùng **Windows PowerShell**, chạy tại thư mục `dacs_mushroom_backend`. Hướng dẫn dựa trên mã nguồn hiện tại: Node phục vụ API và Socket.IO; Python xử lý nhận diện ảnh; Bull dùng Redis để chạy hàng đợi.

## 1. Chạy lại khi máy đã được cài đặt

Bật MySQL/MariaDB và Redis, kiểm tra `.env` đã đúng, rồi chạy:

```powershell
$env:SKIP_SEED = '1'
npm run start:stack
```

Lệnh này generate Prisma Client, khởi động Python classifier, chờ `/health` sẵn sàng tối đa 60 giây rồi khởi động Node. MySQL/MariaDB và Redis cần chạy sẵn; script không tự bật hai dịch vụ đó.

Mở Swagger tại **http://localhost:8080/api-docs**. Nhấn `Ctrl+C` trong terminal để dừng stack.

**Giữ `SKIP_SEED=1` khi chạy hằng ngày.** Nếu không đặt giá trị này, `start:stack` sẽ chạy seed trước khi bật server, cập nhật tài khoản demo và tạo lại nhật ký, thu hoạch, tiến trình, lịch sử nhận diện và audit demo.

## 2. Phần mềm và cổng

| Thành phần | Cấu hình sử dụng |
| --- | --- |
| Node.js và npm | Dùng Node.js 24; Prisma hiện hỗ trợ Node `^20.19`, `^22.12` hoặc `>=24.0` |
| Python | Python 3.12, gọi bằng `py -3.12` trên Windows |
| MySQL hoặc MariaDB | Database quan hệ; cổng mặc định `3306` |
| Redis | Hàng đợi Bull; cổng mặc định `6379` |
| Node API / Socket.IO | Cổng mặc định `8080` |
| Python classifier | `127.0.0.1:8001`, dịch vụ nội bộ |
| Docker Desktop | Chỉ cần nếu chọn chạy Redis bằng Docker; dùng Linux containers |

Kiểm tra công cụ:

```powershell
node --version
npm --version
py -3.12 --version
```

Các npm script Python hiện dùng `py -3.12`; cài thư viện vào đúng interpreter này. Nếu dùng virtual environment riêng, chạy Python của môi trường đó theo mục 7 thay vì dùng script Python mặc định.

## 3. Cấu hình `.env`

Tạo `.env` tại thư mục gốc, cùng cấp với `server.cjs` và `package.json`. Nếu file đã có, cập nhật các giá trị cần thiết và giữ thông tin kết nối đang sử dụng.

Ví dụ cấu hình phát triển; thay `CHANGE_ME` bằng mật khẩu MySQL thực tế và thay `JWT_SECRET` bằng khóa riêng:

```dotenv
NODE_ENV=development
PORT=8080
JWT_SECRET=CHANGE_ME_WITH_RANDOM_SECRET

DATABASE_URL="mysql://root:CHANGE_ME@127.0.0.1:3306/mushroom_management"
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_USER=root
DATABASE_PASSWORD=CHANGE_ME
DATABASE_NAME=mushroom_management

REDIS_URL=redis://127.0.0.1:6379

CLASSIFIER_SERVICE_URL=http://127.0.0.1:8001
CLASSIFIER_HOST=127.0.0.1
CLASSIFIER_PORT=8001
CLASSIFIER_DEVICE=auto
CLASSIFIER_TIMEOUT_MS=120000
CLASSIFIER_MAX_CONCURRENCY=1

SKIP_SEED=1
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

`DATABASE_URL` dùng cho Prisma CLI, còn Node và seed kết nối bằng nhóm `DATABASE_HOST/PORT/USER/PASSWORD/NAME`. Hai cấu hình phải chỉ đến **cùng database**. Mật khẩu chứa ký tự đặc biệt cần được URL-encode trong `DATABASE_URL`; `DATABASE_PASSWORD` giữ giá trị gốc.

Có thể tạo khóa JWT bằng:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chép kết quả vào `JWT_SECRET`. `.env` đã nằm trong `.gitignore`.

`CORS_ALLOWED_ORIGINS` chứa origin Flutter Web thực tế, phân cách bằng dấu phẩy, ví dụ `http://localhost:5173,http://localhost:54321`. Nếu không cấu hình, backend dùng `*`. HTTP và Socket.IO dùng cùng cấu hình và expose `Content-Disposition` để web đọc tên file export.

Biến tùy chọn:

| Biến | Cách sử dụng |
| --- | --- |
| `CLASSIFIER_SERVICE_TOKEN` | Khóa nội bộ; nếu đặt, Node và Python cần cùng giá trị |
| `CLASSIFIER_DEVICE` | `auto`, `cpu` hoặc `cuda`; `auto` chọn GPU nếu có, còn lại dùng CPU |
| `MODEL_PATH` | Thay checkpoint; mặc định `nammushroom_efficientnet_b0.pth` |
| `LABELS_PATH` | Thay nhãn; mặc định `labels.txt` |
| `MUSHROOM_CATALOG_PATH` | Thay danh mục classifier; mặc định `mushroom.json` |
| `DEMO_PASSWORD` | Mật khẩu khi seed tài khoản demo; mặc định `Demo@12345` |
| `SEED_REFERENCE_DATE` | Mốc ngày tạo dữ liệu demo dạng `YYYY-MM-DD`; mặc định trong seed là `2026-09-23` |

Các đường dẫn asset Python tương đối được tính từ `helper/mushroom_classifier/`. Khi dùng `start:stack`, `.env` được nạp và truyền cho cả Node và Python.

## 4. Cài thư viện lần đầu

### Node.js

Sau khi tạo `.env`:

```powershell
npm ci
npm run prisma:validate
```

Repo có `package-lock.json`; `npm ci` cài theo lockfile và chạy `postinstall` để generate Prisma Client. Generate client chưa tạo bảng database.

### Python classifier

```powershell
py -3.12 -m pip install --upgrade pip
py -3.12 -m pip install -r helper/mushroom_classifier/requirements.txt --extra-index-url https://download.pytorch.org/whl/cu126
```

Requirements đang cố định `torch==2.10.0+cu126` và `torchvision==0.25.0+cu126`, nên cần index CUDA 12.6 của PyTorch. Xem [hướng dẫn PyTorch cho phiên bản 2.10.0](https://pytorch.org/get-started/previous-versions/#v2100).

Máy dùng CPU đặt `CLASSIFIER_DEVICE=cpu`; code classifier hỗ trợ chế độ này. Trước khi chạy, kiểm tra đủ ba file:

- `helper/mushroom_classifier/nammushroom_efficientnet_b0.pth`
- `helper/mushroom_classifier/labels.txt`
- `helper/mushroom_classifier/mushroom.json`

Số class trong checkpoint, labels và danh mục phải khớp nhau.

### Redis bằng Docker

Bật Docker Desktop. Nếu chưa tạo container Redis, chạy:

```powershell
docker run -d --name dacs-mushroom-redis -p 127.0.0.1:6379:6379 -v dacs-mushroom-redis-data:/data redis:7-alpine redis-server --appendonly yes
docker exec dacs-mushroom-redis redis-cli ping
```

Lệnh kiểm tra phải trả `PONG`. Cách chạy container và truy cập `redis-cli` được mô tả trong [tài liệu Redis Docker](https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/docker/).

Nếu container đã tồn tại, dùng lệnh này khi chạy lại:

```powershell
docker start dacs-mushroom-redis
docker exec dacs-mushroom-redis redis-cli ping
```

Nếu đã có Redis chạy trên máy hoặc server khác, dùng dịch vụ đó và sửa `REDIS_URL`; không cần tạo thêm container.

## 5. Chuẩn bị database

### Database mới

Khởi động MySQL/MariaDB. Tạo database qua công cụ quản trị hoặc mở MySQL CLI:

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p
```

Trong MySQL, chạy:

```sql
CREATE DATABASE IF NOT EXISTS mushroom_management
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Thoát MySQL bằng `exit`, kiểm tra tên database trong `.env`, rồi tạo đầy đủ bảng theo schema hiện tại:

```powershell
npx prisma db push --config prisma.config.ts
npm run prisma:generate
```

Các lệnh này áp dụng cho database mới. `prisma/schema.prisma` là nguồn schema đầy đủ; `sql/account.sql` là script cũ và chưa có đủ các cột/bảng hiện tại.

### Database đã có dữ liệu

Nếu các bảng lõi đã có nhưng thiếu phần tiến trình, báo cáo/audit/classifier hoặc task, áp dụng các script bổ sung tương ứng:

```powershell
npx prisma db execute --file sql/growth_progress_records.sql --config prisma.config.ts
npx prisma db execute --file sql/reporting_audit_classifier.sql --config prisma.config.ts
npx prisma db execute --file sql/tasks.sql --config prisma.config.ts
npm run prisma:generate
```

Các script bổ sung yêu cầu bảng lõi như `users` và `cultivation_batches` đã tồn tại. Chúng không thay thế toàn bộ schema. Nếu database cũ thiếu cột khác, đối chiếu với `prisma/schema.prisma` trước khi cập nhật; phần tạo database mới ở trên không phải quy trình nâng cấp database đang dùng.

### Seed dữ liệu demo, khi cần

Chỉ chạy nếu muốn tạo hoặc làm mới dữ liệu demo:

```powershell
npm run db:seed
```

Seed hiện tạo ba giống nuôi trồng ăn được: nấm sò, nấm hương và nấm hầu thủ, cùng cơ sở, 100 lô, nhật ký, tiến trình, thu hoạch, lịch sử classifier và audit. Classifier demo có thể có kết quả nấm độc để kiểm tra cảnh báo nhận diện; các lô demo dùng giống ăn được. Task dashboard chưa được seed, cần tạo qua API.

| Role | Username | Mật khẩu mặc định |
| --- | --- | --- |
| Admin | `demo_admin` | `Demo@12345` |
| Manager | `demo_manager` | `Demo@12345` |
| Staff | `demo_staff` | `Demo@12345` |

Nếu có `DEMO_PASSWORD`, dùng mật khẩu đó. Seed không chạy khi `NODE_ENV=production`. Sau khi seed, dùng `SKIP_SEED=1` để chạy backend mà không tạo lại dữ liệu demo.

## 6. Khởi động và kiểm tra

Bật database và Redis, sau đó:

```powershell
$env:SKIP_SEED = '1'
npm run start:stack
```

Khi terminal hiện `Server listening at http://localhost:8080`, mở một PowerShell khác để kiểm tra:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/test'
Invoke-RestMethod -Uri 'http://127.0.0.1:8001/health'
```

Node trả `status: running`; Python trả `status: ready`, thiết bị và số class. `/api/test` chỉ kiểm tra Node đang phục vụ HTTP, chưa kiểm tra truy vấn database hoặc hàng đợi.

Nếu đã seed demo, kiểm tra đăng nhập và database:

```powershell
$loginBody = @{ username = 'demo_manager'; password = 'Demo@12345' } | ConvertTo-Json
$loginResponse = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8080/api/login' -ContentType 'application/json' -Body $loginBody
$apiHeaders = @{ Authorization = "Bearer $($loginResponse.token)" }
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/auth/me' -Headers $apiHeaders
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/dashboard/tasks' -Headers $apiHeaders
```

Thay thông tin đăng nhập nếu dùng tài khoản có sẵn hoặc mật khẩu demo khác. `/auth/me` phải trả user và role hiện tại; danh sách task có thể rỗng nếu chưa tạo công việc.

| Địa chỉ | Sử dụng |
| --- | --- |
| `http://localhost:8080/api-docs` | Swagger UI |
| `http://localhost:8080/api` | Base URL REST API |
| `http://localhost:8080` | Origin Socket.IO và ảnh `/uploads/...` |
| `http://127.0.0.1:8001/health` | Kiểm tra Python nội bộ |

Để kiểm tra classifier đầy đủ, upload ảnh JPEG/PNG/WebP thật qua Swagger hoặc Flutter. POST trả `202` và `jobId`; client Socket.IO gửi `subscribe_job(jobId)` để nhận `processing`, `finished` hoặc `failed`.

## 7. Chạy Node và Python riêng

Dùng cách này khi Python đã được chạy riêng, hoặc cần interpreter của virtual environment. Hai terminal đều bắt đầu ở thư mục gốc backend.

Terminal 1, dùng launcher Python mặc định và nạp cùng `.env`:

```powershell
node --env-file=.env -e "require('node:child_process').spawn('py', ['-3.12', 'helper/mushroom_classifier/server.py'], { stdio: 'inherit', env: process.env });"
```

Nếu đã cài dependencies trong `.venv`, thay lệnh trên bằng:

```powershell
node --env-file=.env -e "require('node:child_process').spawn('.venv/Scripts/python.exe', ['helper/mushroom_classifier/server.py'], { stdio: 'inherit', env: process.env });"
```

Terminal 2:

```powershell
node server.cjs
```

Node và Python lúc này được dừng bằng `Ctrl+C` tại từng terminal. Tránh bật thêm `start:stack` khi Python đang chiếm cùng cổng `8001`.

Lệnh `npm run classifier:serve` cũng chạy Python bằng `py -3.12`, nhưng Python không tự đọc `.env`; lệnh này cần các biến classifier đã có trong môi trường terminal. Các lệnh bọc bằng `node --env-file` ở trên nạp cấu hình cho tiến trình con.

## 8. Chạy kiểm thử

Kiểm thử Node:

```powershell
npm test
```

Kiểm thử Python dùng `TestClient`, cần cài thêm `httpx` nếu chưa có; đây là dependency được yêu cầu trong [hướng dẫn kiểm thử FastAPI](https://fastapi.tiangolo.com/tutorial/testing/#using-testclient).

```powershell
py -3.12 -m pip install httpx
npm run test:python
```

Chạy cả hai:

```powershell
npm run test:all
```

Test Python có kiểm tra nạp model thật trên CPU. Các kiểm thử route Node dùng Prisma giả lập; dùng bước đăng nhập/HTTP và upload ảnh ở mục 6 để kiểm tra môi trường đang chạy.

## 9. Lỗi thường gặp

| Hiện tượng | Kiểm tra và xử lý |
| --- | --- |
| Không tìm thấy `.env` | Chạy tại thư mục gốc backend; `.env` cùng cấp `package.json` |
| `py` không chạy hoặc không có Python 3.12 | Kiểm tra `py -3.12 --version`; sửa cài đặt launcher/Python hoặc chạy interpreter riêng theo mục 7 |
| Không tìm thấy bản `torch==2.10.0+cu126` | Cài requirements với `--extra-index-url https://download.pytorch.org/whl/cu126` |
| `ModuleNotFoundError` | Cài requirements vào đúng Python đang khởi động classifier |
| `CUDA_UNAVAILABLE` | Đặt `CLASSIFIER_DEVICE=cpu` hoặc `auto`, rồi khởi động lại Python |
| `MODEL_MISSING` / `MODEL_METADATA_MISMATCH` | Kiểm tra checkpoint, labels, danh mục và các biến đường dẫn asset |
| Python không sẵn sàng sau 60 giây | Đọc lỗi Python trong terminal; kiểm tra `/health`, cổng và sự thống nhất `CLASSIFIER_PORT` với `CLASSIFIER_SERVICE_URL` |
| `ECONNREFUSED` ở Redis | Bật Redis, kiểm tra `PONG` và `REDIS_URL` |
| Database không kết nối hoặc thiếu bảng | Bật MySQL/MariaDB; kiểm tra quyền tài khoản, hai cấu hình DB và bước chuẩn bị schema |
| Prisma Client chưa có model task | Chạy `npm run prisma:generate`, bảo đảm DB có bảng `tasks`, rồi khởi động lại Node |
| `EADDRINUSE` | Một tiến trình đang dùng cổng; dừng phiên backend cũ hoặc đổi `PORT`/cổng classifier tương ứng |
| Web bị CORS | Thêm đúng origin web, gồm scheme, host và port, vào `CORS_ALLOWED_ORIGINS`; khởi động lại stack |
| Điện thoại không truy cập API | Dùng IP LAN của máy backend, cùng mạng và cho phép cổng Node qua Windows Firewall |

Flutter Android Emulator thường dùng `http://10.0.2.2:8080/api`; điện thoại thật dùng `http://<IP-LAN>:8080/api`. Client kết nối Node; classifier Python là dịch vụ nội bộ. Khi triển khai HTTPS, cấu hình API, ảnh và Socket.IO qua cùng reverse proxy HTTPS/WSS.

Các hợp đồng API và ví dụ request nằm trong [NEW_API_DOCUMENTATION.md](NEW_API_DOCUMENTATION.md), [API_TEST_PARAMS.md](API_TEST_PARAMS.md) và [FLUTTER_API_INTEGRATION_GUIDE.md](FLUTTER_API_INTEGRATION_GUIDE.md).
