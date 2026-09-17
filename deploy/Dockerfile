# syntax=docker/dockerfile:1

# FinGate — image cho server thật (Profile O: VPS / VM nội bộ). Xem docs/04_architecture.md §12.6.
#
#   Build: docker build -f deploy/Dockerfile -t fingate:latest .
#   Chạy : docker compose -f deploy/compose.yml --profile onprem up -d --build
#
# Multi-stage:
#   - `build`  : cài đủ devDeps + build cả 3 package (shared → api/web).
#   - `runtime`: cài lại CHỈ prodDeps của @fingate/api (+ @fingate/shared) từ lockfile,
#                bê dist đã build sang, chạy bằng user không phải root (uid 10001).

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------
# 1) build — full deps + build shared/api/web + prune prod + chown
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
WORKDIR /app
RUN corepack enable

# manifest trước → tận dụng layer cache (đổi source không phải cài lại deps)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build

# ---------------------------------------------------------------------------
# 2) runtime — chỉ prodDeps của api (+ shared); SPA phục vụ dạng file tĩnh nên
#    KHÔNG cài deps của @fingate/web, KHÔNG có devDeps/pnpm trong image cuối.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=8080 \
    HOST=0.0.0.0 \
    PROFILE=onprem \
    STORAGE_DRIVER=fs \
    UPLOAD_DIR=/data/uploads \
    WEB_DIST=apps/web/dist \
    COREPACK_HOME=/tmp/corepack
WORKDIR /app
# user không phải root + thư mục uploads, tạo trước phần cài đặt.
RUN corepack enable \
 && groupadd --gid 10001 fingate \
 && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin fingate \
 && mkdir -p /data/uploads \
 && chown -R 10001:10001 /data /app

USER 10001:10001
COPY --chown=10001:10001 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=10001:10001 packages/shared/package.json packages/shared/
COPY --chown=10001:10001 apps/api/package.json apps/api/
COPY --chown=10001:10001 apps/web/package.json apps/web/
# Cài prodDeps rồi xoá cache corepack NGAY trong cùng layer (nếu để lại, cache pnpm
# ~200 MB sẽ nằm trong image).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,uid=10001 \
    pnpm install --prod --frozen-lockfile --filter "@fingate/api..." --store-dir=/pnpm-store \
 && rm -rf /app/.cache /tmp/corepack

# artifact đã build ở stage 1
COPY --from=build --chown=10001:10001 /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=10001:10001 /app/apps/api/dist apps/api/dist
COPY --from=build --chown=10001:10001 /app/apps/web/dist apps/web/dist

# script db/* (migrate · indexes · seed · bootstrap · check:tie …) cho `docker compose run --rm`
COPY --chown=10001:10001 db db
COPY --chown=10001:10001 deploy/docker-entrypoint.sh /usr/local/bin/fingate-entrypoint
RUN chmod +x /usr/local/bin/fingate-entrypoint

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/fingate-entrypoint"]
CMD ["node", "apps/api/dist/server.js"]
