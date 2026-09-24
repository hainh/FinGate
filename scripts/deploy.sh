#!/usr/bin/env bash
# Triển khai production lên server "dev" (ssh config).
# Cách dùng:
#   ./scripts/deploy.sh              # dùng HEAD hiện tại của nhánh đang checkout
#   ./scripts/deploy.sh -m "fix: x"  # tự commit hết thay đổi rồi mới deploy
#   ./scripts/deploy.sh --no-build   # chỉ restart, không build lại image
set -euo pipefail

REMOTE="${DEPLOY_REMOTE:-dev}"                 # host trong ~/.ssh/config
SERVER_DIR="${SERVER_DIR:-~/tabloom}"          # thư mục repo trên server
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT_MSG=""
DO_BUILD="--build"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message) COMMIT_MSG="${2:?thiếu message cho -m}"; shift 2 ;;
    --no-build)   DO_BUILD=""; shift ;;
    -h|--help)    sed '1d' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Tham số không hợp lệ: $1"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# 1. Commit (nếu có -m) và đảm bảo working tree sạch
cd "$(git rev-parse --show-toplevel)"
if [[ -n "$COMMIT_MSG" ]]; then
  step "Commit thay đổi: $COMMIT_MSG"
  git add -A
  if git diff --cached --quiet; then echo "Không có thay đổi để commit."; else git commit -m "$COMMIT_MSG"; fi
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  Working tree còn thay đổi chưa commit. Dùng '-m \"...\"' để tự commit, hoặc commit tay rồi chạy lại."
  git status --short
  exit 1
fi

# 2. Push lên GitHub
step "Push $BRANCH lên origin"
if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo '')" ]]; then
  echo "Đã đồng bộ với origin, bỏ qua push."
else
  git push -u origin "$BRANCH"
fi
SHA="$(git rev-parse --short HEAD)"

# 3. Deploy trên server
step "Deploy $SHA lên $REMOTE:$SERVER_DIR"
ssh "$REMOTE" bash -ls -- "$BRANCH" "$SHA" "$DO_BUILD" <<'EOF'
set -euo pipefail
BRANCH="$1"; SHA="$2"; BUILD_FLAG="$3"
cd ~/FinGate
echo "[server] Pull $BRANCH..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "[server] Build & up..."
docker compose -f deploy/compose.yml --profile onprem up -d ${BUILD_FLAG}
echo "[server] Trạng thái container:"
docker compose ps
echo "[server] Log gần nhất:"
sleep 3
docker compose logs --tail=15 ${BUILD_FLAG:+app}
EOF

# 4. Kiểm tra sức khỏe qua ssh
step "Health check"
ssh "$REMOTE" "curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:9380/ && echo '✅Production OK — commit $SHA'"
