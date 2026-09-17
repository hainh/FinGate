#!/bin/sh
# FinGate — entrypoint container (Profile O).
#
# Chạy migration (nếu có file migration) rồi mới start server — tương đương
# `preDeployCommand` của Render. Server tự apply index + bootstrap admin khi khởi động.
#
# Migration lỗi KHÔNG chặn boot: server xử lý được DB down (healthz trả `db: down`)
# nên container vẫn lên để debug qua log thay vì crash-loop.
set -e

if [ -f db/migrate.js ]; then
  echo "[fingate] chạy migration…"
  node db/migrate.js || echo "[fingate] migration lỗi — bỏ qua, tiếp tục khởi động"
fi

exec "$@"
