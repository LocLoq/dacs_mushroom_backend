# Hướng dẫn cho agent tích hợp API vào ứng dụng Flutter

## 1. Mục tiêu và nguồn sự thật

Tích hợp ứng dụng Flutter với backend quản lý nuôi trồng nấm, classifier, báo cáo, audit log và tiến trình sinh trưởng công khai.

Nguồn sự thật của contract API:

- Swagger UI: `http://<backend-host>:8080/api-docs`
- OpenAPI: `swagger.yaml` trong repository backend
- Dữ liệu test: `API_TEST_PARAMS.md`

Flutter **chỉ gọi Node API cổng 8080**. Không gọi trực tiếp Python classifier cổng 8001. Node/Bull chịu trách nhiệm hàng đợi, lưu DB, audit và phát Socket.IO.

Sau khi login, gọi `GET /auth/me` với Bearer token trước khi mở khu vực nội bộ. Response là `{data:{id,username,full_name,role,email,phone_number}}`; `role` là chuỗi `admin`, `manager` hoặc `staff`. Khi nhận `401` và `code=AUTH_INVALID_TOKEN`, xóa phiên và quay lại đăng nhập. `403 AUTH_FORBIDDEN` chỉ biểu thị thiếu quyền, không xóa phiên.

## 2. Khởi động backend và tài khoản demo

Chạy trọn backend theo [RUN_DOCKER.md](RUN_DOCKER.md): tạo `.env.docker` từ mẫu, thay các khóa/mật khẩu rồi chạy:

```powershell
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 300
```

Compose tạo schema, chạy classifier CPU, Node API, MariaDB và Redis; không tự seed. Database Docker mới cần tạo tài khoản/dữ liệu demo chủ động:

```powershell
docker compose --env-file .env.docker exec -e NODE_ENV=development api npm run db:seed
```

Seed cập nhật tài khoản và tạo lại dữ liệu demo; chỉ chạy khi cần. Với môi trường đã cài Node/Python/DB/Redis trực tiếp, xem [RUN_BACKEND.md](RUN_BACKEND.md) và khởi động bằng `$env:SKIP_SEED = '1'` rồi `npm run start:stack` để giữ dữ liệu đang dùng. Bảng dưới là tài khoản sau khi chạy seed với mật khẩu mặc định:

| Role | Username | Password |
| --- | --- | --- |
| Admin | `demo_admin` | `Demo@12345` |
| Manager | `demo_manager` | `Demo@12345` |
| Staff | `demo_staff` | `Demo@12345` |

## 3. Base URL theo môi trường Flutter

Truyền URL bằng `--dart-define`, không hard-code vào feature:

```bash
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api
```

| Thiết bị | URL thường dùng |
| --- | --- |
| Android Emulator | `http://10.0.2.2:8080/api` |
| iOS Simulator | `http://127.0.0.1:8080/api` |
| Flutter Desktop cùng máy | `http://127.0.0.1:8080/api` |
| Điện thoại thật | `http://<LAN-IP-của-máy-chạy-backend>:8080/api` |

Android development dùng HTTP có thể cần cho phép cleartext traffic trong cấu hình debug. Production phải dùng HTTPS.

```dart
abstract final class ApiConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:8080/api',
  );

  static String get serverOrigin =>
      Uri.parse(apiBaseUrl).replace(path: '').toString().replaceAll(RegExp(r'/$'), '');

  static String absoluteMediaUrl(String? value) {
    if (value == null || value.isEmpty) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    return '$serverOrigin${value.startsWith('/') ? value : '/$value'}';
  }
}
```

Các URL `/uploads/...` là URL tương đối theo server origin, không nối thêm `/api`.

Web client phải được thêm vào biến môi trường backend `CORS_ALLOWED_ORIGINS` (các origin cách nhau bằng dấu phẩy). Backend cho phép `Authorization`, `Content-Type` và expose `Content-Disposition` để web đọc tên file xuất báo cáo.

## Dashboard công việc

Gọi `GET /dashboard/tasks` cho cả ba role. Mặc định response phân trang chỉ gồm `TODO` và `IN_PROGRESS`, sắp xếp theo hạn gần nhất; dùng `status=ALL` để xem lịch sử. Mỗi item có `batchCode` và `assignee` có thể `null` khi chưa liên kết/giao việc.

Admin và manager gọi `POST /dashboard/tasks`, `PATCH /dashboard/tasks/:id`, `DELETE /dashboard/tasks/:id` và `GET /dashboard/task-assignees`. Staff chỉ PATCH `{ "status": "TODO" | "IN_PROGRESS" | "COMPLETED" }` cho việc mở đang được giao cho mình. Không hiển thị thao tác hủy/mở lại/xóa cho staff.

