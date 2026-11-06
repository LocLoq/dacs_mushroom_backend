# Backend quản lý nuôi trồng nấm

Node/Express API và Socket.IO, Prisma/MariaDB, Redis/Bull, Redis cache riêng và Python classifier.

[Sơ đồ kiến trúc hệ thống](architecture/kien-truc-cache.html) mô tả cache công khai, luồng invalidation và Redis hàng đợi. Nội dung sơ đồ dựa trên snapshot mã cục bộ; các nút điều khiển của trình xem dùng tiếng Anh.

## Chạy bằng Docker

Cài Docker Desktop với Linux containers hoặc Docker Engine + Compose v2. Tại thư mục repository:

```powershell
Copy-Item .env.docker.example .env.docker
```

Sửa `.env.docker`, thay các giá trị `CHANGE_ME`, rồi chạy:

```powershell
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 300
```

Swagger: **http://localhost:8080/api-docs**. Database mới chưa có tài khoản; cách tạo dữ liệu demo chủ động, kết nối Flutter, cập nhật và sao lưu nằm trong [hướng dẫn Docker](RUN_DOCKER.md). Compose giữ database và ảnh trong volume, không tự chạy seed.

## Tài liệu

- [Chạy và vận hành Docker](RUN_DOCKER.md)
- [Chạy trực tiếp trên Windows](RUN_BACKEND.md)
- [Retry, giám sát classifier và rate limit](CLASSIFIER_RESILIENCE.md)
- [Benchmark 1.000 VU trên 10 cơ sở](benchmarks/k6/README.md)
- [API công việc, minh chứng, tài chính và gallery](NEW_API_DOCUMENTATION.md)
- [Tích hợp Flutter](FLUTTER_API_INTEGRATION_GUIDE.md)
- [Tham số thử API](API_TEST_PARAMS.md)
- [OpenAPI](swagger.yaml)
