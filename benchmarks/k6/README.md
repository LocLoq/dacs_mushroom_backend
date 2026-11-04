# Benchmark k6 theo vai trò

## Chạy tự động từ máy Windows

Trong PowerShell tại thư mục backend, chạy `powershell -NoProfile -File benchmarks/k6/run-local.ps1`. Mặc định script dùng SSH `loql@192.168.1.200`, khóa `~/.ssh/id_ed25519`, ảnh `.cache/k6-test/mushroom.jpg`, k6 và Python trong các vị trí mặc định trên máy này. Có thể đổi bằng tham số `-Server`, `-SshUser`, `-Image`, `-K6`, `-Python`. Host key phải được xác minh và có trong `~/.ssh/known_hosts` trước khi chạy.

Script tạo project và database benchmark mới, tự chạy smoke 10 VU, dọn stack smoke khi đạt, sau đó seed 560 tài khoản, đo bốn cấu hình classifier và hai cấu hình pool 100 VU, xác thực lại và chạy profile 10.000 VU. Dùng `-Smoke` để chỉ chạy kiểm chứng nhỏ. Script yêu cầu Docker Desktop, SSH/SCP, Node, tar, k6 và Python có Pillow/Matplotlib; server cần Docker Compose, OpenSSL và cổng 18080 trống. Cần đủ thời gian cho bước chuẩn bị, calibration, 40 phút tải và tối đa 15 phút chờ job.

Với smoke ngắn, nếu thiếu duy nhất độ phủ chuỗi VU Prometheus, script ghi cảnh báo và cho phép tiếp tục; `readiness.json` vẫn ghi chưa đủ dữ liệu. Các lỗi monitoring, metadata và coverage khác vẫn chặn lượt chạy. Lượt đo đầy đủ vẫn yêu cầu độ phủ ít nhất 95% và khoảng trống không quá 15 giây.

Nếu API chuyển sang `unhealthy` hoặc tạm thời không còn container, runner ghi cảnh báo và tiếp tục sinh tải; trạng thái health được lưu trong `resources.ndjson`. OOM hoặc container restart vẫn làm dừng lượt đo.

Kết quả nằm trong `.cache/benchmark-results/<run>/measured`, còn hai tệp calibration nằm ngay trong thư mục run. Kết quả, danh sách tài khoản và JWT được giữ dưới `.cache`; không chia sẻ thư mục phiên đăng nhập. Smoke không chứng minh năng lực 10.000 VU. Theo dõi Grafana tại `http://127.0.0.1:3000` khi monitoring đang chạy.

Bộ chạy mô phỏng tối đa **10 admin, 50 manager, 500 staff và 9.440 khách**. Profile đầy đủ tăng tải trong 8 phút, giữ 10.000 VU trong 30 phút và giảm tải trong 2 phút. VU chọn nhận diện cho 5% thao tác; các thao tác còn lại đọc hoặc ghi dữ liệu tương ứng vai trò, nghỉ 2–5 giây. Thời gian chờ job có thể kéo dài sau profile tối đa 15 phút.

Profile `smoke` tạo 1 admin, 1 manager, 2 staff và 6 khách. Smoke chỉ xác minh luồng; không chứng minh năng lực 10k. Mỗi lần chạy gồm preflight, warmup và measured riêng. Preflight kiểm tra các endpoint đã liệt kê trong ngưỡng `business_requests` của kịch bản; nếu một mục bắt buộc không được gọi hoặc một kiểm tra thất bại, runner dừng trước khi đo.

## Chuẩn bị môi trường