## 4. Cấu trúc Flutter đề xuất

Ưu tiên tái sử dụng networking/state-management đang có trong app. Nếu app chưa có cấu trúc, dùng hướng sau:

```text
lib/
  core/
    network/
      api_config.dart
      api_client.dart
      api_exception.dart
      auth_interceptor.dart
    storage/
      token_storage.dart
  features/
    auth/
    users/
    mushrooms/
    facilities/
    cultivation_batches/
    classifier/
    reports/
    audit_logs/
    public_growth/
```

Có thể dùng HTTP client, secure storage và Socket.IO package hiện có của dự án. Nếu chọn Dio, đặt toàn bộ cấu hình base URL, timeout, Authorization và mapping lỗi trong một client chung.

## 5. Xác thực và phân quyền

### Đăng nhập

```http
POST /api/login
Content-Type: application/json
```

```json
{
  "username": "demo_admin",
  "password": "Demo@12345"
}
```

Response thành công:

```json
{
  "message": "Login successful",
  "token": "<jwt>"
}
```

- Lưu token bằng secure storage, không dùng SharedPreferences cho token production.
- Gửi `Authorization: Bearer <token>` cho endpoint protected.
- Không log token, password hoặc header Authorization.
- `401`: chưa có token; điều hướng về đăng nhập.
- `403`: token sai/hết hạn/bị thu hồi hoặc role không đủ quyền; xóa token nếu lỗi xác thực, nhưng chỉ hiển thị “không có quyền” nếu token hợp lệ và role bị chặn.

Quyền chính:

| Chức năng | Admin | Manager | Staff | Public |
| --- | --- | --- | --- | --- |
| Quản lý user/role | Có | Không | Không | Không |
| CRUD nấm/cơ sở | Có | Có | Chỉ xem | Không |
| Xem/quản lý lô | Có | Có | Theo quyền endpoint | Không |
| Reports/audit/history classifier | Có | Có | Không | Không |
| Gửi ảnh classifier | Có | Có | Có | Có |
| Xem tiến trình bằng batchCode | Có | Có | Có | Có |

## 6. Quy ước response và lỗi

Danh sách có phân trang:

```json
{
  "data": [],
  "pagination": {
    "totalItems": 100,
    "currentPage": 1,
    "totalPages": 5,
    "pageSize": 20
  }
}
```

Chi tiết:

```json
{
  "data": {}
}
```

Mutation thường trả:

```json
{
  "message": "...",
  "data": {}
}
```

Lỗi:

```json
{
  "message": "Thông báo lỗi",
  "error": "Chi tiết tùy chọn"
}
```

Frontend phải chấp nhận `data` hoặc field tùy endpoint theo Swagger. Không cast trực tiếp nullable field thành non-null.

```dart
class ApiException implements Exception {
  final int? statusCode;
  final String message;
  final Object? cause;

  const ApiException(this.message, {this.statusCode, this.cause});
}
```

## 7. Kiểu dữ liệu và enum

Các enum backend gửi dưới dạng chuỗi viết hoa:

```text
Role: admin | manager | staff
BatchStatus: PREPARATION | INCUBATION | FRUITING | HARVESTING | COMPLETED | FAILED
FacilityType: HOUSEHOLD | COOPERATIVE | ENTERPRISE
FacilityStatus: ACTIVE | SUSPENDED | CLOSED
EdibilityStatus: CHOICE | EDIBLE | INEDIBLE | POISONOUS | DEADLY
CultivationDifficulty: EASY | MEDIUM | HARD | UNCULTIVABLE
ClassifierLookupStatus: QUEUED | PROCESSING | SUCCEEDED | FAILED
AuditOutcome: SUCCESS | FAILURE
ReportGroupBy: day | month
ReportFormat: csv | xlsx | pdf
```

Ngày giờ gửi bằng ISO 8601 và parse thành `DateTime`. Khi gửi thời gian mới, dùng `dateTime.toUtc().toIso8601String()`.

Một số field user đang dùng snake_case (`full_name`, `phone_number`, `role_id`, `tokenver`), trong khi domain nuôi trồng chủ yếu dùng camelCase. Model phải map đúng JSON key thực tế.

## 8. Danh sách endpoint cần tích hợp

### Auth và quản trị

```text
POST   /api/login
GET    /api/admin/users?page=1&limit=10&search=
GET    /api/admin/roles
POST   /api/admin/users
PUT    /api/admin/users/{id}
DELETE /api/admin/users/{id}
GET    /api/admin/audit-logs
```

Body tạo user:

```json
{
  "username": "new_user",
  "password": "StrongPassword123",
  "full_name": "Nguyễn Văn A",
  "phone_number": "0900000000",
  "email": "user@example.com",
  "role_id": 3
}
```

