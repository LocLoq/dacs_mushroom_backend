# Push UnifiedPush/APNs và triển khai VPS, LAN, VS Code tunnel

Thông báo trong app, phân quyền, lịch sử, WebSocket refresh và outbox giữ nguyên. Android dùng ntfy distributor qua UnifiedPush; iOS gửi thẳng APNs. Không cần dự án Firebase. Bundle ID giữ `com.example.thu`, iOS 15+.

## Chuyển đổi database và API

1. Tắt push (`PUSH_ENABLED=false`) và dừng phiên bản API cũ trước migration.
2. Chạy `npm run db:migrate:staff`, sau đó `npm run db:migrate:push`, `npm run prisma:validate`, `npm run prisma:generate`.
3. Khởi động API mới; cập nhật app; đăng nhập và đăng ký lại thiết bị. Chỉ bật từng kênh sau khi hoàn tất cấu hình.

Migration push giữ notifications và deliveries đã gửi, vô hiệu hóa đăng ký cũ và đánh dấu `cancelled_at` cho delivery cũ chưa gửi. Không suy ra quyền lô từ công việc cũ. `db:migrate:push -- --check` kiểm tra trước; chạy lại migration không xóa lịch sử.

API có JWT:

- `GET /api/notifications/push-config`: `{data:{mode,apiUrl,ntfyUrl,vapidPublicKey,version,channels:{unifiedpush,apns}}}`. Không trả khóa riêng.
- `PUT /api/notifications/devices` Android: `{platform:"android",provider:"unifiedpush",token:"https://push.example.com/up...?...",keys:{p256dh:"...",auth:"..."}}`.
- iOS: `{platform:"ios",provider:"apns",token:"<64 hex characters>",apnsEnvironment:"sandbox"}` hoặc `production`.
- PUT trả `{data:{registrationId}}`; lưu ID này. DELETE gửi `{token,registrationId}`. ID ngăn một yêu cầu logout cũ hủy đăng ký vừa chuyển tài khoản.
- Các API danh sách, chi tiết, đọc và đọc tất cả giữ nguyên. Push chỉ có nội dung chung, notification ID, origin, user ID và mã phiên đăng ký; app đọc thông báo/công việc bằng API xác thực trước khi mở.

Thiết bị dùng TEXT cho endpoint, khóa SHA-256 trên provider/môi trường/token, khóa Web Push, trạng thái active và registrationId. Rebind, đổi khóa, logout hoặc endpoint không còn hiệu lực hủy delivery chưa gửi, giữ lịch sử. APNs error cũ có timestamp hoặc phiên đăng ký cũ không được vô hiệu hóa đăng ký mới.

Bull đọc outbox mỗi 15 giây, tối đa 5 lần với backoff 60/120/240/480 giây. HTTP 429/5xx và lỗi mạng được retry; lỗi khóa/quyền/cấu hình giữ delivery, kiểm tra lại sau 5 phút để có thể sửa cấu hình. HTTP 404/410 ntfy, APNs Unregistered/BadDeviceToken vô hiệu hóa đúng phiên. Hai provider độc lập; một kênh thiếu cấu hình không chặn kênh kia hoặc giao dịch nghiệp vụ. Gửi là at-least-once: worker chết sau khi provider nhận có thể gửi lại; notification ID dùng làm tag/collapse ID.

## Chọn profile

Sao chép `.env.docker.example` thành `.env.docker`, điền các mật khẩu/JWT/classifier token; hợp nhất một file `deploy/.env.vps.example`, `.env.lan.example` hoặc `.env.tunnel.example`, thay các giá trị mẫu. Không giữ hai biến trùng tên với giá trị khác nhau.

| Chế độ | API | ntfy | Bind host |
|---|---|---|---|
| VPS | HTTPS tên miền API | HTTPS tên miền push | 127.0.0.1, Caddy xuất 80/443 |
| LAN | http://192.168.1.10:8080 | http://192.168.1.10:8081 | IP LAN thực tế của máy host |
| tunnel | URL HTTPS port 8080 | URL HTTPS port 8081 | 127.0.0.1 |

