#!/usr/bin/env bash
# ============================================================
# 备份失败通知（由 jiajiao-backup.service 的 OnFailure= 触发）
#
#   做法：
#     1. 把 LAST_STATUS 里的失败原因写进 journal（error 级别，`journalctl -p err -u jiajiao-backup`）
#     2. 若 /opt/jiajiao/deploy/.env 里配了 BACKUP_WEBHOOK_URL，则 POST 一条 JSON
#        （企业微信/钉钉/飞书机器人、Slack、或你自己的接收端都能用）
#
#   ⚠️ 平台自己的「站内消息」需要登录态，脚本里拿不到，所以这里用 webhook + journal 两条路；
#      没配 webhook 时至少 journal 里有 error，RUNBOOK §2 的巡检命令能看到。
# ============================================================
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/jiajiao}"
ENV_FILE="${ENV_FILE:-/opt/jiajiao/deploy/.env}"
HOST_TAG="${HOST_TAG:-kd211}"

status_json=""
[ -f "$BACKUP_DIR/LAST_STATUS" ] && status_json="$(cat "$BACKUP_DIR/LAST_STATUS")"
msg="备份任务失败（主机 $HOST_TAG）"
[ -n "$status_json" ] && msg="$msg：$status_json"

# 1) journal（error 级别）
echo "[backup-notify] $msg" >&2

# 2) webhook（可选）：用 python3 精确转义 JSON（嵌套引号不转义会让机器人解析失败）
webhook=""
if [ -f "$ENV_FILE" ]; then
  webhook="$(grep -E '^BACKUP_WEBHOOK_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
fi

if [ -n "${webhook:-}" ]; then
  payload="$(MSG="$msg" python3 -c 'import json,os; m=os.environ["MSG"]; print(json.dumps({"msgtype":"text","text":{"content":m},"content":m}, ensure_ascii=False))')"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Content-Type: application/json' -d "$payload" "$webhook" || echo "000")
  echo "[backup-notify] webhook HTTP $code" >&2
else
  echo "[backup-notify] 未配置 BACKUP_WEBHOOK_URL（见 deploy/.env.example），仅记录 journal" >&2
fi

exit 0
