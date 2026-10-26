#!/usr/bin/env bash
# 发布回滚 / 版本台账（服务器端，装在 /opt/jiajiao/bin/rollback.sh）
#
# 用法:
#   rollback.sh --list        看当前版本、本机可用镜像、最近发布记录
#   rollback.sh <tag>         切到指定镜像 tag（健康校验失败自动退回原版本）
#   rollback.sh --previous    回到 releases.log 里上一次成功发布的版本
#
# 为什么基于 tag 回滚: 镜像不可变，回滚不需要重新构建/上传，只改
# deploy/.env 的 APP_IMAGE_TAG 再 up -d，几十秒内可退。DB 变更必须
# 走向后兼容的两步法（先加列不删列），否则回滚会读到不存在的列。
set -euo pipefail

DIR=${JIAJIAO_DIR:-/opt/jiajiao}
ENVF=$DIR/deploy/.env
LOG=$DIR/releases.log
PORT=${PORT:-4300}
COMPOSE_FILE=$DIR/deploy/docker-compose.prod.yml
KEEP=${JIAJIAO_KEEP_IMAGES:-3}

die() { echo "x $*" >&2; exit 1; }
info() { echo "  $*"; }

[ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE"
[ -f "$ENVF" ] || die "找不到 $ENVF"

DC="docker compose"
docker compose version >/dev/null 2>&1 || DC="docker-compose"
compose() { $DC -f "$COMPOSE_FILE" "$@"; }

current_tag() {
  local t
  t=$(grep -E '^APP_IMAGE_TAG=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true)
  [ -n "$t" ] || t=latest
  printf '%s' "$t"
}

set_tag() {
  local tag=$1
  [ "$(id -u)" = 0 ] || die "改 $ENVF 需要 root"
  if grep -qE '^APP_IMAGE_TAG=' "$ENVF"; then
    sed -i "s|^APP_IMAGE_TAG=.*|APP_IMAGE_TAG=${tag}|" "$ENVF"
  else
    printf 'APP_IMAGE_TAG=%s\n' "$tag" >> "$ENVF"
  fi
}

image_exists() {
  docker image inspect "jiajiao-app:$1" >/dev/null 2>&1
}

# 已知 tag（按创建时间新→旧，排除 latest / <none>）
known_tags() {
  docker images jiajiao-app --format '{{.Tag}}' 2>/dev/null \
    | grep -vE '^(latest|<none>)$' || true
}

health_ok() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"ok"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

record() { # record <event> <result> <tag> <extra>
  # 台账固定五列 TSV: 时间 / 事件 / 结果 / 镜像tag / 补充
  # 第 4 列恒为 tag —— --previous 靠它找上一版，别把别的东西塞进去
  local line
  # 注意：双引号里的 \t 不会变成制表符，必须用 printf
  line=$(printf '%s\t%s\t%s\t%s\t%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "${4:-}")
  printf '%s\n' "$line" >> "$LOG" 2>/dev/null \
    || echo "! 写不进 $LOG（跳过台账，不影响回滚）" >&2
  return 0
}

prune_images() {
  local cur t
  cur=$(current_tag)
  known_tags | tail -n +$((KEEP + 1)) | while IFS= read -r t; do
    [ -n "$t" ] || continue
    [ "$t" = "$cur" ] && continue
    if docker rmi "jiajiao-app:$t" >/dev/null 2>&1; then
      info "已清理旧镜像 jiajiao-app:$t"
    fi
  done
  return 0
}

list_all() {
  echo "=== 当前版本 ==="
  info "APP_IMAGE_TAG=$(current_tag)   (deploy/.env)"
  compose ps 2>/dev/null || true
  echo
  echo "=== 本机 jiajiao-app 镜像 ==="
  docker images jiajiao-app --format '  {{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}' 2>/dev/null || echo "  无"
  echo
  echo "=== 最近发布记录（releases.log，倒序 10 条）==="
  if [ -f "$LOG" ]; then tail -n 10 "$LOG" | tac | sed 's/^/  /'; else echo "  无"; fi
  echo
  echo "可用: rollback.sh <tag> | rollback.sh --previous"
}

previous_tag() {
  local cur
  cur=$(current_tag)
  [ -f "$LOG" ] || return 1
  # 从发布台账里取「上一次成功的版本」，跳过当前版本
  awk -F'\t' '$3=="ok" {print $4}' "$LOG" | grep -vx "$cur" | tail -1
}

switch_to() { # switch_to <tag> <reason>
  local target=$1 reason=$2 prev
  image_exists "$target" || die "本机没有镜像 jiajiao-app:$target（rollback.sh --list 看可用 tag）"
  prev=$(current_tag)
  [ "$target" = "$prev" ] && { info "当前已经是 $target，无需回滚"; return 0; }

  echo "切换镜像: $prev -> $target  ($reason)"
  set_tag "$target"
  compose up -d --no-build app
  if health_ok; then
    info "健康校验通过（/api/health ok）"
    record "$reason" ok "$target" "from=$prev"
    prune_images
    return 0
  fi

  echo "x 新版本健康校验失败 → 自动退回 $prev" >&2
  compose logs --tail 40 app >&2 || true
  set_tag "$prev"
  compose up -d --no-build app
  if health_ok; then
    info "已退回 $prev 并恢复健康"
    record "$reason" reverted "$target" "from=$prev health=failed"
    return 1
  fi
  echo "x 退回后仍不健康，需人工介入（docker compose logs app）" >&2
  record "$reason" failed "$target" "from=$prev revert=failed"
  return 1
}

case "${1:---list}" in
  --list | -l) list_all ;;
  --prune) prune_images ;;
  --previous | -p)
    t=$(previous_tag || true)
    [ -n "${t:-}" ] || die "releases.log 里没有可回的上一个版本，请显式给 tag"
    switch_to "$t" "rollback"
    ;;
  -h | --help) sed -n '2,20p' "$0" ;;
  -*) die "未知参数 $1（--list / --previous / <tag>）" ;;
  *) switch_to "$1" "rollback" ;;
esac
