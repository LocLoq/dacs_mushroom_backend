# Tài liệu API: công việc, minh chứng, tài chính và gallery

Base URL: `http://<backend-host>:8080/api`.

Khởi động bằng [Docker Compose](RUN_DOCKER.md) hoặc [chạy trực tiếp](RUN_BACKEND.md). Docker giữ nguyên hợp đồng API; nếu đổi `API_PORT`, dùng cổng mới trong Base URL.

Mọi API dưới đây, trừ đăng nhập, gửi header:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

## 1. Kiểm tra phiên đăng nhập

### `GET /auth/me`

Cho phép: `admin`, `manager`, `staff`.

```json
{
  "data": {
    "id": 12,
    "username": "manager01",
    "full_name": "Nguyễn Văn A",
    "role": "manager",
    "email": "manager01@example.com",
    "phone_number": "0900000000"
  }
}
```

`role` luôn là một trong `admin`, `manager`, `staff`. Response không chứa mật khẩu, password hash hoặc `tokenver`.

Token thiếu, hết hạn, bị thu hồi, hoặc không còn khớp người dùng trong DB:

```http
401 Unauthorized
```

```json
{
  "code": "AUTH_INVALID_TOKEN",
  "message": "Phiên đăng nhập đã hết hạn hoặc không hợp lệ"
}
```

Client phải xóa phiên và quay lại đăng nhập khi nhận lỗi này. Lỗi thiếu quyền là `403` với `code: "AUTH_FORBIDDEN"`; không xóa phiên trong trường hợp đó.

## 2. Kiểu dữ liệu công việc

```json
{
  "id": "7f98c4f8-41f5-4b63-9c43-6f750bd2e4de",
  "title": "Kiểm tra độ ẩm lô DEMO-001",
  "description": "Ghi nhận trước 16:00",
  "status": "TODO",
  "batchId": 1,
  "batchCode": "DEMO-001",
  "assigneeUserId": 3,
  "assignee": {
    "id": 3,
    "username": "demo_staff",
    "full_name": "Demo staff",
    "role": "staff"
  },
  "createdByUserId": 2,
  "dueAt": "2026-10-01T09:00:00.000Z",
  "createdAt": "2026-09-28T08:00:00.000Z",
  "updatedAt": "2026-09-28T08:00:00.000Z"
}
```

`batchId`, `batchCode`, `assigneeUserId`, `assignee`, `description` và `dueAt` có thể là `null`. Tất cả thời gian trả về dùng ISO 8601 UTC. Trạng thái hợp lệ: `TODO`, `IN_PROGRESS`, `PENDING_REVIEW`, `COMPLETED`, `CANCELLED`. Response còn có `version` (backend quản lý) và `submissions`: danh sách/create/patch trả tối đa một bản tóm tắt lần gửi gần nhất; GET chi tiết trả toàn bộ lịch sử, gồm snapshot `evidence` và `notes`.

## 3. Danh sách và chi tiết công việc

### `GET /dashboard/tasks`

Cho phép: `admin`, `manager`, `staff`.

Query tùy chọn:

| Tên | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `page` | integer dương | Mặc định `1` |
| `limit` | integer 1–50 | Mặc định `10` |
| `search` | string | Tìm trong tiêu đề |
| `batchId` | integer dương | Lọc theo lô |
| `assigneeUserId` | integer dương | Lọc theo người nhận |
| `status` | status hoặc `ALL` | Không truyền: `TODO`, `IN_PROGRESS`, `PENDING_REVIEW` |

Công việc được sắp theo `dueAt` gần nhất trước, việc không có hạn ở cuối; sau đó theo thời điểm tạo mới nhất và UUID. Response:

```json
{
  "data": ["...Task..."],
  "pagination": {
    "totalItems": 1,
    "currentPage": 1,
    "totalPages": 1,
    "pageSize": 10
  }
}
```

