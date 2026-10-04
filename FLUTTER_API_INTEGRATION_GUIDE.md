# Hướng dẫn cho agent tích hợp API vào ứng dụng Flutter

## 1. Mục tiêu và nguồn sự thật

Tích hợp ứng dụng Flutter với backend quản lý nuôi trồng nấm, công việc có minh chứng/duyệt, tài chính theo lô, gallery, classifier, báo cáo, audit log và tiến trình sinh trưởng công khai.

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

Gọi `GET /dashboard/tasks` cho cả ba role. Mặc định response phân trang gồm `TODO`, `IN_PROGRESS`, `PENDING_REVIEW`, sắp xếp theo hạn gần nhất; dùng `status=ALL` để xem lịch sử. Mỗi item có `batchCode` và `assignee` có thể `null` khi chưa liên kết/giao việc. Danh sách trả `submissions` gồm tối đa một lần gửi gần nhất (bản tóm tắt); `GET /dashboard/tasks/{id}` trả toàn bộ lịch sử kèm snapshot `evidence` và `notes`. Không dùng response list để hiển thị nội dung minh chứng.

Admin và manager gọi `POST /dashboard/tasks`, `PATCH /dashboard/tasks/:id`, `DELETE /dashboard/tasks/:id` và `GET /dashboard/task-assignees`. Staff chỉ PATCH `{ "status": "TODO" | "IN_PROGRESS" }` cho việc mở đang được giao cho mình. Không PATCH trực tiếp sang `COMPLETED` hoặc `PENDING_REVIEW` với bất kỳ role nào. Việc đã có lịch sử minh chứng không xóa được (`409`); manager/admin dùng hủy và có thể mở lại bằng `IN_PROGRESS`.

Luồng UI hoàn thành công việc:

1. Người được giao tạo/cập nhật nhật ký chăm sóc, sinh trưởng hoặc thu hoạch qua API hiện có. Backend tự gán `createdByUserId`/`updatedByUserId`; không gửi hai field này từ Flutter.
2. Gọi `GET /dashboard/tasks/{id}/evidence-candidates?page=1&limit=10&type=GROWTH_PROGRESS`. `type` tùy chọn: `CARE_LOG`, `GROWTH_PROGRESS`, `HARVEST`. Các item `{ type, recordId, record }` đã được backend lọc theo người thực hiện và lô của task. Chỉ người được giao được gọi API này.
3. Cho người dùng chọn ít nhất một hành động, tối đa 20, rồi gọi API gửi minh chứng:

```dart
await api.post('/dashboard/tasks/$taskId/submissions', data: {
  'evidence': selectedEvidence.map((item) => {
    'type': item.type,
    'recordId': item.recordId,
  }).toList(),
  'notes': submissionNotes,
});
```

4. Refresh task. Hiển thị `PENDING_REVIEW` là “Chờ duyệt”; khóa nút gửi lại. Chưa tính vào số việc hoàn thành.
5. Manager/admin xem chi tiết và snapshot của lần gửi `PENDING`. Hiển thị “Duyệt” và “Trả lại”; ẩn cả hai nếu `submittedByUserId` bằng ID tài khoản hiện tại. Duyệt gọi:

```dart
await api.post(
  '/dashboard/tasks/$taskId/submissions/$submissionId/review',
  data: {'decision': 'APPROVE'},
);
```

6. Trả lại gửi `{ 'decision': 'REJECT', 'reason': reason }`, yêu cầu lý do không rỗng. Task về `IN_PROGRESS`; hiển thị lý do, cho nhân viên bổ sung nhật ký và gửi lần mới. Chỉ `COMPLETED` được tính hoàn thành.

Không cho manager/admin đổi lô hoặc người nhận khi task đang chờ duyệt; dùng trả lại hoặc hủy trước. Khi nhận `409 STATE_CONFLICT`, tải lại chi tiết và thông báo trạng thái đã thay đổi; không tự động gửi lại quyết định cũ. Giữ lịch sử `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`; đọc minh chứng từ snapshot trong submission để hiển thị đúng nội dung đã gửi.

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

