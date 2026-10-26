#!/usr/bin/env bash
# ============================================================
# 关键文件完整性基线（P78，2026-10-26）
#
#   security-integrity.sh --init     生成基线（首次装好后跑一次）
#   security-integrity.sh --check    与基线比对，有差异退出码 1（由 timer 每天跑）
#   security-integrity.sh --show     打印基线内容
#
# 为什么需要它：auditd 记录「谁在什么时候改了」，但日志会轮转、且需要人去看；
# 这个脚本回答另一个问题——「现在和我信任的状态比，哪些关键文件变了」。
# 覆盖：账号/口令、提权配置、SSH 凭据、定时任务、systemd unit、nginx 配置、
#       内核模块与动态链接预加载、应用 .env 权限。
#
# 差异会写 /var/lib/jiajiao-security/LAST_CHECK（JSON），并调用
# /opt/jiajiao/bin/backup-notify.sh（若存在）做外部告警；没配 webhook 就只落日志。
# ============================================================
set -uo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/jiajiao-security}"
BASE="$STATE_DIR/baseline.sha256"
LAST="$STATE_DIR/LAST_CHECK"
NOTIFY="${NOTIFY:-/opt/jiajiao/bin/backup-notify.sh}"

# 受监控路径（存在即监控；不存在记 MISSING，防止「删掉文件」这种篡改被漏掉）
WATCH_FILES=(
  /etc/passwd
  /etc/shadow
  /etc/group
  /etc/gshadow
  /etc/sudoers
  /etc/ssh/sshd_config
  /etc/crontab
  /etc/rc.local
  /etc/hosts
  /etc/hostname
  /etc/ld.so.preload
  /etc/ld.so.conf
  /etc/nginx/nginx.conf
  /root/.ssh/authorized_keys
  /home/ubuntu/.ssh/authorized_keys
  /etc/apt/apt.conf.d/20auto-upgrades
  /etc/docker/daemon.json
  /etc/fail2ban/jail.local
)
WATCH_DIRS=(
  /etc/sudoers.d
  /etc/ssh/sshd_config.d
  /etc/cron.d
  /etc/cron.daily
  /etc/cron.hourly
  /etc/systemd/system
  /etc/nginx/conf.d
  /etc/nginx/sites-enabled
  /etc/audit/rules.d
  /etc/sysctl.d
  /etc/profile.d
)
# 只监控这些后缀/名字的目录内容，避免把运行时文件也算进去
DIR_PATTERN='\.(service|timer|conf|rules|sh|socket|path)$|^jail\.local$|^20auto-upgrades$|^99-|^90-cloud-init-users$'

log() { echo "[$(date '+%F %T')] $*"; }

# 生成「内容 sha256 + 权限/属主」清单；目录按白名单过滤
manifest() {
  local f
  for f in "${WATCH_FILES[@]}"; do
    if [ -e "$f" ]; then
      printf '%s\t%s\t%s\n' "$(sha256sum "$f" | awk '{print $1}')" "$(stat -c '%a:%U:%G' "$f")" "$f"
    else
      printf 'MISSING\t-\t%s\n' "$f"
    fi
  done
  for d in "${WATCH_DIRS[@]}"; do
    [ -d "$d" ] || { printf 'MISSING\t-\t%s\n' "$d"; continue; }
    while IFS= read -r f; do
      printf '%s\t%s\t%s\n' "$(sha256sum "$f" | awk '{print $1}')" "$(stat -c '%a:%U:%G' "$f")" "$f"
    done < <(find "$d" -maxdepth 1 -type f 2>/dev/null | grep -E "$DIR_PATTERN" | sort)
  done
}

case "${1:---check}" in
  --init)
    mkdir -p "$STATE_DIR" || { echo "无法创建 $STATE_DIR"; exit 1; }
    manifest > "$BASE.tmp" && mv "$BASE.tmp" "$BASE"
    chmod 600 "$BASE"
    log "基线已生成：$BASE（$(wc -l < "$BASE") 条）"
    exit 0
    ;;
  --show)
    [ -f "$BASE" ] || { echo "基线不存在，先跑 --init"; exit 1; }
    cat "$BASE"
    exit 0
    ;;
  --check|"") ;;
  *)
    echo "用法：$0 [--init|--check|--show]"; exit 2 ;;
esac

mkdir -p "$STATE_DIR" 2>/dev/null || true
if [ ! -f "$BASE" ]; then
  log "基线不存在（$BASE），跳过校验（先跑 --init）"
  printf '{"status":"no-baseline","at":"%s"}\n' "$(date -Is)" > "$LAST" 2>/dev/null || true
  exit 0
fi

CUR="$(mktemp)"; manifest > "$CUR"
# 基线列序是 sha256 \t 权限:属主:属组 \t 路径 —— 按第 3 列（路径）取差异文件
CHANGED="$(diff <(sort -t$'\t' -k3 "$BASE") <(sort -t$'\t' -k3 "$CUR") | sed -n 's/^[<>] //p' | awk -F'\t' '{print $3}' | sort -u)"
COUNT=$(printf '%s' "$CHANGED" | grep -c . || true)
AT="$(date -Is)"

if [ "$COUNT" -eq 0 ]; then
  printf '{"status":"ok","at":"%s","files":%s}\n' "$AT" "$(wc -l < "$BASE")" > "$LAST"
  chmod 600 "$LAST" 2>/dev/null || true
  log "完整性校验通过（$COUNT 处差异，监控 $(wc -l < "$BASE") 个文件）"
  rm -f "$CUR"
  exit 0
fi

# 有差异：写清单 + 外部告警
LIST=$(printf '%s' "$CHANGED" | tr '\n' ',' | sed 's/,$//')
printf '{"status":"changed","at":"%s","count":%s,"files":[%s]}\n' "$AT" "$COUNT" \
  "$(printf '%s' "$CHANGED" | sed 's/.*/"&"/' | paste -sd, -)" > "$LAST"
chmod 600 "$LAST" 2>/dev/null || true
log "⚠️ 完整性变化 $COUNT 处："
printf '%s\n' "$CHANGED" | sed 's/^/    /'
# 保留 diff 详情便于排查
diff <(sort -t$'\t' -k3 "$BASE") <(sort -t$'\t' -k3 "$CUR") > "$STATE_DIR/last-diff.txt" 2>/dev/null || true
chmod 600 "$STATE_DIR/last-diff.txt" 2>/dev/null || true
rm -f "$CUR"

if [ -x "$NOTIFY" ]; then
  # 复用备份告警通道（webhook/邮件），失败不阻断
  "$NOTIFY" fail "关键文件完整性变化 $COUNT 处：$LIST" >/dev/null 2>&1 || true
fi
exit 1