### `GET /dashboard/tasks/:id`

Cho phép: `admin`, `manager`, `staff`. Trả `{ "data": Task }`; task không tồn tại trả `404`.

## 4. Tạo và quản lý công việc

### `POST /dashboard/tasks`

Cho phép: `admin`, `manager`.

```json
{
  "title": "Kiểm tra độ ẩm lô DEMO-001",
  "description": "Ghi nhận trước 16:00",
  "batchId": 1,
  "assigneeUserId": 3,
  "dueAt": "2026-10-01T09:00:00.000Z"
}
```

`title` bắt buộc, không rỗng, tối đa 255 ký tự. Các trường khác tùy chọn và có thể truyền `null` để không gắn lô, không giao người nhận hoặc không đặt hạn. Backend tự tạo UUID, gán người tạo và đặt `status: "TODO"`.

Trả `201`:

```json
{ "message": "Tạo công việc thành công", "data": "...Task..." }
```

`batchId` hoặc `assigneeUserId` không tồn tại trả `400`.

### `PATCH /dashboard/tasks/:id`

Admin/manager có thể gửi một hoặc nhiều trường: `title`, `description`, `batchId`, `assigneeUserId`, `dueAt`, `status`. Dùng `null` để bỏ liên kết hoặc xóa mô tả/hạn.

Staff chỉ được gửi:

```json
{ "status": "IN_PROGRESS" }
```

Staff chỉ cập nhật task đang mở (`TODO`, `IN_PROGRESS`) được giao cho chính mình, và chỉ có thể chuyển sang `TODO` hoặc `IN_PROGRESS`. Hoàn thành phải qua gửi minh chứng và manager/admin duyệt ở mục 6. Mọi role đều bị chặn PATCH trực tiếp sang `PENDING_REVIEW`/`COMPLETED`.

Khi đang chờ duyệt, manager/admin được sửa nội dung/hạn hoặc hủy; không được đổi lô/người nhận hay chuyển về trạng thái mở bằng PATCH. Muốn nhân viên bổ sung, dùng quyết định `REJECT`. Sau khi hoàn thành/hủy, manager/admin có thể mở lại bằng PATCH `IN_PROGRESS`; lịch sử được giữ nguyên.

Trả `200`:

```json
{ "message": "Cập nhật công việc thành công", "data": "...Task..." }
```

### `DELETE /dashboard/tasks/:id`

Cho phép: `admin`, `manager`. Trả:

```json
{ "message": "Xóa công việc thành công" }
```

Task không tồn tại trả `404`. Task đã có lịch sử minh chứng không được xóa, trả `409 STATE_CONFLICT`; dùng hủy công việc. Thao tác tạo, cập nhật và xóa được ghi audit kèm UUID task.

## 5. Danh sách người có thể được giao việc

### `GET /dashboard/task-assignees`

Cho phép: `admin`, `manager`.

Hỗ trợ `page`, `limit` (1–50) và `search` theo username/họ tên. Response phân trang chỉ gồm dữ liệu cần thiết:

```json
{
  "data": [
    {
      "id": 3,
      "username": "demo_staff",
      "full_name": "Demo staff",
      "role": "staff"
    }
  ],
  "pagination": {
    "totalItems": 1,
    "currentPage": 1,
    "totalPages": 1,
    "pageSize": 10
  }
}
```

## 6. Minh chứng và duyệt hoàn thành

Chỉ người được giao việc được chọn/gửi minh chứng. Một minh chứng là nhật ký chăm sóc (`CARE_LOG`), sinh trưởng (`GROWTH_PROGRESS`) hoặc thu hoạch (`HARVEST`) do người nhận tạo hoặc cập nhật. Nếu task có `batchId`, bản ghi phải cùng lô; nếu chưa gắn lô, cho phép bản ghi ở bất kỳ lô nào. Bản ghi cũ chưa xác định người thực hiện không đủ điều kiện.

