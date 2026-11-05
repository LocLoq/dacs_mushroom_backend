#!/bin/sh
set -eu
action="$1"
run_id="$2"
case "$run_id" in bm[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) exit 2 ;; esac
cd "$HOME/benchmark_$run_id"
compose() { docker compose --env-file .env.benchmark -p "$run_id" -f compose.yaml -f compose.benchmark.yaml "$@"; }
wait_ready() {
  service="$1"
  n=0
  while [ "$n" -lt 120 ]; do
    cid=$(compose ps -q "$service")
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
    case "$status" in healthy|running) return 0 ;; esac
    n=$((n+1)); sleep 3
  done
  echo "Service $service did not become ready" >&2; exit 1
}
case "$action" in
  prepare)
    test ! -e .env.benchmark
    umask 077
    secret() { openssl rand -hex 24; }
    {
      printf 'DB_NAME=benchmark_%s\nBENCHMARK_DATABASE=benchmark_%s\n' "$run_id" "$run_id"
      printf "DB_USER=benchmark\nDB_PASSWORD='%s'\nDB_ROOT_PASSWORD='%s'\n" "$(secret)" "$(secret)"
      printf "JWT_SECRET='%s'\nCLASSIFIER_SERVICE_TOKEN='%s'\nBENCHMARK_PASSWORD='%s'\n" "$(secret)" "$(secret)" "$(secret)"
      printf 'API_PORT=18080\nAPI_BIND_ADDRESS=0.0.0.0\nCLASSIFIER_MAX_CONCURRENCY=1\nCLASSIFIER_WORKER_CONCURRENCY=1\nCLASSIFIER_TORCH_THREADS=1\nDATABASE_POOL_SIZE=10\nCACHE_ENABLED=true\n'
    } > .env.benchmark
    mkdir -p .cache
    compose up -d --build api classifier-worker
    wait_ready classifier
    wait_ready api
    wait_ready classifier-worker
    docker build -f docker/Dockerfile.benchmark-seed -t "benchmark-seed:$run_id" .
    ;;
  seed)
    profile="${3:-full}"
    case "$profile" in smoke|full) ;; *) exit 2 ;; esac
    set -a; . ./.env.benchmark; set +a
    DATABASE_HOST=db DATABASE_PORT=3306 DATABASE_NAME="$BENCHMARK_DATABASE" DATABASE_USER="$DB_USER" DATABASE_PASSWORD="$DB_PASSWORD"
    BENCHMARK_RUN_ID="$run_id" BENCHMARK_IMAGE=/app/fixture.jpg BENCHMARK_PYTHON=/usr/bin/python3 BENCHMARK_UPLOADS_DIR=/app/uploads BENCHMARK_PROFILE="$profile"
    export DATABASE_HOST DATABASE_PORT DATABASE_NAME DATABASE_USER DATABASE_PASSWORD BENCHMARK_RUN_ID BENCHMARK_IMAGE BENCHMARK_PYTHON BENCHMARK_UPLOADS_DIR BENCHMARK_PROFILE
    docker run --rm --network "${run_id}_default" \
      -e DATABASE_HOST -e DATABASE_PORT -e DATABASE_NAME -e DATABASE_USER -e DATABASE_PASSWORD \
      -e BENCHMARK_DATABASE -e BENCHMARK_PASSWORD -e BENCHMARK_RUN_ID -e BENCHMARK_IMAGE -e BENCHMARK_PYTHON -e BENCHMARK_UPLOADS_DIR -e BENCHMARK_PROFILE \
      -v "${run_id}_uploads:/app/uploads" -v "$PWD/.cache:/app/.cache" -v "$PWD/fixture.jpg:/app/fixture.jpg:ro" \
      -v "$PWD/benchmarks/k6:/app/benchmarks/k6:ro" --entrypoint node "benchmark-seed:$run_id" /app/benchmarks/k6/seed.cjs
    INDEX_EVIDENCE_DIR="/app/.cache/benchmark/$run_id/index-evidence"
    export INDEX_EVIDENCE_DIR
    docker run --rm --network "${run_id}_default" \
      -e DATABASE_HOST -e DATABASE_PORT -e DATABASE_NAME -e DATABASE_USER -e DATABASE_PASSWORD -e INDEX_EVIDENCE_DIR \
      -v "$PWD/.cache:/app/.cache" --entrypoint node "benchmark-seed:$run_id" /app/scripts/migrate-cache-indexes.cjs
    ;;
  configure)
    concurrency="$3"; threads="$4"; pool="$5"; cache="${6:-true}"
    case "$concurrency:$threads:$pool" in [12]:[124]:10|[12]:[124]:20) ;; *) exit 2 ;; esac
    case "$cache" in true|false) ;; *) exit 2 ;; esac
    sed -i "s/^CLASSIFIER_MAX_CONCURRENCY=.*/CLASSIFIER_MAX_CONCURRENCY=$concurrency/;s/^CLASSIFIER_WORKER_CONCURRENCY=.*/CLASSIFIER_WORKER_CONCURRENCY=$concurrency/;s/^CLASSIFIER_TORCH_THREADS=.*/CLASSIFIER_TORCH_THREADS=$threads/;s/^DATABASE_POOL_SIZE=.*/DATABASE_POOL_SIZE=$pool/" .env.benchmark
    sed -i "s/^CACHE_ENABLED=.*/CACHE_ENABLED=$cache/" .env.benchmark
    compose up -d --no-deps --force-recreate classifier api classifier-worker
    wait_ready classifier; wait_ready api; wait_ready classifier-worker
    ;;
  snapshot)
    umask 077
    mkdir -p .cache
    docker exec "${run_id}-db-1" sh -c 'exec mariadb-dump --single-transaction --no-tablespaces -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' > .cache/benchmark-seed.sql
    ;;
  reset)
    test -s .cache/benchmark-seed.sql
    compose stop api classifier-worker
    docker exec -i "${run_id}-db-1" sh -c 'exec mariadb -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' < .cache/benchmark-seed.sql
    docker exec "${run_id}-redis-1" redis-cli FLUSHDB >/dev/null
    compose up -d api classifier-worker
    wait_ready api; wait_ready classifier-worker
    ;;
  calibrate)
    concurrency="$3"
    case "$concurrency" in 1|2) ;; *) exit 2 ;; esac
    set -a; . ./.env.benchmark; set +a
    docker run --rm --network "${run_id}_default" -e CLASSIFIER_SERVICE_TOKEN -e CLASSIFIER_CALIBRATION_CONCURRENCY="$concurrency" \
      -v "$PWD/fixture.jpg:/app/fixture.jpg:ro" -v "$PWD/benchmarks/k6:/app/benchmarks/k6:ro" \
      --entrypoint node "benchmark-seed:$run_id" /app/benchmarks/k6/calibrate-classifier.cjs
    ;;
  cleanup)
    compose down --volumes --remove-orphans
    ;;
  stop)
    compose stop
    ;;
  *) exit 2 ;;
esac
