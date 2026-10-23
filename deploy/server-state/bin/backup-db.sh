#!/usr/bin/env bash
# ============================================================
# 每日数据库 + 上传目录备份（由 jiajiao-backup.timer 触发）
#
#   sudo /opt/jiajiao/bin/backup-db.sh        # 手动跑一次
#
# 行为：
#   1. 容器内 mysqldump（口令取自容器环境变量，不落盘、不出现在 ps 里）
#   2. **防空校验**：gzip 完整性 + 表数量下限，不合格就判失败（避免"备份了个空壳"）
#   3. 原子改名（先写 .tmp，校验通过才 mv），避免留下半截文件
#   4. 上传目录打包（头像/证件图，独立保留份数）
#   5. 保留策略：DB 留 14 份、上传留 7 份（可环境变量覆盖）
#   6. 结果写 /var/backups/jiajiao/LAST_STATUS；失败非零退出 → systemd OnFailure 触发通知
#
# 可覆盖的环境变量：BACKUP_DIR / KEEP_DB / KEEP_UP / CONTAINER / DB / MIN_TABLES
# ============================================================
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/jiajiao}"
KEEP_DB="${KEEP_DB:-14}"
KEEP_UP="${KEEP_UP:-7}"
CONTAINER="${CONTAINER:-jiajiao-mysql-1}"
DB="${DB:-jiajiao}"
MIN_TABLES="${MIN_TABLES:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/jiajiao-$STAMP.sql.gz"

log() { echo "[$(date '+%F %T')] $*"; }

write_status() { # status msg
  printf '{"status":"%s","at":"%s","msg":"%s","file":"%s"}\n' \
    "$1" "$(date -Is)" "${2//\"/\'}" "$OUT" > "$BACKUP_DIR/LAST_STATUS"
}

fail() {
  log "ERROR: $*"
  write_status fail "$*"
  exit 1
}

mkdir -p "$BACKUP_DIR" || { echo "无法创建 $BACKUP_DIR"; exit 1; }

# ---------- 1) dump ----------
log "开始备份 $DB → $OUT"
if ! docker exec "$CONTAINER" sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --databases '"$DB"' 2>/dev/null' \
  | gzip -9 > "$OUT.tmp"; then
  rm -f "$OUT.tmp"
  fail "mysqldump 失败（容器 $CONTAINER 是否在跑？）"
fi

# ---------- 2) 防空校验 ----------
gzip -t "$OUT.tmp" 2>/dev/null || { rm -f "$OUT.tmp"; fail "生成的 gzip 损坏"; }
SIZE=$(stat -c%s "$OUT.tmp")
[ "$SIZE" -gt 2048 ] || { rm -f "$OUT.tmp"; fail "备份文件过小（${SIZE}B），疑似空库"; }
TABLES=$(zcat "$OUT.tmp" | grep -c '^CREATE TABLE')
[ "$TABLES" -ge "$MIN_TABLES" ] || { rm -f "$OUT.tmp"; fail "表数量异常（$TABLES < $MIN_TABLES），拒绝覆盖"; }

mv "$OUT.tmp" "$OUT"
log "DB 备份完成：$OUT（$((SIZE/1024)) KB，$TABLES 张表）"

# ---------- 3) 上传目录（命名卷） ----------
UP_OUT="$BACKUP_DIR/uploads-$STAMP.tar.gz"
if docker volume inspect jiajiao_app-uploads >/dev/null 2>&1; then
  if docker run --rm --user 0 \
      -v jiajiao_app-uploads:/data \
      -v "$BACKUP_DIR":/backup \
      jiajiao-app:latest tar czf "/backup/$(basename "$UP_OUT")" -C /data . 2>/dev/null; then
    log "上传目录备份完成：$UP_OUT（$(du -h "$UP_OUT" | cut -f1)）"
  else
    log "WARN: 上传目录备份失败（不阻断 DB 备份成功状态）"
  fi
fi

# ---------- 4) 保留策略 ----------
prune() { # 目录 通配 保留份数
  local dir="$1" pat="$2" keep="$3" n
  n=$(find "$dir" -maxdepth 1 -name "$pat" -type f | wc -l)
  if [ "$n" -gt "$keep" ]; then
    ls -1t "$dir"/$pat | tail -n +"$((keep + 1))" | while read -r f; do
      rm -f "$f" && log "清理旧备份：$(basename "$f")"
    done
  fi
}
prune "$BACKUP_DIR" 'jiajiao-*.sql.gz' "$KEEP_DB"
prune "$BACKUP_DIR" 'uploads-*.tar.gz' "$KEEP_UP"

# ---------- 5) 收尾 ----------
write_status ok "ok"
log "完成：当前 $(find "$BACKUP_DIR" -maxdepth 1 -name 'jiajiao-*.sql.gz' | wc -l) 份 DB 备份 / $(find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' | wc -l) 份上传备份"
exit 0