### Giống nấm

```text
GET    /api/mushroom-species?page=1&limit=10&search=
POST   /api/mushroom-species
PUT    /api/mushroom-species/{id}
DELETE /api/mushroom-species/{id}
```

### Cơ sở sản xuất

```text
GET    /api/production-facilities?page=1&limit=10&search=
GET    /api/production-facilities/{id}
POST   /api/production-facilities
PUT    /api/production-facilities/{id}
DELETE /api/production-facilities/{id}
```

Field `mushrooms` trong create/update là danh sách ID:

```json
{
  "name": "Trang trại A",
  "address": "Đà Lạt",
  "province": "Lâm Đồng",
  "facilityType": "HOUSEHOLD",
  "status": "ACTIVE",
  "mushrooms": [1, 2]
}
```

### Lô nuôi trồng

```text
GET    /api/cultivation-batches?page=1&limit=10&search=&facilityId=&mushroomId=&status=
GET    /api/cultivation-batches/{id}
POST   /api/cultivation-batches
PUT    /api/cultivation-batches/{id}
DELETE /api/cultivation-batches/{id}
```

### Nhật ký chăm sóc

```text
GET  /api/cultivation-batches/{id}/care-logs
POST /api/cultivation-batches/{id}/care-logs
```

```json
{
  "actionType": "WATERING",
  "notes": "Tưới nước và kiểm tra độ ẩm",
  "recordedAt": "2026-09-23T08:00:00.000Z"
}
```

### Thu hoạch

```text
GET  /api/cultivation-batches/{id}/harvests
POST /api/cultivation-batches/{id}/harvests
```

```json
{
  "totalYieldKg": 15.5,
  "qualityGrade": "A",
  "notes": "Thu hoạch đợt 1",
  "harvestedAt": "2026-09-23T08:00:00.000Z",
  "finalizeBatch": false
}
```

Không tự cộng `actualYieldKg` phía Flutter để làm thống kê. Báo cáo sản lượng của backend lấy từ tổng các `HarvestRecord`.

## 9. Growth progress và đính kèm ảnh

```text
GET   /api/cultivation-batches/{id}/growth-progress
POST  /api/cultivation-batches/{id}/growth-progress
PATCH /api/cultivation-batches/{id}/growth-progress/{recordId}
```

POST/PATCH hỗ trợ `multipart/form-data`:

| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `stage` | text | Bắt buộc khi tạo |
| `notes` | text | Bắt buộc khi tạo |
| `recordedAt` | ISO 8601 text | Tùy chọn |
| `images` | file lặp lại | Tối đa 5 ảnh JPEG/PNG/WebP, mỗi ảnh tối đa 5 MB |

Ví dụ theo kiểu Dio:

```dart
final form = FormData();
form.fields.addAll([
  const MapEntry('stage', 'FRUITING'),
  const MapEntry('notes', 'Đã bắt đầu ra quả thể'),
  MapEntry('recordedAt', DateTime.now().toUtc().toIso8601String()),
]);

for (final file in selectedFiles.take(5)) {
  form.files.add(MapEntry(
    'images',
    await MultipartFile.fromFile(file.path, filename: file.name),
  ));
}

await api.post('/cultivation-batches/$batchId/growth-progress', data: form);
```

Hiển thị ảnh bằng `ApiConfig.absoluteMediaUrl(image.imageUrl)`.

## 10. Public growth progress

Không yêu cầu token:

```http
GET /api/public/cultivation-batches/{batchCode}/growth-progress/current
```

Ví dụ:

```http
GET /api/public/cultivation-batches/DEMO-BATCH-001/growth-progress/current
```

Xử lý hai trường hợp hợp lệ:

- Batch tồn tại và có tiến trình: `data.currentProgress` là object.
- Batch tồn tại nhưng chưa có tiến trình: `data.currentProgress` là `null`.

`404` nghĩa là batchCode không tồn tại. Màn hình public không được phụ thuộc vào ID nội bộ hoặc các field không nằm trong response whitelist.

## 11. Mushroom classifier và Socket.IO

### Gửi ảnh

```http
POST /api/mushroom-classifier/classify
Content-Type: multipart/form-data
```

Field file là `image`. Token là tùy chọn; nếu gửi token sai backend trả lỗi.

Response `202`:

```json
{
  "jobId": "uuid",
  "status": "QUEUED"
}
```

### Theo dõi trạng thái

Socket.IO kết nối tới server origin, ví dụ `http://10.0.2.2:8080`, không phải URL `/api`.

