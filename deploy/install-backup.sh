#!/usr/bin/env bash
# ============================================================
# 安装/更新「每日备份」定时任务（幂等）
#
#   sudo bash deploy/install-backup.sh            # 安装并立即跑一次
#   sudo bash deploy/install-backup.sh --check    # 只看现状，不改
#   sudo bash deploy/install-backup.sh --no-run   # 只装，不立刻跑
#
# 装了什么：
#   /opt/jiajiao/bin/backup-db.sh                备份脚本（DB + 上传卷 + 保留策略 + 防空校验）
#   /opt/jiajiao/bin/backup-notify.sh            失败通知（journal + 可选 webhook）
#   /etc/systemd/system/jiajiao-backup.service   一次性执行
#   /etc/systemd/system/jiajiao-backup.timer     每天 03:20（错峰 ±10 分钟，错过补跑）
#   /etc/systemd/system/jiajiao-backup-notify.service  OnFailure 触发
#
# 通知怎么开：在 /opt/jiajiao/deploy/.env 里加
#   BACKUP_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
# （企业微信/钉钉/飞书机器人、Slack、自建接收端都行，POST 的 JSON 同时带 msgtype 与 content 字段）
# ============================================================
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR=/opt/jiajiao/bin
UNIT_DIR=/etc/systemd/system
MODE="${1:-}"

say() { printf '\n=== %s ===\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "请用 sudo 执行"; exit 1; fi

say "0) 现状"
systemctl list-timers 'jiajiao-backup*' --no-pager 2>/dev/null | head -4 || true
[ -f /var/backups/jiajiao/LAST_STATUS ] && echo "  上次结果：$(cat /var/backups/jiajiao/LAST_STATUS)" || echo "  还没有备份记录"
[ "$MODE" = "--check" ] && { say "--check：不改动"; exit 0; }

say "1) 安装脚本"
install -d -m 755 "$BIN_DIR"
install -m 755 "$SRC_DIR/backup-db.sh"     "$BIN_DIR/backup-db.sh"
install -m 755 "$SRC_DIR/backup-notify.sh" "$BIN_DIR/backup-notify.sh"
bash -n "$BIN_DIR/backup-db.sh" && bash -n "$BIN_DIR/backup-notify.sh"
echo "  已安装到 $BIN_DIR（语法校验通过）"

say "2) 安装 systemd 单元"
install -m 644 "$SRC_DIR/systemd/jiajiao-backup.service"        "$UNIT_DIR/jiajiao-backup.service"
install -m 644 "$SRC_DIR/systemd/jiajiao-backup.timer"          "$UNIT_DIR/jiajiao-backup.timer"
install -m 644 "$SRC_DIR/systemd/jiajiao-backup-notify.service" "$UNIT_DIR/jiajiao-backup-notify.service"
systemctl daemon-reload
systemctl enable --now jiajiao-backup.timer >/dev/null 2>&1
systemctl is-enabled jiajiao-backup.timer
systemctl list-timers 'jiajiao-backup*' --no-pager | head -4

if [ "$MODE" = "--no-run" ]; then
  say "已安装（--no-run：未立即执行）"
  exit 0
fi

say "3) 立即跑一次（验证链路）"
mkdir -p /var/backups/jiajiao
if systemctl start jiajiao-backup.service; then
  systemctl status jiajiao-backup.service --no-pager -n 12 | sed 's/^/  /' || true
else
  echo "  ✗ 备份失败，看 journalctl -u jiajiao-backup"
  journalctl -u jiajiao-backup -n 20 --no-pager | sed 's/^/  /'
  exit 1
fi

say "4) 结果"
ls -lh /var/backups/jiajiao/ | tail -5
cat /var/backups/jiajiao/LAST_STATUS
echo
echo "通知渠道：$(grep -q '^BACKUP_WEBHOOK_URL=.\+' /opt/jiajiao/deploy/.env 2>/dev/null && echo '已配 webhook' || echo '未配（失败只进 journal，可就地加 BACKUP_WEBHOOK_URL）')"
