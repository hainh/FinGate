#!/bin/sh
# FinGate — backup MongoDB cho Profile O (docs/04_architecture.md §13).
#
# Cài cron hệ thống (chạy nightly, giữ 14 bản gần nhất):
#   0 2 * * * /opt/fingate/deploy/backup.sh >> /var/log/fingate-backup.log 2>&1
#
# Restore:
#   gunzip -c deploy/backups/fingate-<stamp>.archive.gz \
#     | docker compose -f deploy/compose.yml exec -T mongo \
#         mongorestore --uri="mongodb://localhost:27017" --archive --gzip --drop \
#         --nsFrom='fingate.*' --nsTo='fingate_restore.*'
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/backups"
mkdir -p "$OUT"

STAMP="$(date +%Y-%m-%d_%H%M)"
FILE="$OUT/fingate-$STAMP.archive.gz"

docker compose -f "$DIR/compose.yml" exec -T mongo \
  mongodump --uri="mongodb://localhost:27017/fingate" --gzip --archive > "$FILE"

echo "[fingate] backup xong: $FILE ($(du -h "$FILE" | cut -f1))"

# retention: 14 nightly gần nhất
ls -1t "$OUT"/fingate-*.archive.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
