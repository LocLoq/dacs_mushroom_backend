# Tham số test API

Chuẩn bị backend và tài khoản demo theo [RUN_DOCKER.md](RUN_DOCKER.md) hoặc [RUN_BACKEND.md](RUN_BACKEND.md). Compose không tự seed; các tài khoản `demo_*` dưới đây chỉ có sau khi chạy seed chủ động.

## Xác thực

Đăng nhập để lấy Bearer token:

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

Trong Swagger, nhấn **Authorize** và nhập `Bearer <token>`.

Kiểm tra phiên hiện tại sau khi đăng nhập:

```http
GET /api/auth/me
Authorization: Bearer <token>
```

Token không hợp lệ hoặc đã bị thu hồi trả `401` cùng `code: AUTH_INVALID_TOKEN`.

| Vai trò | Username | Password |
| --- | --- | --- |
| Admin | `demo_admin` | `Demo@12345` |
| Manager | `demo_manager` | `Demo@12345` |
| Staff | `demo_staff` | `Demo@12345` |

## ID demo dùng chung

```text
facilityId: 1
mushroomId: 1
batchId: 1
batchCode: DEMO-BATCH-001
growthProgressRecordId: 1441
harvestBatchId: 66
classifierId: 00000000-0000-4000-8000-000000000001
```

## Dashboard tasks

```http
GET /api/dashboard/tasks?page=1&limit=10
GET /api/dashboard/tasks?status=ALL&search=kiểm tra
GET /api/dashboard/task-assignees?page=1&limit=10
POST /api/dashboard/tasks
PATCH /api/dashboard/tasks/<task-uuid>
DELETE /api/dashboard/tasks/<task-uuid>
```

Admin và manager tạo, giao, sửa, hủy/mở lại hoặc xóa công việc chưa có lịch sử minh chứng. Staff chỉ PATCH `TODO`/`IN_PROGRESS` cho việc đang mở được giao cho chính mình; hoàn thành phải gửi minh chứng và được duyệt. `status` gồm `TODO`, `IN_PROGRESS`, `PENDING_REVIEW`, `COMPLETED`, `CANCELLED`; danh sách mặc định gồm `TODO`, `IN_PROGRESS`, `PENDING_REVIEW`.

```json
{
  "title": "Kiểm tra độ ẩm lô demo",
  "description": "Ghi nhận trước 16:00",
  "batchId": 1,
  "assigneeUserId": 3,
  "dueAt": "2026-10-01T09:00:00.000Z"
}
```

## Classifier

```http
POST /api/mushroom-classifier/classify
```

- Content type: `multipart/form-data`
- Field: `image`
- File: JPEG, PNG hoặc WebP, tối đa 5 MB.

```http
GET /api/mushroom-classifier/history?page=1&limit=20&status=SUCCEEDED&from=2024-09-23&to=2026-09-23
GET /api/mushroom-classifier/history/00000000-0000-4000-8000-000000000001
```

## Reports

Tham số dùng chung:

```text
from=2024-09-23
to=2026-09-23
facilityId=1
mushroomId=1
groupBy=month
page=1
limit=20
```

```http
GET /api/reports/overview?from=2024-09-23&to=2026-09-23&groupBy=month
GET /api/reports/cultivation?facilityId=1&mushroomId=1&status=FRUITING&page=1&limit=20
GET /api/reports/classifier?from=2024-09-23&to=2026-09-23&page=1&limit=20
GET /api/reports/audit?from=2024-09-23&to=2026-09-23&page=1&limit=20
```

Export:

```http
GET /api/reports/overview/export?format=csv
GET /api/reports/cultivation/export?format=xlsx&facilityId=1
GET /api/reports/classifier/export?format=pdf
GET /api/reports/audit/export?format=csv&groupBy=month
```

`format`: `csv`, `xlsx`, hoặc `pdf`.

## Audit log

```http
GET /api/admin/audit-logs?page=1&limit=20
GET /api/admin/audit-logs?actorUserId=1&action=LOGIN&outcome=SUCCESS
GET /api/admin/audit-logs?entityType=ClassifierLookup&statusCode=200
GET /api/admin/audit-logs?from=2024-09-23&to=2026-09-23
```

## Cơ sở và giống nấm

```http
GET /api/production-facilities?page=1&limit=10&search=Demo
GET /api/production-facilities/1
GET /api/mushroom-species?page=1&limit=10&search=Nấm
```

Tạo cơ sở:

```json
{
  "name": "Cơ sở Swagger",
  "address": "Đà Lạt",
  "province": "Lâm Đồng",
  "facilityType": "HOUSEHOLD",
  "status": "ACTIVE",
  "mushrooms": [1, 2]
}
```