LAN/tunnel: `docker compose --env-file .env.docker -f compose.yaml -f compose.push.yaml up -d --build`.
VPS: thêm `-f compose.vps.yaml` vào lệnh trước `up`; trỏ DNS hai tên miền tới VPS và mở 80/443. Caddy cấp HTTPS và proxy cả Socket.IO/WebSocket. Cache/auth ntfy và dữ liệu TLS Caddy dùng volume bền vững. API/ntfy có healthcheck. Database và Redis không publish port ra host.

Profile LAN thay **cả URL và bind address** bằng IP của máy host; điện thoại cùng mạng/VPN. Firewall chỉ mở hai cổng cần dùng cho mạng đó. Khi chạy Node trực tiếp, dùng `API_LISTEN_HOST` của profile; trong container API luôn listen 0.0.0.0, còn publish port vào bind address của host. Backend LAN vẫn cần Internet tới Apple để gửi APNs; iOS luôn nhận qua Apple. Android dùng kết nối ntfy từ điện thoại/distributor tới host. HTTP chỉ được chấp nhận cho origin LAN nội bộ được cấu hình; VPS/tunnel bắt buộc HTTPS. Không bỏ kiểm tra chứng chỉ TLS.

## ntfy và tài khoản nhân viên

Container dùng deny-all và auth/cache volume. Không thiết lập firebase-key-file hoặc upstream-base-url. Cấp **một tài khoản riêng cho mỗi nhân viên**, không dùng tài khoản ntfy admin trên điện thoại. Ví dụ (thêm đúng các `--env-file`/`-f` như lệnh khởi động):

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.push.yaml exec ntfy ntfy access '*' 'up*' write-only
docker compose --env-file .env.docker -f compose.yaml -f compose.push.yaml exec ntfy ntfy user add --role=user staff01
docker compose --env-file .env.docker -f compose.yaml -f compose.push.yaml exec ntfy ntfy access staff01 'up*' read-only
```

Lệnh add hỏi mật khẩu tương tác. Admin trao thông tin đăng nhập cho đúng nhân viên. Anonymous chỉ có quyền ghi `up*` để server ứng dụng có thể gửi UnifiedPush; không được đọc. Mỗi nhân viên chỉ đọc `up*`; nội dung được mã hóa `aes128gcm`, khóa giải mã do connector trên thiết bị giữ. Có thể thu hồi tài khoản bằng `ntfy user del staff01` và hủy đăng ký thiết bị ứng dụng tương ứng.

Theo [cấu hình UnifiedPush của ntfy](https://docs.ntfy.sh/config/#example-unifiedpush). Cài bản ntfy Android hỗ trợ UnifiedPush, ví dụ bản F-Droid được [UnifiedPush hướng dẫn](https://unifiedpush.org/users/distributors/ntfy/). Trong ntfy, đặt default server tới URL hiển thị trong app, thêm tài khoản nhân viên, chọn distributor trong cài đặt app rồi đăng ký lại. Không tự tạo topic/endpoint trong Flutter: connector cung cấp endpoint và khóa. Backend giữ nguyên endpoint/query; chỉ cho phép đúng origin và topic `up*`, không theo redirect.

Tạo một cặp VAPID bằng `npm run push:vapid`, lưu privateKey ở cấu hình triển khai, publicKey ở `VAPID_PUBLIC_KEY`, privateKey ở `VAPID_PRIVATE_KEY`, subject ở `VAPID_SUBJECT=mailto:...`. Giữ nguyên cặp khóa qua lần khởi động; đổi khóa cần đăng ký lại. Bật `PUSH_ENABLED=true`, `UNIFIEDPUSH_ENABLED=true`, restart API.

## VS Code Ports

Khởi động profile tunnel với bind localhost. Trong VS Code mở **Ports: Focus on Ports View**, forward **8080 và 8081**, đổi visibility của cả hai thành **Public**, sao chép hai URL HTTPS khác nhau vào `API_PUBLIC_URL` và `NTFY_PUBLIC_URL`. Restart API/ntfy với base URL mới. App chọn VS Code tunnel và nhập URL **API 8080**; ntfy distributor dùng URL **ntfy 8081** từ push-config.

API vẫn cần JWT; ntfy vẫn cần tài khoản riêng để đọc. Public tunnel cho phép điện thoại/ntfy truy cập mà không đăng nhập Microsoft. Flutter gửi Accept JSON và header bỏ trang trung gian của tunnel; Socket.IO dùng WSS và cùng header. “Lưu và kiểm tra” xác nhận REST `/api/test` **và** Socket.IO trước khi lưu thành công. HTML/interstitial không được coi là API thành công.

Máy host, VS Code và tunnel phải đang chạy. Khi URL thay đổi, cập nhật cấu hình/restart rồi chọn đăng ký lại trong app/distributor; không ghép hostname mới vào endpoint đã lưu. App đổi origin sẽ đăng xuất, hủy socket/listener và đăng ký push của phiên cũ. Mỗi chế độ nhớ riêng URL; URL cũ được giữ khi nâng cấp. Bản mới mặc định VPS và yêu cầu nhập địa chỉ.

Xem [VS Code port forwarding](https://code.visualstudio.com/docs/debugtest/port-forwarding) và [dev tunnels security/interstitial](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security). Tunnel dùng relay Microsoft, không hoạt động khi host/tunnel tắt.

## APNs trực tiếp

Đặt khóa Apple `.p8` ngoài Git, ví dụ `secrets/AuthKey.p8` (mount read-only `/run/push/AuthKey.p8`), điền `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC=com.example.thu`. Khi chạy Node trực tiếp, KEY_FILE phải là đường dẫn thực trên máy host. Bật `PUSH_ENABLED=true`, `APNS_ENABLED=true`, restart API. Không cung cấp khóa Apple cho Flutter.

HTTP/2 TLS tới Apple, JWT ES256 cache dưới 1 giờ, môi trường lấy từ đăng ký thiết bị; Debug dùng sandbox, Release/Profile production theo entitlements hiện có. Trong Xcode bật Push Notifications và chọn provisioning profile có quyền push. Native Swift xin quyền/đăng ký token, chuyển token và foreground/tap sang Dart, giữ notification mở từ cold start. Người dùng từ chối quyền vẫn dùng lịch sử thông báo. iOS có mô tả quyền mạng nội bộ, ATS local networking và exception IP LAN; Android release có network security config và kiểm tra origin theo chế độ ở Dart.

Theo [Apple APNs server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server), [request APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [quyền mạng nội bộ](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSLocalNetworkUsageDescription) và [ATS local networking/IP](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).

## Kiểm tra thực tế trước bật production

Chạy `npm test`, `npm run test:db`, Prisma validate/generate, `flutter analyze --no-fatal-infos`, `flutter test`, `flutter build apk --release`. Test tự động kiểm tra provider, mã hóa/redirect LAN, ES256/APNs môi trường, retry/cancel/rebind, migration và mock API; không thay thế thử thiết bị thật.

Thử Android foreground/background/app đóng, distributor chưa cài, đổi tài khoản, endpoint/khóa/URL thay đổi; thử LAN trên điện thoại cùng mạng, VPS HTTPS, hai public tunnel qua mạng di động và tunnel đóng. Thử iOS từ chối quyền LAN, APNs sandbox/production, mở công việc đã mất quyền và cold start. Nghiệm thu iOS cần macOS/Xcode, thiết bị thật và khóa Apple hợp lệ. Compose/runtime ntfy và các URL triển khai cần Docker/host thực tế. APK hiện dùng cấu hình signing có sẵn của dự án; cấu hình keystore phát hành riêng trước phân phối.

Connector Android dùng nguồn chính thức `unifiedpush_android` 3.5.0 trong `third_party` với một sửa Gradle để áp dụng Kotlin plugin cho AGP 8.9.1; hành vi connector không thay đổi. App hợp nhất dependency Tink về `tink-android:1.23.0` theo hướng dẫn package để tránh duplicate classes. Xem `third_party/unifiedpush_android/LOCAL_PATCH.md`.
