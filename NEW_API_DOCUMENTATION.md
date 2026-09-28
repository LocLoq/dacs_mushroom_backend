# Tài liệu API mới: xác thực và dashboard công việc

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

`batchId`, `batchCode`, `assigneeUserId`, `assignee`, `description` và `dueAt` có thể là `null`. Tất cả thời gian dùng ISO 8601 UTC. Trạng thái hợp lệ: `TODO`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.

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
| `status` | status hoặc `ALL` | Không truyền: chỉ `TODO`, `IN_PROGRESS` |

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

Staff chỉ cập nhật task đang mở (`TODO`, `IN_PROGRESS`) được giao cho chính mình, và chỉ có thể chuyển sang `TODO`, `IN_PROGRESS` hoặc `COMPLETED`. Staff không thể hủy, mở lại, giao lại hoặc sửa nội dung task.

Trả `200`:

```json
{ "message": "Cập nhật công việc thành công", "data": "...Task..." }
```

### `DELETE /dashboard/tasks/:id`

Cho phép: `admin`, `manager`. Trả:

```json
{ "message": "Xóa công việc thành công" }
```

Task không tồn tại trả `404`. Thao tác tạo, cập nhật và xóa được ghi audit kèm UUID task.

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

API này cho phép giao cho `admin`, `manager` hoặc `staff`; không dùng `/admin/users` cho màn giao việc.

## 6. CORS cho Flutter Web

Khi chạy web, cấu hình backend:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://app.example.com
```

Backend cho phép headers `Authorization`, `Content-Type`, và expose `Content-Disposition` để client đọc tên file export. Nếu biến không đặt, backend dùng `*` cho môi trường phát triển.
