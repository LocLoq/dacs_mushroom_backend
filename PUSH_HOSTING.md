# Firebase/FCM cho Android và iOS

Backend và Flutter đã trở lại Firebase Cloud Messaging. Nhân viên chỉ dùng tài khoản đăng nhập trong bảng `users`; FCM đăng ký thiết bị tự động, không cần tài khoản ntfy/distributor. Application ID Android và bundle ID iOS hiện là **com.loql.layla.themushroomapp**. macOS cũng dùng cùng bundle ID mới; Dart package vẫn là `thu`.

## Tạo cấu hình Firebase lần đầu

1. Tạo một dự án trong [Firebase Console](https://console.firebase.google.com/).
2. Thêm Android app với package **com.loql.layla.themushroomapp**. Tải `google-services.json` vào `dacs_mushroom_flutter/android/app/google-services.json`. Gradle tự áp dụng Google Services khi file tồn tại.
3. Thêm iOS app với bundle ID **com.loql.layla.themushroomapp**. Tải `GoogleService-Info.plist` vào `dacs_mushroom_flutter/ios/Runner/GoogleService-Info.plist`; mở `Runner.xcworkspace` trong Xcode và thêm file vào target Runner/Copy Bundle Resources.
4. Project settings > Service accounts > Generate new private key: tải service account JSON, lưu tại backend `secrets/firebase-admin.json`. Không đưa file service account vào app hoặc Git.
5. Điền `FIREBASE_PROJECT_ID` trong backend `.env` bằng project ID thực. Bật `PUSH_ENABLED=true` rồi restart backend. Android/iOS và service account phải thuộc cùng một dự án Firebase.

Theo [Firebase Admin setup](https://firebase.google.com/docs/admin/setup) và [FCM Flutter setup](https://firebase.google.com/docs/cloud-messaging/flutter/get-started).

## Backend local trên máy hiện tại

`.env` đã chuẩn bị:

```dotenv
PUSH_HOST_MODE=lan
API_LISTEN_HOST=0.0.0.0
API_PUBLIC_URL=http://192.168.1.12:8080
PUSH_ENABLED=false
GOOGLE_APPLICATION_CREDENTIALS=secrets/firebase-admin.json
FIREBASE_PROJECT_ID=
FIREBASE_USE_ADC=false
REDIS_URL=redis://127.0.0.1:6379
SKIP_SEED=1
```

PUSH_ENABLED bật khi bạn đã cung cấp service account và cấu hình Firebase hợp lệ. Thông báo trong app và WebSocket vẫn hoạt động. Với MySQL/Redis đang chạy, khởi động API bằng:

```powershell
npm run start:local:push
```

Không cần ntfy hoặc port 8081. Script chỉ khởi động API/Bull, không seed lại dữ liệu. Nếu cần classifier, chạy `npm run classifier:serve` trong terminal khác hoặc `npm run start:stack` thay lệnh trên (không chạy hai API cùng port).

Sau khi thêm file Google Services, build lại app:

```powershell
flutter pub get
flutter run
# hoặc
flutter build apk --release
```

App mới có ID khác bản cũ, cần cài bản mới và đăng nhập/đăng ký thiết bị lại. Firebase tự sinh FCM token sau khi nhân viên đăng nhập và cho phép thông báo. Android dùng thiết bị/giả lập có Google Play Services.

Trong Flutter mở **Cài đặt > Thông báo trên thiết bị**, nhập IP/URL backend vào ô **IP/URL backend cho API và thông báo**, rồi **Lưu địa chỉ** hoặc **Lưu và kiểm tra**. Có thể nhập IP kèm cổng, URL LAN hoặc HTTPS/tunnel; địa chỉ được lưu chung với cấu hình API. Đổi địa chỉ sẽ đăng xuất để bạn đăng nhập lại và đăng ký thiết bị. Backend lưu origin do app gửi theo từng thiết bị; khi IP máy thay đổi, chỉ cần tự cập nhật trong app, không cần tự sửa API_PUBLIC_URL. FCM vẫn nhận qua Firebase; ô này là địa chỉ backend đăng ký/đọc thông báo. Cho phép port 8080 qua firewall của mạng LAN nếu điện thoại không kết nối được. API vẫn xác thực JWT.

## iOS

Firebase vẫn dùng APNs để đưa thông báo đến iPhone. Cần quyền push của Apple Developer, App ID/provisioning cho bundle ID mới, bật Push Notifications và Background Modes > Remote notifications trong Xcode. Tạo khóa APNs hoặc chứng chỉ phù hợp và tải lên Firebase Project settings > Cloud Messaging > Apple app configuration; giữ khóa Apple ngoài app/Git. Backend không còn dùng HTTP/2 APNs hoặc `.p8` trực tiếp.

[Hướng dẫn FCM Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/get-started) yêu cầu APNs token có sẵn trước khi lấy FCM token; app đã xử lý chờ/thử lại. Xử lý foreground, background và mở từ trạng thái đóng theo [FCM receive messages](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages). Build/sign/test iOS cần macOS/Xcode và thiết bị phù hợp. Chưa có key/project thì chưa thể nhận push thật.

## API và dữ liệu

- `GET /api/notifications/push-config`: `{data:{mode,apiUrl,provider:"fcm",projectId,version,channels:{fcm}}}`. Không trả credential.
- `PUT /api/notifications/devices`: `{platform:"android"|"ios",provider:"fcm",token:"<FCM token>",serverOrigin:"<origin backend app đã chọn>"}`. Có thể bỏ provider; mặc định fcm. Trả `data.registrationId` và `data.serverOrigin`. Origin dùng từ từng thiết bị, API_PUBLIC_URL chỉ là fallback cho client cũ.
- `DELETE /api/notifications/devices`: `{token,registrationId}`. Chỉ hủy đúng đăng ký của tài khoản hiện tại; request logout cũ không hủy đăng ký mới.
- Các API lịch sử, chi tiết, unread/read/read-all giữ nguyên, dùng JWT và tài khoản `users`.

Đổi tài khoản, logout hoặc đổi origin hủy đăng ký cũ; token thay đổi đăng ký lại. Push chỉ có nội dung chung và notification ID/định danh phiên; khi mở, app đọc thông báo/công việc qua API và kiểm tra quyền hiện tại. WebSocket chỉ gửi refresh. Sender dùng notification ID làm tag/collapse ID; retry tối đa 5 lần và outbox đọc mỗi 15 giây. Lỗi Firebase không làm thất bại nghiệp vụ; lỗi token vô hiệu hóa đúng phiên, lỗi cấu hình giữ delivery để có thể sửa và chạy lại.

Migration: `npm run db:migrate:push` chuẩn bị các cột durable registration của lịch sử nâng cấp; `npm run db:migrate:firebase` hủy delivery UnifiedPush/APNs chưa gửi và vô hiệu hóa thiết bị cũ, giữ thông báo và delivery đã gửi. Không rollback/drop bảng dữ liệu. Các cột/migration cũ được giữ để nâng cấp database tương thích; sender/registration hiện chỉ dùng FCM.

## VPS, LAN và VS Code tunnel

Ba lựa chọn chỉ thay đường kết nối **API**, còn Android/iOS đều nhận FCM qua Internet.

- LAN: dùng `.env.lan.example`, API HTTP với IP nội bộ; điện thoại cùng mạng/VPN. Backend và điện thoại vẫn cần Internet tới Firebase/Apple để nhận push.
- VPS: dùng `.env.vps.example`, API HTTPS qua Caddy và một tên miền API.
- VS Code tunnel: dùng `.env.tunnel.example`, forward **chỉ port 8080**, đặt Public, ghi URL HTTPS vào API_PUBLIC_URL, restart API. App giữ bộ kiểm tra REST/Socket.IO và header tránh trang trung gian; đổi URL sẽ đăng xuất và đăng ký lại.

Docker: hợp nhất `.env.docker.example` với một profile, đặt Firebase credential ở `secrets/firebase-admin.json`, bật PUSH_ENABLED rồi chạy:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.push.yaml up -d --build
# VPS: thêm -f compose.vps.yaml trước up
```

Key được mount read-only tại `/run/firebase/firebase-admin.json`. Có thể đổi thư mục bằng FIREBASE_CREDENTIALS_DIR. Không còn service/cache/auth volume ntfy trong Compose. [VS Code ports](https://code.visualstudio.com/docs/debugtest/port-forwarding) và [dev tunnel interstitial](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security).

## Gửi thử sau khi thiết bị đã đăng ký

```powershell
npm run push:test -- --username TEN_DANG_NHAP_APP --platform android
npm run push:test -- --username TEN_DANG_NHAP_APP --platform ios
```

Lệnh tạo một thông báo thử và delivery cho thiết bị tương ứng của chính username bạn chọn. Chờ tối đa khoảng 15 giây. Dùng username app trong bảng users. Để kiểm tra công việc có liên kết, admin giao việc/duyệt minh chứng như luồng thật.

Kiểm tra tự động: `npm test`, `npm run test:db`, Prisma validate/generate, Flutter analyzer/tests và APK release. Push thật chưa nghiệm thu nếu thiếu project, key và thiết bị.

Migration bổ sung origin theo thiết bị: `npm run db:migrate:push-origin`. Cột nullable giữ tương thích dữ liệu cũ; đổi origin tạo registrationId mới và hủy delivery đang chờ. API_PUBLIC_URL có thể bỏ trống khi client mới gửi serverOrigin; không tự dò hoặc ghi IP vào cấu hình.
