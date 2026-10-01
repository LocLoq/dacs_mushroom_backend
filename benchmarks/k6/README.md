# Benchmark k6 và tài nguyên server

Bộ script đo `GET /api/cultivation-batches?page=1&limit=10`: đăng nhập một lần/lượt, tái sử dụng JWT, kiểm tra HTTP 200 và dữ liệu/phân trang, nghỉ 1 giây/vòng lặp. Mặc định chạy 10, 25, 50, 100 VU, mỗi mức 3 lượt × 60 giây; trước đó lấy baseline 15 giây và khởi động 1 VU × 60 giây. Mỗi lượt cách nhau 5 giây. Thời gian graceful stop dùng mặc định k6.

`run-benchmark.cjs` chạy k6 trên Windows và truyền `collect-resources.py` qua SSH stdin. Sampler chỉ đọc `/proc` và Docker Engine API; không cài gói, tạo file hoặc thay đổi dịch vụ trên server. Tài khoản SSH cần chạy được `python3` và đọc Docker socket. Sampler kết thúc cùng phiên SSH và có giới hạn dự phòng 30 phút. Nếu dùng trên hệ thống khác, cập nhật tên Compose project `dacs-mushroom` và đường dẫn repo server trong sampler.

## Chuẩn bị trên máy sinh tải

Lần đo ngày 01/10/2026 dùng k6 **v2.3.0**, Node **v24.13.0**, thư viện SSH `ssh2` **1.17.0**, Python **3.13** và Matplotlib **3.11.1** cho biểu đồ. Tải ZIP k6 chính thức từ [Grafana k6 Releases](https://github.com/grafana/k6/releases/tag/v2.3.0), đối chiếu SHA-256 với file checksums cùng release và giải nén vào thư mục tạm. Không cần cài k6 toàn hệ thống.

```powershell
$taskTools = Join-Path $env:TEMP 'dacs-benchmark-tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
npm install --prefix $taskTools --no-audit --no-fund --ignore-scripts ssh2@1.17.0
# Thiết lập đường dẫn executable sau khi tải/kiểm tra checksum/giải nén k6.
$env:K6_PATH = Join-Path $taskTools 'k6-v2.3.0-windows-amd64\k6.exe'
$env:BENCHMARK_TOOLS = $taskTools
# Kết nối lần đầu để kiểm tra host key và lưu known_hosts riêng cho lần đo.
ssh -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$taskTools/known_hosts" loql@172.23.87.58 exit
```

Host key được pin theo `known_hosts` đã tạo bằng OpenSSH. Cấu hình host/cổng/tài khoản phù hợp với máy thực tế.

## Chạy và phân tích

```powershell
$env:SSH_HOST = '172.23.87.58'
$env:SSH_PORT = '22'
$env:SSH_USER = 'loql'
$sshCredential = Read-Host 'SSH password' -AsSecureString
$env:SSH_PASSWORD = [System.Net.NetworkCredential]::new('', $sshCredential).Password
$env:BASE_URL = 'http://172.23.87.58:8080'
$env:TEST_USER = 'demo_manager'
$apiCredential = Read-Host 'API test password' -AsSecureString
$env:TEST_PASSWORD = [System.Net.NetworkCredential]::new('', $apiCredential).Password
$env:RESULTS_DIR = 'benchmarks/results/<ma-lan-do-moi>'
try {
    node benchmarks/k6/run-benchmark.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Benchmark execution incomplete; inspect logs' }
} finally {
    Remove-Item Env:SSH_PASSWORD, Env:TEST_PASSWORD -ErrorAction SilentlyContinue
}
python benchmarks/k6/analyze-results.py $env:RESULTS_DIR
python benchmarks/k6/render-research-results.py $env:RESULTS_DIR
```

Python phân tích cần Matplotlib. `RESULTS_DIR` phải là thư mục mới để giữ nguyên kết quả cũ. Ngưỡng thất bại (k6 exit 99) vẫn được lưu và các lượt tiếp theo tiếp tục chạy; lỗi thực thi khác làm bộ chạy dừng.

Sampler ghi timestamp server; `clock_offset_ms`/`clock_uncertainty_ms` trong metadata dùng để quy đổi cửa sổ lượt chạy từ đồng hồ client. CPU/RAM bao phủ toàn cửa sổ từ trước khởi tạo k6 đến khi k6 thoát, gồm đăng nhập, probe dữ liệu và graceful drain; độ trễ/lỗi/checks chỉ lọc `phase:business`. RPS là counter `business_requests`, loại đăng nhập/probe, với mẫu số thời gian thực chạy do k6 cung cấp.

Phân tích sử dụng trung vị và min/max của thống kê từng lượt, không coi trung vị của ba p95 là p95 gộp của toàn bộ request. Tài nguyên là trung bình và cực đại các mẫu khoảng 1 giây trong ba cửa sổ đo. Host RAM = `MemTotal - MemAvailable`; RAM container = Docker working set (`usage - inactive_file`), có thể khác tổng RAM máy ảo. CPU container chuẩn hóa theo một lõi; server lần đo này có 1 CPU logic. Sampler cũng lưu swap, I/O wait và steal time của host.

Kết quả gồm metadata, JSON/log từng lượt, `resources.ndjson`, `runs.csv`, `analysis.json`, `summary.md`, hai biểu đồ PNG và manifest SHA-256. JWT trong dữ liệu `setup()` được loại khỏi summary; bước phân tích cũng lọc dữ liệu xác thực khỏi các log/summary cũ trước khi tạo manifest.

Lần đo này chỉ đánh giá API đọc một trang trên bộ 100 lô. Chạy 60 giây/lượt không thay thế đánh giá 5 phút/lượt, tải hỗn hợp, ảnh/classifier, database lớn hoặc chạy dài. Client nằm ngoài máy ảo backend; hai môi trường có thể chia sẻ máy vật lý nên không coi đây là kiểm chứng trên hai máy vật lý độc lập.

## Kết quả đã thu thập

- [Lần đo 01/10/2026](../results/2026-10-01-local/summary.md)
- [Dữ liệu chi tiết 12 lượt](../results/2026-10-01-local/runs.csv)
- [Tài liệu nghiên cứu](../../NGHIEN_CUU_KHOA_HOC.md)

Định dạng summary dùng `--new-machine-readable-summary=false` theo k6 v2.3.0. Tham khảo [custom summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/), [metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/) và [thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