### `GET /dashboard/tasks/:id/evidence-candidates`

Query: `page=1`, `limit=10` (tối đa 50), `type` tùy chọn thuộc ba loại trên. Response phân trang; mỗi item là `{ type, recordId, record }`. `record` là bản ghi gốc, kèm `images` đối với sinh trưởng. Thứ tự theo thời gian tạo mới nhất, ID và loại minh chứng.

### `POST /dashboard/tasks/:id/submissions`

```json
{
  "evidence": [
    { "type": "GROWTH_PROGRESS", "recordId": 1441 },
    { "type": "CARE_LOG", "recordId": 18 }
  ],
  "notes": "Đã kiểm tra độ ẩm và cập nhật tiến trình"
}
```

Yêu cầu 1–20 hành động, không trùng cặp `type/recordId`; `notes` tùy chọn, tối đa 10.000 ký tự. Task phải ở `TODO`/`IN_PROGRESS`. Backend kiểm tra các liên kết và quyền trong transaction, chụp bản ghi thành snapshot rồi chuyển task sang `PENDING_REVIEW`.

Trả `201`, `{ message, data: TaskSubmission }`. Các trường của `TaskSubmission`:

| Field | Ý nghĩa |
| --- | --- |
| `id`, `taskId` | UUID lần gửi và công việc |
| `status` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `submittedByUserId`, `submittedAt` | Người gửi và thời điểm gửi |
| `reviewedByUserId`, `reviewedAt` | Người duyệt và thời điểm duyệt; có thể null |
| `evidence` | Danh sách `{ type, recordId, record }`; `record` là snapshot lúc gửi |
| `notes`, `reason` | Ghi chú nhân viên và lý do duyệt/trả lại; có thể null |

Ảnh sinh trưởng trong snapshot được giữ kể cả khi lô bị xóa. Việc sửa nhật ký sau khi gửi không thay đổi snapshot.

### `POST /dashboard/tasks/:id/submissions/:submissionId/review`

Chỉ manager/admin; người gửi không được tự duyệt. Duyệt:

```json
{ "decision": "APPROVE" }
```

Trả lại:

```json
{ "decision": "REJECT", "reason": "Bổ sung ảnh và ghi chú độ ẩm" }
```

`REJECT` bắt buộc có lý do không rỗng, tối đa 10.000 ký tự. Trả `200`, `{ message, data: TaskSubmission }`. Duyệt chuyển task sang `COMPLETED`; trả lại chuyển về `IN_PROGRESS`. Nhân viên cập nhật nhật ký rồi gửi lần mới; lần cũ vẫn được lưu.

Sai quyền trả `403 AUTH_FORBIDDEN`; minh chứng không hợp lệ trả `400`; task/lần gửi không tồn tại trả `404`; gửi/duyệt trùng hoặc lần gửi hết hiệu lực trả `409 STATE_CONFLICT`. Ghi audit `TASK_SUBMIT` và `TASK_REVIEW`.

## 7. Chi phí, bán hàng và lời/lỗ

Mọi API tài chính chỉ dành cho manager/admin. Staff ghi nhật ký/thu hoạch nhưng không nhập hoặc xem tài chính. Tiền tệ là `VND`; tiền và số lượng lưu bằng Decimal. Request chấp nhận số hoặc chuỗi thập phân; nên gửi chuỗi để giữ độ chính xác. Giá tối đa 2 chữ số thập phân, số lượng tối đa 3; số lượng dương, giá không âm. Không gửi `amount`: backend tính số lượng × đơn giá, làm tròn nửa lên tới 2 chữ số thập phân.

### Khoản chi theo lô

```text
GET    /cultivation-batches/:id/expenses?page=1&limit=10
POST   /cultivation-batches/:id/expenses
PATCH  /cultivation-batches/:id/expenses/:expenseId
DELETE /cultivation-batches/:id/expenses/:expenseId
```

