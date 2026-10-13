# Công việc, phân quyền, ảnh chăm sóc và thông báo

## Cập nhật database

Chạy tại backend, với MySQL/MariaDB đang hoạt động:

```powershell
node scripts/migrate-staff-workflow.cjs --check
node scripts/migrate-staff-workflow.cjs
npm run prisma:generate
```

Migration thêm sáu bảng, ba cột classifier và mở rộng action_type lên 255 ký tự, có thể chạy lại. Không suy ra quyền từ công việc cũ. Admin cần thêm staff vào cơ sở rồi phân công từng lô. Khi thu hồi cơ sở, phân công các lô thuộc cơ sở cũng bị gỡ; công việc và minh chứng giữ nguyên. Admin/manager có thể hủy hoặc chuyển người nhận sang nhân viên đủ quyền.

Staff được xem lô được giao, ghi chăm sóc/sinh trưởng/thu hoạch, hoàn tất qua thu hoạch và PUT chỉ trường `status`. Staff chỉ sửa sinh trưởng do mình tạo. Admin/manager quản lý thông tin, tạo/xóa lô; chỉ admin cấp quyền.

## API bổ sung

Các API dùng Bearer JWT, trừ snapshot classifier.

| API | Nội dung |
| --- | --- |
| GET /api/production-facilities/:id/staff | Admin xem nhân viên của cơ sở, có page/limit/search |
| POST /api/production-facilities/:id/staff | Admin thêm nhân viên, JSON {userId} |
| DELETE /api/production-facilities/:id/staff/:userId | Thu hồi cơ sở và các phân công lô thuộc cơ sở |
| GET/POST /api/cultivation-batches/:id/staff | Admin xem/giao nhân viên; POST JSON {userId}, phải thuộc cơ sở |
| DELETE /api/cultivation-batches/:id/staff/:userId | Thu hồi lô, giữ lịch sử công việc |
| GET /api/dashboard/task-assignees?batchId=... | Admin/manager chọn người nhận đủ quyền lô |
| GET /api/notifications | page/limit/unread=true; trả {data,pagination,unreadCount} |
| GET /api/notifications/:id | Chi tiết thông báo của chính người đăng nhập |
| PATCH /api/notifications/:id/read | Đánh dấu đã đọc |
| POST /api/notifications/read-all | Đánh dấu tất cả đã đọc |
| PUT /api/notifications/devices | JSON theo provider UnifiedPush/APNs; xem PUSH_HOSTING.md |
| DELETE /api/notifications/devices | JSON {token,registrationId}; chỉ hủy thiết bị thuộc tài khoản hiện tại |
| GET /api/mushroom-classifier/jobs/:id | UUID dùng như capability của luồng khách hiện có |

Staff luôn chỉ nhận công việc của chính mình, dù gửi assigneeUserId của người khác. Mặc định TODO/IN_PROGRESS; status=PENDING_REVIEW hoặc ALL dùng để xem chờ duyệt/lịch sử. Công việc gắn lô bị thu hồi quyền không xuất hiện và chi tiết trả 403. Công việc không gắn lô vẫn dùng quyền người nhận. Snapshot classifier chỉ trả id/status/result/attempt/maxAttempts/nextRetryAt và thời gian; không trả userId/inputPath hoặc lỗi kỹ thuật nội bộ.

POST care-logs giữ JSON cũ và nhận multipart: actionType, notes, recordedAt, images. Ảnh không bắt buộc; tối đa 5 JPEG/PNG/WebP, 5 MiB mỗi ảnh. Response nhật ký có images. Các mã sẵn: WATERING, FERTILIZING, CLEANING, VENTILATION, PEST_CONTROL; hành động khác vẫn lưu chuỗi tự do. Ảnh chăm sóc là riêng tư, tải bằng JWT và quyền lô; snapshot minh chứng giữ ảnh sau khi bản ghi/lô bị xóa.

## WebSocket và refresh

Socket.IO namespace /workflow dùng handshake auth: {token: JWT}. Server tự chọn room người dùng và xác minh phiên trước khi gửi. Không có API client tự chọn room.

Chỉ event refresh, payload {resource,id?}. Resource: tasks, notifications, batches, care-logs, growth-progress, harvests, permissions. Client ánh xạ sang API cố định, gộp 300 ms, giữ trang/bộ lọc và bản nháp form. Permissions làm tải lại các màn liên quan; 401/403/404 phải xóa dữ liệu cũ.

Classifier ở namespace mặc định, giữ subscribe_job(UUID). Các event processing/retrying/finished/failed cũ được thay bằng refresh {resource:'classifier-job',id:UUID}. Client GET snapshot bằng API. Reconnect/foreground tải lại job đang chờ; mất socket polling mỗi 5 giây. Nâng cấp backend và frontend cùng phiên bản trước khi chuyển người dùng sang giao thức mới.

## Push Android/iOS và ba chế độ host

Xem [PUSH_HOSTING.md](PUSH_HOSTING.md) cho UnifiedPush/ntfy, APNs trực tiếp, VPS/LAN/VS Code tunnel, migration và đăng ký thiết bị.

## Kiểm thử

npm test; npm run test:db (database tạm, không thay dữ liệu ứng dụng); npm run prisma:validate; flutter analyze --no-fatal-infos; flutter test.

Để nghiệm thu push, cần thiết bị Android có ntfy UnifiedPush distributor và iOS có APNs hợp lệ: kiểm tra nhận foreground/background/terminated, mở đúng công việc, logout/đổi tài khoản và staff đã bị thu hồi quyền. Build/sign iOS cần macOS/Xcode.


### Flutter tests trên đường dẫn Windows hiện tại

Flutter SDK 3.41.6 sinh test listener không escape dấu nháy đơn trong đường dẫn `hdd's data`. Đã xác nhận tests chạy qua junction trỏ tới cùng dự án: `Set-Location "$env:TEMP\mushroom-frontend-live"; flutter test`. Đây là đường dẫn tạm đã tạo trong phiên này; dữ liệu vẫn ở dacs_mushroom_flutter.