Tạo giống nấm:

```json
{
  "scientificName": "Swagger mushroom 2026",
  "commonName": "Nấm Swagger",
  "family": "Demo",
  "genus": "Demo",
  "edibilityStatus": "EDIBLE",
  "cultivationDifficulty": "EASY"
}
```

## Lô nuôi trồng

```http
GET /api/cultivation-batches?page=1&limit=10&facilityId=1&mushroomId=1&status=FRUITING
GET /api/cultivation-batches/1
GET /api/cultivation-batches/1/care-logs
GET /api/cultivation-batches/1/growth-progress
GET /api/cultivation-batches/66/harvests
```

Tạo lô:

```json
{
  "batchCode": "SWAGGER-BATCH-001",
  "facilityId": 1,
  "mushroomId": 1,
  "status": "PREPARATION",
  "substrateType": "Mùn cưa",
  "bagQuantity": 1000,
  "startDate": "2026-09-23T08:00:00.000Z",
  "expectedHarvestDate": "2026-11-15T08:00:00.000Z"
}
```

Thêm nhật ký chăm sóc:

```json
{
  "actionType": "WATERING",
  "notes": "Tưới nước kiểm tra từ Swagger",
  "recordedAt": "2026-09-23T08:00:00.000Z"
}
```

Thêm tiến trình sinh trưởng:

```json
{
  "stage": "INCUBATION",
  "notes": "Cập nhật từ Swagger",
  "recordedAt": "2026-09-23T08:00:00.000Z"
}
```

Sửa tiến trình `PATCH /api/cultivation-batches/1/growth-progress/1441`:

```json
{
  "stage": "FRUITING",
  "notes": "Đã bắt đầu ra quả thể"
}
```

Ghi thu hoạch `POST /api/cultivation-batches/66/harvests`:

```json
{
  "totalYieldKg": 15.5,
  "qualityGrade": "A",
  "notes": "Thu hoạch thử từ Swagger",
  "harvestedAt": "2026-09-23T08:00:00.000Z",
  "finalizeBatch": false
}
```

## Public growth progress

Không cần token:

```http
GET /api/public/cultivation-batches/DEMO-BATCH-001/growth-progress/current
```

Các batch code demo: `DEMO-BATCH-001` đến `DEMO-BATCH-100`.

## Minh chứng và duyệt việc

Manager tạo task gắn lô và giao cho ID tài khoản `demo_staff` lấy từ `GET /api/dashboard/task-assignees`. Đăng nhập staff, tạo nhật ký sinh trưởng trên lô đó; dùng ID bản ghi thực tế trong response:

```http
GET /api/dashboard/tasks/{taskId}/evidence-candidates?type=GROWTH_PROGRESS
POST /api/dashboard/tasks/{taskId}/submissions
```

```json
{ "evidence": [{ "type": "GROWTH_PROGRESS", "recordId": 1441 }], "notes": "Đã kiểm tra lô" }
```

Đăng nhập manager, dùng `submissionId` từ response để gọi `POST /api/dashboard/tasks/{taskId}/submissions/{submissionId}/review`:

```json
{ "decision": "APPROVE" }
```

Để thử trả lại: `{ "decision": "REJECT", "reason": "Bổ sung ảnh" }`. Chỉ duyệt lần gửi còn `PENDING`. Các ID trong ví dụ là minh họa; lấy ID từ API. Nhật ký demo được seed mới có tác giả `demo_staff`; bản ghi cũ chưa có tác giả không đủ điều kiện làm minh chứng.

## Tài chính và gallery

Manager gọi `POST /api/cultivation-batches/66/expenses`:

```json
{ "name": "Phân bón", "category": "FERTILIZER", "quantity": "2.500", "unit": "kg", "unitPrice": "100000.00" }
```

Manager gọi `POST /api/cultivation-batches/66/sales`:

```json
{ "quantityKg": "12.500", "unitPrice": "80000.00", "buyer": "Khách A" }
```

Xem `GET /api/cultivation-batches/66/financial-summary`, `GET /api/reports/financial`, xuất `/api/reports/financial/export?format=xlsx`. Staff phải nhận `403` ở các API tài chính.

Upload gallery bằng manager: POST multipart `images` (1–5 ảnh) và `caption` tùy chọn tới `/api/production-facilities/1/images`, `/api/mushroom-species/1/images`, `/api/cultivation-batches/66/images`. Chọn ảnh bìa bằng PATCH `.../images/{imageId}` với `{ "isCover": true }`. Staff được GET nhưng không upload/sửa/xóa.