```json
{
  "name": "Phân bón đợt 1",
  "category": "FERTILIZER",
  "quantity": "2.500",
  "unit": "kg",
  "unitPrice": "100000.00",
  "incurredAt": "2026-10-03T01:00:00.000Z",
  "notes": "Chi phí sử dụng cho lô này"
}
```

Bắt buộc `name` (tối đa 255 ký tự), `category`, `quantity`, `unit` (tối đa 50 ký tự), `unitPrice`. Nhóm chi phí: `MATERIAL` (vật tư), `TOOL` (dụng cụ), `FERTILIZER` (phân bón), `OTHER` (khác). `incurredAt` tùy chọn, mặc định hiện tại; `notes` tùy chọn, có thể null.

### Lần bán theo lô

```text
GET    /cultivation-batches/:id/sales?page=1&limit=10
POST   /cultivation-batches/:id/sales
PATCH  /cultivation-batches/:id/sales/:saleId
DELETE /cultivation-batches/:id/sales/:saleId
```

```json
{
  "quantityKg": "12.500",
  "unitPrice": "80000.00",
  "soldAt": "2026-10-03T03:00:00.000Z",
  "buyer": "Khách A",
  "notes": "Bán đợt 1"
}
```

Bắt buộc `quantityKg`, `unitPrice`. `soldAt` mặc định hiện tại; `buyer` tùy chọn/null, tối đa 255 ký tự; `notes` tùy chọn/null, tối đa 10.000 ký tự. Các ngày tài chính nhận ISO 8601 có múi giờ hoặc `YYYY-MM-DD` (UTC lúc 00:00); Flutter nên gửi ISO UTC.

GET trả `{ data: [...], pagination }`, tối đa 50 dòng/trang, sắp theo ngày ghi nhận mới nhất rồi ID. POST trả `201`, PATCH trả `200`, `{ message, data }`; DELETE trả `{ message }`. Response có `id`, `batchId`, `amount`, `createdByUserId`, `updatedByUserId`, `createdAt`, `updatedAt` cùng các trường nghiệp vụ. Các trường Decimal trả chuỗi, có thể bỏ các số 0 cuối. PATCH chỉ gửi trường cần sửa; backend tính lại thành tiền. ID khoản chi/lần bán khác lô trả `404`.

### `GET /cultivation-batches/:id/financial-summary`

Tổng hợp toàn bộ vòng đời lô:

```json
{
  "data": {
    "batchId": 1,
    "currency": "VND",
    "totalHarvestKg": 25,
    "totalSoldKg": 12.5,
    "revenue": "1000000.00",
    "totalCost": "250000.00",
    "profit": "750000.00",
    "costsByCategory": {
      "MATERIAL": "0.00",
      "TOOL": "0.00",
      "FERTILIZER": "250000.00",
      "OTHER": "0.00"
    },
    "profitMarginPercent": "75.00",
    "costPerHarvestKg": "10000.00"
  }
}
```

Lợi nhuận = doanh thu bán − tổng khoản chi. Tỷ suất = lợi nhuận/doanh thu × 100; chi phí/kg = tổng chi phí/kg thu hoạch. Mẫu số 0 trả null; lợi nhuận có thể âm. Tổng thu hoạch lấy từ tất cả `HarvestRecord`; `finalizeBatch` cũng cập nhật `actualYieldKg` theo tổng thu hoạch.

### Báo cáo tài chính

```text
GET /reports/financial?from=2026-10-01&to=2026-10-31&groupBy=day
GET /reports/financial/export?from=2026-10-01&to=2026-10-31&format=xlsx
```

Hỗ trợ `facilityId`, `mushroomId`, `status`, `groupBy=day|month`, `page`, `limit` (mặc định 20, tối đa 100), khoảng thời gian tối đa 5 năm. Ngày đơn thuần trong bộ lọc hiểu theo UTC+7. Khoảng mặc định từ đầu năm đến hiện tại.