1. Dùng stack API/MariaDB/Redis/classifier riêng có cấu hình giống môi trường cần đánh giá. Tạo database mới tên `benchmark_<tên>` và schema bằng `prisma db push`; trỏ API và seed vào chính database đó. Dùng thư mục uploads riêng và mount cùng đường dẫn cho API và seed. Không seed vào database ứng dụng.
2. Cài Node và k6 2.3.0 từ [Grafana releases](https://github.com/grafana/k6/releases/tag/v2.3.0), kiểm tra SHA-256. Python có Pillow được dùng để kiểm tra ảnh; Matplotlib được dùng để vẽ biểu đồ. Nếu thu tài nguyên qua SSH, cài `ssh2` trong `BENCHMARK_TOOLS` như hướng dẫn bên dưới.
3. Chọn một ảnh nấm JPEG/PNG thật, kích thước không quá 5 MiB, có thể giải mã bằng Pillow. Không dùng `dummy.jpg`. Seed chạy trên máy có quyền đọc/ghi thư mục uploads của API; manifest và ảnh cần có đường dẫn khả dụng trên máy chạy k6.

Ví dụ PowerShell, chạy tại thư mục backend; điền thông tin database và vị trí riêng phù hợp:

```powershell
$env:DATABASE_HOST = '127.0.0.1'
$env:DATABASE_PORT = '3306'
$env:DATABASE_USER = 'benchmark'
$env:DATABASE_PASSWORD = '<database password>'
$env:DATABASE_NAME = 'benchmark_mushroom'
$env:BENCHMARK_DATABASE = $env:DATABASE_NAME
$env:BENCHMARK_RUN_ID = 'run0001' # 4–16 ký tự thường hoặc chữ số; dùng ID mới mỗi lần
$env:BENCHMARK_PASSWORD = '<benchmark-only password of at least 12 characters>'
$env:BENCHMARK_UPLOADS_DIR = '<uploads directory mounted by the benchmark API>'
$env:BENCHMARK_IMAGE = '<path to a real mushroom JPEG or PNG>'
$env:BENCHMARK_PYTHON = '<python executable with Pillow>'
$env:BENCHMARK_PROFILE = 'smoke' # bỏ biến này để tạo bộ dữ liệu đầy đủ
node benchmarks/k6/seed.cjs
if ($LASTEXITCODE -ne 0) { throw 'Seed failed; do not start load' }
$env:BASE_URL = 'http://127.0.0.1:8080'
node benchmarks/k6/authenticate.cjs
if ($LASTEXITCODE -ne 0) { throw 'Authentication failed' }
$env:SESSIONS_PATH = (Resolve-Path ".cache/benchmark/$env:BENCHMARK_RUN_ID/sessions.json").Path
$env:K6_PATH = '<path to k6.exe>'
$env:RESULTS_DIR = "benchmarks/results/$env:BENCHMARK_RUN_ID"
$env:BENCHMARK_SOURCE_IP_COUNT = '1' # thay bằng số IP nguồn server thực sự nhìn thấy
$env:API_RATE_LIMIT_MAX = '300' # khai báo đúng cấu hình đang áp dụng trên server
$env:CLASSIFIER_RATE_LIMIT_MAX = '10'
$env:RATE_LIMIT_WINDOW_MS = '60000'
node benchmarks/k6/run-benchmark.cjs
if ($LASTEXITCODE -notin @(0, 99)) { throw 'Benchmark did not complete; inspect logs' }
& $env:BENCHMARK_PYTHON benchmarks/k6/analyze-results.py $env:RESULTS_DIR
```

Seed tạo tài khoản bcrypt, cơ sở, lô, phân công, công việc, ảnh, nhật ký và tài chính với tiền tố của lần chạy. Runner kiểm tra ảnh sinh tải có SHA-256 trùng ảnh đã được seed xác minh. `authenticate.cjs` đăng nhập lần lượt và xác minh `/auth/me`; mặc định cách nhau 350 ms. JWT sống hai giờ: bắt đầu runner trong vòng 20 phút sau xác thực, dành thời gian cho preflight và chờ job. `.cache/benchmark/<run>/sessions.json` chứa JWT; không chia sẻ hoặc commit file này. Mật khẩu và token không được đưa vào kết quả hay metric.

## Rate limit và nguồn tải

`BENCHMARK_MODE=realistic` là mặc định: giữ rate limit server đang dùng, đếm `429` là lỗi và phân loại riêng. Người dùng khách từ cùng một IP cùng chia sẻ quota. Lượt đầy đủ yêu cầu khai báo số IP nguồn server nhìn thấy bằng `BENCHMARK_SOURCE_IP_COUNT`; kiểm tra cả NAT/proxy trước khi khai báo. `BENCHMARK_SOURCE_IPS` tùy chọn chuyển sang k6 `--local-ips`; IP phải thực sự tồn tại và được định tuyến tới server. Không giả mạo `X-Forwarded-For`.

Lượt đầy đủ ở chế độ `realistic` yêu cầu khai báo `API_RATE_LIMIT_MAX`, `CLASSIFIER_RATE_LIMIT_MAX` và `RATE_LIMIT_WINDOW_MS`. Chế độ `capacity` dùng image benchmark có hai bộ rate limit bị tắt hoàn toàn; không cần khai báo quota lớn. Chọn `BENCHMARK_MODE=capacity`, `BENCHMARK_CAPACITY_CONFIRMED=1` và cấu hình SSH để runner xác minh image thực chạy. Mỗi lượt dùng stack, database và volume benchmark riêng.

```powershell
$env:BENCHMARK_DATABASE = 'benchmark_mushroom'
docker compose --env-file .env.docker -f compose.yaml -f compose.benchmark.yaml config
docker compose --env-file .env.docker -f compose.yaml -f compose.benchmark.yaml up -d --build
$env:BENCHMARK_COMPOSE_PROJECT = 'dacs-mushroom-benchmark'
```

Target production vẫn là mặc định; benchmark chỉ được chọn khi dùng overlay trên. Đặt `DATABASE_NAME` bằng `BENCHMARK_DATABASE` khi seed. Không dùng overlay với stack production.

Giới hạn mặc định API là 300 yêu cầu/phút và classifier 10 yêu cầu/phút theo user hoặc IP khách. Từ một IP, kết quả realistic có thể chủ yếu phản ánh rate limit; cần các IP nguồn thực hoặc dùng thêm chế độ capacity để quan sát dịch vụ phía sau. Lưu lượng 5% nhận diện có thể vượt năng lực classifier mặc định chỉ một worker; kết quả báo job thành công, lỗi và timeout, không mặc định coi `202` là thành công cuối.

## Grafana và thu tài nguyên

Dashboard chạy tùy chọn trên máy sinh tải:

```powershell
$env:GRAFANA_BENCHMARK_PASSWORD = '<unique local dashboard password>'
docker compose -f benchmarks/k6/monitoring/compose.yaml up -d
$env:K6_PROMETHEUS_RW_SERVER_URL = 'http://127.0.0.1:9090/api/v1/write'
```

Mở `http://127.0.0.1:3000`, đăng nhập user `benchmark`. Prometheus và Grafana chỉ bind loopback. Chỉ số k6 dùng nhãn vai trò, endpoint và trạng thái, không dùng username, token hay job ID. Việc bỏ `K6_PROMETHEUS_RW_SERVER_URL` vẫn tạo báo cáo cục bộ.

Lượt đầy đủ yêu cầu Prometheus, Grafana và sampler qua SSH. Cài `ssh2@1.17.0` vào `BENCHMARK_TOOLS`, kiểm tra host key và lưu vào `<BENCHMARK_TOOLS>/known_hosts`, rồi đặt `SSH_HOST`, `SSH_PORT`, `SSH_USER` và một trong `SSH_PRIVATE_KEY`, `SSH_AUTH_SOCK`, `SSH_PASSWORD`. Khóa có mật khẩu dùng thêm `SSH_PASSPHRASE`. Tùy chọn `BENCHMARK_COMPOSE_PROJECT` và `BENCHMARK_REMOTE_REPO` nếu khác `dacs-mushroom` và `/home/loql/dacs_mushroom_backend`. Tài khoản SSH cần Python 3, quyền đọc `/proc` và Docker socket. Máy sinh tải Linux cần quyền đọc `/proc/net/dev` và `/proc/diskstats`; Windows cần quyền đọc các lớp CIM hiệu năng mạng/đĩa. Runner kiểm tra dữ liệu này trước lượt tải đầy đủ. Smoke realistic có thể chạy không SSH; báo cáo ghi thiếu dữ liệu. Sampler chạy đến khi runner dừng, bao gồm thời gian chờ job. Có thể đặt `BENCHMARK_PROMETHEUS_URL` và `BENCHMARK_GRAFANA_URL` nếu monitoring không ở localhost.

```powershell
$env:BENCHMARK_TOOLS = Join-Path $env:TEMP 'dacs-benchmark-tools'
npm install --prefix $env:BENCHMARK_TOOLS --no-audit --no-fund --ignore-scripts ssh2@1.17.0
ssh -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$env:BENCHMARK_TOOLS/known_hosts" <user>@<host> exit
```

## Kết quả và dọn dữ liệu

Thư mục kết quả phải mới hoặc rỗng. Runner tự phân tích bằng `BENCHMARK_PYTHON` (mặc định `python`) sau lượt chạy. Ngoài summary/log, báo cáo gồm `versions.json`, `environment.json`, `readiness.json`, `readiness.md`, `timeseries.json` khi có Prometheus, `checksums.sha256`, `coverage.csv`, `endpoints.csv`, `analysis.json`, `report.md` và biểu đồ nếu có Matplotlib. `readiness.md` tách thông tin thiếu khỏi trạng thái đạt ngưỡng hiệu năng. Metadata được thu từ máy thực chạy; kết quả cũ thiếu thông tin sẽ không được tự suy đoán. Mỗi summary lọc `setup_data`; session không được ghi vào summary.

Nếu summary của k6 bị thiếu nhưng Prometheus vẫn giữ mẫu của lượt chạy, có thể chạy `node benchmarks/k6/recover-prometheus.cjs <RESULTS_DIR>`. Công cụ tạo báo cáo và CSV khôi phục riêng từ counter, đối chiếu counter HTTP và đánh dấu số liệu gần đúng; không suy ra p95/p99 toàn lượt từ các percentile theo từng cửa sổ. Tùy chọn `BENCHMARK_PROMETHEUS_URL` nếu Prometheus không ở localhost.

Để xóa dữ liệu có tiền tố của một lần chạy sau khi dừng tải, dùng cùng biến database, uploads và run ID như lúc seed:

```powershell
$env:BENCHMARK_CLEANUP = $env:BENCHMARK_RUN_ID
node benchmarks/k6/cleanup.cjs
```

Cleanup từ chối nếu người dùng hoặc dữ liệu thuộc phạm vi lần chạy có tham chiếu chéo ngoài cơ sở benchmark. Chỉ chạy cleanup sau khi dừng API và các client khác, để không có thay đổi đồng thời trong lúc kiểm tra. Script xóa các ảnh seed mang tiền tố lần chạy; file upload phát sinh khi chạy và lịch sử classifier khách được giữ lại vì không có nhãn sở hữu lần chạy. Hủy volume của stack benchmark riêng khi không còn cần các dữ liệu đó. Không dùng lệnh cleanup với database hay thư mục uploads dùng chung.