Khi tạo/PUT cơ sở, giống nấm hoặc lô, chỉ gửi các field nghiệp vụ của form. Không gửi lại toàn bộ JSON detail: `id`, timestamps, `coverImageUrl`, `imageCount` và các quan hệ gallery/tài chính/công việc không phải field ghi qua API CRUD này.

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
GET /api/reports/financial
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
type: overview | cultivation | classifier | audit | financial
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
- [ ] Mapping thống nhất lỗi `400/401/403/404/409/422/500/503`.
- [ ] Tạo model nullable-safe theo response Swagger.
- [ ] Tạo auth state và điều hướng theo role.
- [ ] Tích hợp CRUD user, mushroom, facility và batch.
- [ ] Tích hợp care logs, harvests và growth progress multipart.
- [ ] Tích hợp chọn minh chứng, gửi chờ duyệt, duyệt/trả lại và lịch sử snapshot; không hoàn thành task qua PATCH.
- [ ] Tích hợp chi phí, bán hàng và lời/lỗ chỉ dành cho manager/admin; giữ tiền dưới dạng chuỗi.
- [ ] Tích hợp gallery của cơ sở/giống/lô, ảnh bìa và quyền manager/admin quản lý.
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

## 17. Tài chính trong chi tiết lô

Chỉ tạo tab tài chính và nút nhập chi phí/bán hàng cho `manager`/`admin`. Staff vẫn ghi thu hoạch bình thường. Contract đầy đủ và ví dụ response nằm trong [NEW_API_DOCUMENTATION.md](NEW_API_DOCUMENTATION.md#7-chi-phí-bán-hàng-và-lờilỗ).

```text
GET/POST     /cultivation-batches/{id}/expenses
PATCH/DELETE /cultivation-batches/{id}/expenses/{expenseId}
GET/POST     /cultivation-batches/{id}/sales
PATCH/DELETE /cultivation-batches/{id}/sales/{saleId}
GET          /cultivation-batches/{id}/financial-summary
```

GET expenses/sales dùng `page`, `limit` (mặc định 10, tối đa 50), response `{data,pagination}`. Tạo trả `201`, sửa trả `200`, `{message,data}`; xóa trả `{message}`. Sửa chỉ gửi các field thay đổi. Tạo khoản chi:

```dart
await api.post('/cultivation-batches/$batchId/expenses', data: {
  'name': 'Phân bón đợt 1',
  'category': 'FERTILIZER',
  'quantity': '2.500',
  'unit': 'kg',
  'unitPrice': '100000.00',
  'incurredAt': selectedDate.toUtc().toIso8601String(),
  'notes': expenseNotes,
});
```

Nhóm chi phí hiển thị: `MATERIAL` → Vật tư, `TOOL` → Dụng cụ, `FERTILIZER` → Phân bón, `OTHER` → Khác. Tạo lần bán:

```dart
await api.post('/cultivation-batches/$batchId/sales', data: {
  'quantityKg': '12.500',
  'unitPrice': '80000.00',
  'soldAt': selectedDate.toUtc().toIso8601String(),
  'buyer': buyerName,
  'notes': saleNotes,
});
```

Giữ `unitPrice`, `amount`, các chỉ số tiền dưới dạng `String` trong DTO; số lượng của expense/sale cũng trả chuỗi Decimal. Đừng ép DTO tiền thành `int`/`double` hoặc tự nhân tiền để thay số backend. Gửi chuỗi thập phân có dấu chấm, không có dấu phân nhóm hoặc ký hiệu ₫. Backend yêu cầu số lượng dương, tối đa 3 chữ số thập phân; đơn giá không âm, tối đa 2 chữ số. Không gửi `amount`, `batchId` trong body hay metadata người tạo/người sửa.

`financial-summary` trả `{data:{batchId,currency,totalHarvestKg,totalSoldKg,revenue,totalCost,profit,costsByCategory,profitMarginPercent,costPerHarvestKg}}`. Hai tổng kg là JSON number; tiền/tỷ suất/chi phí mỗi kg là chuỗi, hai chỉ số chia có thể null. Hiển thị null bằng “Chưa có dữ liệu”, lợi nhuận âm là lỗ. Summary dùng toàn bộ vòng đời lô và tổng các nhật ký thu hoạch. Refresh sau mọi tạo/sửa/xóa chi phí, lần bán hoặc thu hoạch.

`GET /reports/financial` dùng các filter báo cáo hiện có, trả `{data,summary,series,period,pagination}`. Tổng/biểu đồ cấp báo cáo tính toàn bộ filter; không cộng các dòng của trang hiện tại. Series gồm `{period,revenue,totalCost,profit}`; nhóm ngày/tháng theo UTC+7. Báo cáo theo ngày bán/ngày chi/ngày thu hoạch trong kỳ, có thể gồm lô bắt đầu trước kỳ; không so trực tiếp tổng theo kỳ với summary toàn vòng đời. Export dùng `type=financial`, `format=csv|xlsx|pdf`.

Phiên bản này tính lời/lỗ từ lần bán và khoản chi đã ghi, chưa quản lý tồn kho, công nợ, thuế hoặc khấu hao.

## 18. Gallery cơ sở, giống nấm và lô

List/detail của ba resource trả thêm `coverImageUrl: String?`, `imageCount: int`. Có thêm `GET /mushroom-species/{id}`. Dùng ảnh bìa cho thẻ danh sách; gọi API gallery khi mở chi tiết, không cần tải toàn bộ ảnh cho mỗi thẻ.

```text
GET/POST     /production-facilities/{id}/images
PATCH/DELETE /production-facilities/{id}/images/{imageId}
GET/POST     /mushroom-species/{id}/images
PATCH/DELETE /mushroom-species/{id}/images/{imageId}
GET/POST     /cultivation-batches/{id}/images
PATCH/DELETE /cultivation-batches/{id}/images/{imageId}
```

Mọi role xem gallery. Chỉ manager/admin thấy nút tải ảnh, sửa chú thích, chọn bìa và xóa. GET phân trang với `page`, `limit` tối đa 50; thứ tự ảnh bìa trước, sau đó thời gian tải/ID tăng dần. DTO ảnh: `id`, khóa đối tượng tương ứng, `imageUrl`, `originalName`, `mimeType`, `fileSize`, `caption: String?`, `isCover: bool`, `uploadedByUserId: int?`, `createdAt`.

Upload bằng Dio, `resource` là một trong ba tên resource trên:

```dart
final form = FormData();
form.fields.add(MapEntry('caption', caption));
for (final filePath in selectedFilePaths) {
  form.files.add(MapEntry(
    'images',
    await MultipartFile.fromFile(filePath),
  ));
}
await api.post('/$resource/$entityId/images', data: form);
```

Kiểm tra 1–5 ảnh/lần, JPEG/PNG/WebP, mỗi ảnh tối đa 5 MB, chú thích tối đa 500 ký tự. POST trả `{message,data:[GalleryImage]}`. Hiển thị bằng `Image.network(ApiConfig.absoluteMediaUrl(image.imageUrl))`; mở ảnh lớn khi người dùng chọn thumbnail.

Chọn bìa bằng PATCH `{ 'isCover': true }`; sửa chú thích bằng PATCH `{ 'caption': value }`, dùng null để xóa chú thích. Không gửi `isCover: false`. Ảnh đầu tiên tự làm bìa; khi xóa bìa backend chọn ảnh còn lại cũ nhất. Sau mutation refresh gallery và list/detail để cập nhật bìa/số ảnh. Gallery rỗng hiển thị placeholder; giống nấm có thể trả `imageUrl` cũ làm bìa dự phòng.

Ảnh gallery lô và ảnh nhật ký sinh trưởng là hai danh sách riêng. Ảnh đính kèm nhật ký vẫn được xem trong tiến trình và snapshot minh chứng.

## 19. Kiểm thử Flutter cho chức năng mới

- Staff ghi nhật ký, chọn minh chứng cùng lô, gửi và thấy “Chờ duyệt”; chỉ hoàn thành sau khi quản lý duyệt.
- Trả lại có lý do, bổ sung và gửi lần mới; lịch sử lần cũ hiển thị nội dung snapshot ban đầu.
- Ẩn tự duyệt và nút sai quyền; xử lý `409` bằng refresh, không tự gửi lại.
- DTO tiền nhận chuỗi, lợi nhuận âm và chỉ số null; summary cập nhật sau sửa/xóa khoản chi/lần bán.
- Report theo kỳ không cộng trang hiện tại để làm tổng; tải file financial dạng bytes.
- Upload và quản lý bìa ở cả ba gallery; kiểm tra lỗi vượt giới hạn và URL ảnh tương đối.