Response `{ data, summary, series, period, pagination }`: `data` là các lô phân trang, gồm thông tin lô và các chỉ số tài chính; `summary` và `series` tính trên **toàn bộ bộ lọc**, không chỉ trang hiện tại. Mỗi điểm series có `{ period, revenue, totalCost, profit }`, nhóm theo UTC+7. Chi tiết từng lô cũng có series riêng. Khoản bán, chi phí và thu hoạch dùng ngày sự kiện trong kỳ; lô bắt đầu trước kỳ vẫn được đưa vào. Chỉ số chi phí/kg của báo cáo dùng sản lượng thu hoạch trong kỳ, còn API summary lô dùng toàn bộ vòng đời.

Xuất `csv`, `xlsx`, `pdf`, giữ cơ chế giới hạn số dòng và `422` của báo cáo hiện tại. Chi phí dụng cụ ghi trực tiếp vào lô; phiên bản này không quản lý tồn kho, công nợ, thuế, khấu hao hoặc giới hạn số kg bán theo tồn kho. Các thao tác tài chính được ghi audit.

## 8. Gallery cơ sở, giống nấm và lô

Dùng cùng hợp đồng cho `production-facilities`, `mushroom-species`, `cultivation-batches`:

```text
GET    /:resource/:id/images?page=1&limit=10
POST   /:resource/:id/images
PATCH  /:resource/:id/images/:imageId
DELETE /:resource/:id/images/:imageId
```

GET dành cho mọi role; thêm/sửa/xóa chỉ dành cho manager/admin. POST nhận multipart: field `images` lặp lại, 1–5 ảnh JPEG/PNG/WebP, mỗi ảnh tối đa 5 MB; `caption` tùy chọn, tối đa 500 ký tự, áp dụng cho các ảnh trong lần tải.

POST trả `201`, `{ message, data: [GalleryImage] }`; GET trả danh sách phân trang, ảnh bìa trước rồi `createdAt/id` tăng dần. GalleryImage có `id`, khóa liên kết tương ứng (`facilityId`/`mushroomId`/`batchId`), `imageUrl`, `originalName`, `mimeType`, `fileSize`, `caption`, `isCover`, `uploadedByUserId`, `createdAt`.

PATCH chú thích hoặc chọn ảnh bìa:

```json
{ "caption": "Khu chăm sóc", "isCover": true }
```

Không gửi `isCover: false`; chọn ảnh khác để đổi bìa. PATCH trả `{ message, data: GalleryImage }`. Ảnh đầu tiên làm bìa; xóa bìa tự chọn ảnh còn lại cũ nhất. Không có ảnh thì `coverImageUrl=null`; giống nấm dùng `imageUrl` cũ làm dự phòng.

GET danh sách/chi tiết ba resource trả thêm `coverImageUrl`, `imageCount`. Có thêm `GET /mushroom-species/:id` để xem chi tiết giống nấm. Gallery lô độc lập với ảnh trong nhật ký sinh trưởng. API gallery không yêu cầu ảnh trong nhật ký sinh trưởng phải được duyệt.

URL ảnh `/uploads/...` ghép với server origin, không ghép thêm `/api`. Upload lỗi được dọn tệp; xóa ảnh/đối tượng dọn các tệp không được hồ sơ minh chứng tham chiếu. Sai định dạng/quá giới hạn trả `400`; không đủ quyền trả `403`; ảnh không thuộc đối tượng trả `404`.

API này cho phép giao cho `admin`, `manager` hoặc `staff`; không dùng `/admin/users` cho màn giao việc.

## 6. CORS cho Flutter Web

Khi chạy web, cấu hình backend:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://app.example.com
```

Backend cho phép headers `Authorization`, `Content-Type`, và expose `Content-Disposition` để client đọc tên file export. Nếu biến không đặt, backend dùng `*` cho môi trường phát triển.