```dart
final socket = io(
  ApiConfig.serverOrigin,
  OptionBuilder()
      .setTransports(['websocket'])
      .disableAutoConnect()
      .enableReconnection()
      .build(),
);

socket.onConnect((_) {
  socket.emit('subscribe_job', jobId);
});

socket.on('processing', (data) {
  // status QUEUED hoặc PROCESSING
});

socket.on('finished', (data) {
  // status SUCCEEDED và data['result']
});

socket.on('failed', (data) {
  // status FAILED; hiển thị thông báo an toàn
});

socket.connect();
```

Backend phát lại trạng thái đã lưu khi subscribe, vì vậy luôn subscribe lại sau reconnect. Đóng listener/socket khi dispose màn hình.

Admin/manager có thể xem lịch sử:

```text
GET /api/mushroom-classifier/history?page=1&limit=20&status=&predictedName=&from=&to=
GET /api/mushroom-classifier/history/{id}
```

## 12. Reports và tải file

Chỉ admin/manager:

```text
GET /api/reports/overview
GET /api/reports/cultivation
GET /api/reports/classifier
GET /api/reports/audit
GET /api/reports/{type}/export
```

Query dùng chung:

| Param | Giá trị |
| --- | --- |
| `from` | Ngày bắt đầu, ví dụ `2024-09-23` |
| `to` | Ngày kết thúc, ví dụ `2026-09-23` |
| `facilityId` | ID cơ sở |
| `mushroomId` | ID giống nấm |
| `status` | Batch status |
| `groupBy` | `day` hoặc `month` |
| `page` | Mặc định `1` |
| `limit` | Mặc định `20`, tối đa `100` |

Export:

```text
type: overview | cultivation | classifier | audit
format: csv | xlsx | pdf
```

Ví dụ:

```http
GET /api/reports/cultivation/export?format=xlsx&from=2024-09-23&to=2026-09-23
```

Khi tải file:

- Yêu cầu client nhận response dạng bytes.
- Lấy tên file từ `Content-Disposition` nếu có.
- Lưu vào thư mục ứng dụng/download phù hợp nền tảng.
- Mở/chia sẻ file bằng package sẵn có của app.
- Hiển thị thông báo yêu cầu thu hẹp filter nếu backend trả `422`.

## 13. Audit log

```http
GET /api/admin/audit-logs
```

Query hỗ trợ:

```text
page
limit
actorUserId
action
entityType
entityId
outcome=SUCCESS|FAILURE
statusCode
from
to
```

Ví dụ:

```http
GET /api/admin/audit-logs?page=1&limit=20&action=LOGIN&outcome=SUCCESS
```

Frontend chỉ đọc audit log; không xây chức năng sửa hoặc xóa.

## 14. Chiến lược state và pagination

- Giữ filter trong một immutable state/query object.
- Khi đổi filter, reset `page=1`.
- Không tải tiếp nếu `currentPage >= totalPages`.
- Hủy hoặc bỏ qua response cũ khi người dùng đổi filter nhanh.
- Dùng loading riêng cho initial load, refresh, load-more và mutation.
- Sau mutation thành công, refresh detail/list liên quan thay vì tự đoán toàn bộ state backend.

## 15. Checklist cho agent Flutter

- [ ] Tạo API client chung với base URL từ `dart-define`.
- [ ] Thêm secure token storage và Authorization interceptor.
- [ ] Mapping thống nhất lỗi `400/401/403/404/422/500/503`.
- [ ] Tạo model nullable-safe theo response Swagger.
- [ ] Tạo auth state và điều hướng theo role.
- [ ] Tích hợp CRUD user, mushroom, facility và batch.
- [ ] Tích hợp care logs, harvests và growth progress multipart.
- [ ] Resolve chính xác URL `/uploads/...`.
- [ ] Tích hợp classifier upload và Socket.IO reconnect/resubscribe.
- [ ] Tích hợp reports JSON, filter, pagination và export bytes.
- [ ] Tích hợp audit-log list/filter chỉ đọc.
- [ ] Tạo màn hình public growth bằng `batchCode`, không yêu cầu auth.
- [ ] Không gọi trực tiếp Python service.
- [ ] Không log password, JWT, ảnh hoặc dữ liệu nhạy cảm.
- [ ] Viết unit test cho JSON mapping, interceptor và query builder.
- [ ] Viết widget/integration test cho login, pagination, upload ảnh, classifier states, report download và public growth.

## 16. Dữ liệu dùng để test nhanh

```text
facilityId: 1
mushroomId: 1
batchId: 1
batchCode: DEMO-BATCH-001
growthProgressRecordId: 1441
harvestBatchId: 66
classifierId: 00000000-0000-4000-8000-000000000001
reportFrom: 2024-09-23
reportTo: 2026-09-23
```

Các batch code demo chạy từ `DEMO-BATCH-001` đến `DEMO-BATCH-100`.
