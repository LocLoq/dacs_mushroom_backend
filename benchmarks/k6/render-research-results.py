"""Update measured result sections only, after analyze-results.py completes."""
import datetime as dt
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'benchmarks/results/2026-10-01-local')
data = json.loads((root / 'analysis.json').read_text(encoding='utf-8'))
metadata = json.loads((root / 'metadata.json').read_text(encoding='utf-8'))
document = Path('NGHIEN_CUU_KHOA_HOC.md')
artifact_path = root.as_posix()


def local_time(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(
        dt.timezone(dt.timedelta(hours=7))).strftime('%H:%M:%S ngày %d/%m/%Y')


def interval(value):
    return '%.2f [%.2f–%.2f]' % (value['median'], value['min'], value['max'])


lines = [
    '### 4.6. Kết quả thực nghiệm ngày 01/10/2026', '',
    '#### 4.6.1. Điều kiện và cách đo', '',
    f'Thực nghiệm diễn ra từ **{local_time(metadata["baseline_started_at"])}** đến **{local_time(metadata["finished_at"])}** (UTC+7). Backend truy cập tại `http://172.23.87.58:8080`; k6 v2.3.0 chạy trên Windows, tài nguyên server Debian được thu thập đồng thời qua SSH.', '',
    '- API đo: `GET /api/cultivation-batches?page=1&limit=10`, trên **100 lô** được xác nhận qua `pagination.totalItems` trước mỗi lượt.',
    '- Mỗi mức 10, 25, 50, 100 VU chạy **3 lượt × 60 giây**, nghỉ **1 giây/vòng lặp** và **5 giây giữa các lượt**. Trước đo có baseline 15 giây và khởi động 1 VU × 60 giây.',
    '- Đăng nhập một lần bằng tài khoản manager trong `setup()` của mỗi lượt; các VU tái sử dụng cùng JWT. Kiểm tra HTTP 200, số phần tử, trang hiện tại, kích thước trang và tổng số lô.',
    '- Độ trễ, tỷ lệ lỗi và checks lọc theo `phase:business`; đăng nhập/probe không nằm trong các chỉ số này. RPS lấy từ `business_requests`, chia cho thời gian thực chạy do k6 cung cấp, gồm thời gian kết thúc các vòng lặp còn lại.',
    '- CPU/RAM lấy khoảng 1 giây/mẫu bằng `/proc` và Docker Engine API. Cửa sổ tài nguyên bao phủ từ trước khi khởi tạo k6 đến khi k6 thoát, gồm setup và graceful drain; không gồm khoảng nghỉ giữa các lượt.',
    f'- Server chậm hơn đồng hồ client khoảng **{abs(metadata["clock_offset_ms"])/1000:.3f} giây** tại đầu phép đo; cửa sổ tài nguyên đã hiệu chỉnh độ lệch này. Độ bất định ước lượng từ nửa thời gian trao đổi metadata là **{metadata["clock_uncertainty_ms"]:.1f} ms**.',
    '- Source trên server và client cùng commit `b16574252f97c12dc83ef70af8020c2de928849a`. Không seed lại hoặc đổi cấu hình backend trong quá trình đo. Các digest image và trạng thái container trước/sau nằm trong metadata.', '',
    f'Bộ chạy và hướng dẫn tái lập: [benchmarks/k6/README.md](benchmarks/k6/README.md). Dữ liệu gốc: [metadata.json]({artifact_path}/metadata.json), [resources.ndjson]({artifact_path}/resources.ndjson), [JSON/log từng lượt]({artifact_path}/), [runs.csv]({artifact_path}/runs.csv); kết quả tổng hợp: [analysis.json]({artifact_path}/analysis.json).', '',
    '#### 4.6.2. Độ trễ, thông lượng và tỷ lệ lỗi', '',
    'Bảng dùng **trung vị của thống kê 3 lượt**, kèm **[nhỏ nhất–lớn nhất]**. Ví dụ, p95 trong bảng là trung vị của ba p95 riêng, không phải phân vị gộp của toàn bộ request. Lỗi là giá trị lớn nhất và checks là giá trị nhỏ nhất giữa ba lượt.', '',
    '| API/kịch bản | Số lô | VU | Thời lượng | p50 (ms) | p95 (ms) | p99 (ms) | Request/s | Lỗi (%) | Checks đạt (%) | Kết luận |',
    '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
]
for group in data['groups']:
    ok = all(r['thresholds_passed'] for r in data['runs'] if r['vus'] == group['vus'])
    lines.append('| Danh sách lô | 100 | %s | 3 × 60 giây | %s | %s | %s | %s | %.2f | %.2f | %s |' % (
        group['vus'], interval(group['p50_ms']), interval(group['p95_ms']), interval(group['p99_ms']),
        interval(group['requests_per_s']), group['http_errors_pct']['max'], group['checks_passed_pct']['min'],
        'Đạt cả 3 lượt' if ok else 'Có lượt không đạt'))

highest = data['groups'][-1]
passed = sum(r['thresholds_passed'] for r in data['runs'])
lines += ['', f'Tổng cộng **{data["total_business_requests"]:,} request nghiệp vụ** trong 12 lượt đo chính; **{passed}/12 lượt đạt ngưỡng** p95 < 500 ms, p99 < 1.000 ms, lỗi < 1% và checks ≥ 99%. Lượt khởi động và các request setup không được cộng vào tổng request nghiệp vụ.', '',
          '#### 4.6.3. CPU và RAM thu thập qua SSH', '',
          'CPU/RAM là **trung bình / cực đại** của các mẫu trong ba cửa sổ đo ở mỗi mức VU. RAM dùng MiB (1 MiB = 1.048.576 byte). RAM toàn máy ảo = `MemTotal - MemAvailable`; RAM container = working set theo [quy ước Docker](https://docs.docker.com/reference/cli/docker/container/stats/) (`usage - inactive_file`). Hai cách tính có phạm vi khác nhau, không cộng RAM container để thay cho RAM toàn máy ảo. CPU container được chuẩn hóa theo một lõi; máy ảo có 1 CPU logic.', '',
          '| VU | CPU máy ảo TB / max (%) | RAM máy ảo TB / max (MiB) | Số mẫu máy ảo |',
          '| ---: | ---: | ---: | ---: |']
for group in data['groups']:
    value = group['resources']['host']
    lines.append('| %s | %.2f / %.2f | %.2f / %.2f | %s |' % (
        group['vus'], value['cpu_percent']['mean'], value['cpu_percent']['max'],
        value['memory_mib']['mean'], value['memory_mib']['max'], value['samples']))
lines += ['', '| VU | Container | CPU TB / max (%) | RAM TB / max (MiB) |',
          '| ---: | --- | ---: | ---: |']
for group in data['groups']:
    for service in ('api', 'db', 'redis', 'classifier'):
        value = group['resources'][service]
        lines.append('| %s | %s | %.2f / %.2f | %.2f / %.2f |' % (
            group['vus'], service, value['cpu_percent']['mean'], value['cpu_percent']['max'],
            value['memory_mib']['mean'], value['memory_mib']['max']))
baseline = data['baseline']['host']
lines += ['', 'Baseline 15 giây có sampler hoạt động, trước khi sinh tải: CPU máy ảo trung bình **%.2f%%**, RAM trung bình **%.2f MiB**, swap dùng trung bình **%.2f MiB**. Có **%s lỗi thu thập tài nguyên**; chu kỳ lấy mẫu host trung bình **%.3f giây**, lớn nhất **%.3f giây**. Chi phí sampler nằm trong CPU toàn máy ảo và chưa được tách riêng.' % (
    baseline['cpu_percent']['mean'], baseline['memory_mib']['mean'], baseline['swap_mib']['mean'],
    data['resource_errors'], data['sample_interval_s']['mean'], data['sample_interval_s']['max']), '',
    '#### 4.6.4. Chi tiết ba lần lặp', '',
    '| Lượt | VU | Request nghiệp vụ | p95 (ms) | p99 (ms) | Request/s | CPU máy ảo TB / max (%) | RAM máy ảo TB / max (MiB) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for row in data['runs']:
    lines.append('| %s | %s | %s | %.2f | %.2f | %.2f | %.2f / %.2f | %.2f / %.2f |' % (
        row['run'], row['vus'], row['business_requests'], row['p95_ms'], row['p99_ms'], row['requests_per_s'],
        row['host_cpu_mean_pct'], row['host_cpu_max_pct'], row['host_ram_mean_mib'], row['host_ram_max_mib']))
lines += ['', '#### 4.6.5. Nhận xét và giới hạn', '',
    'Trong phạm vi đã đo, mức cao nhất được kiểm chứng là **100 VU**, với thông lượng trung vị **%.2f request/giây**, p95 trung vị **%.2f ms** và p99 trung vị **%.2f ms**. Vì mỗi VU nghỉ 1 giây/vòng, đây là kết quả của mô hình tải đóng có thời gian nghỉ, chưa phải thông lượng cực đại của backend.' % (
        highest['requests_per_s']['median'], highest['p95_ms']['median'], highest['p99_ms']['median']), '',
    'Ở 100 VU, CPU máy ảo trung bình **%.2f%%**, cực đại **%.2f%%**; RAM trung bình **%.2f MiB**, cực đại **%.2f MiB** trên tổng **1.908,54 MiB**. Phân bố CPU theo API/database và các đỉnh theo thời gian được trình bày trong Hình 8. Đỉnh CPU một giây không tự chứng minh bão hòa kéo dài hoặc xác định điểm nghẽn; cần đo tải cao hơn và phân tích truy vấn để kết luận.' % (
        highest['resources']['host']['cpu_percent']['mean'], highest['resources']['host']['cpu_percent']['max'],
        highest['resources']['host']['memory_mib']['mean'], highest['resources']['host']['memory_mib']['max']), '',
    'Các kết luận chỉ áp dụng cho API đọc cùng một trang trên bộ 100 lô, cùng tài khoản và cấu hình hiện tại. Thời lượng 60 giây/lượt chưa kiểm chứng ổn định 5 phút/lượt hoặc dài hạn, rò rỉ bộ nhớ, tải ghi/báo cáo, ảnh/classifier, tập dữ liệu 1.000–10.000 lô hay mức trên 100 VU. Mô hình tải này cũng có thể hưởng lợi từ cache của database khi đọc lặp lại cùng dữ liệu. Client ở ngoài máy ảo nhưng có thể chia sẻ phần cứng vật lý; kết quả không đại diện cho triển khai trên hai máy vật lý độc lập.', '',
    '### 4.7. Biểu đồ minh chứng từ dữ liệu đo', '',
    '**Hình 7. Độ trễ và thông lượng k6: client Windows, backend Debian**', '',
    f'![Độ trễ p95/p99 và thông lượng theo VU]({artifact_path}/performance.png)', '',
    'Điểm biểu diễn trung vị của ba lượt; thanh sai số thể hiện nhỏ nhất–lớn nhất. Số liệu lấy từ JSON summary của k6, chỉ tính request nghiệp vụ.', '',
    '**Hình 8. CPU/RAM máy ảo và các container trong cùng quá trình benchmark**', '',
    f'![CPU và RAM lấy mẫu qua SSH trong quá trình chạy k6]({artifact_path}/resources.png)', '',
    'Chuỗi thời gian được thu thập khoảng 1 giây/mẫu. Vùng nền đánh dấu nhóm tải 10, 25, 50, 100 VU và bao gồm khoảng nghỉ 5 giây giữa ba lượt để dễ quan sát; bảng tài nguyên chỉ tính trong cửa sổ từng lượt. RAM classifier là tài nguyên của dịch vụ đang thường trực, không phải RAM suy luận được benchmark.', '',
    f'Biểu đồ được tạo bằng Matplotlib từ dữ liệu gốc; không phải ảnh chụp console. Xem [manifest SHA-256]({artifact_path}/sha256.json) để đối chiếu các artifact, và [summary.md]({artifact_path}/summary.md) để đọc bảng tổng hợp độc lập.', '',
]
existing = document.read_text(encoding='utf-8')
marker = '### 4.6.'
if marker not in existing:
    raise RuntimeError('Cannot locate research results section')
document.write_text(existing.split(marker, 1)[0] + '\n'.join(lines), encoding='utf-8')
print('Updated', document)
