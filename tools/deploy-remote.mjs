// ============================================================
// 把「本机构建好的镜像 + 部署件」推到云服务器并起服务（测试/预发用）
//
// 用法（PowerShell）：
//   $env:DEPLOY_HOST = "kd211"                  # ssh 别名（~/.ssh/config）或 IP
//   $env:DEPLOY_HOST = "kd211"                  # ssh 别名（~/.ssh/config）或 IP
//   $env:DEPLOY_SUDO = "1"                      # 远程用 sudo -n 执行（非 root 账号，需免密 sudo）
//   $env:IMAGE_TAR   = "$env:PI_SCRATCH_DIR\jiajiao-app.tar"
//   node tools/deploy-remote.mjs                # 部署/更新
//   node tools/deploy-remote.mjs --seed         # 只灌演示数据
//   node tools/deploy-remote.mjs --status       # 只看容器与健康状态
//
// 其它可选环境变量：
//   DEPLOY_USER（默认 root / 用别名时忽略）、DEPLOY_KEY（私钥路径，省略则用 ssh 配置）、
//   DEPLOY_DIR（默认 /opt/jiajiao）、DEPLOY_PORT（默认 4300）
//
// 设计要点：
//   - 服务器上不构建镜像（镜像由本机 docker save 导出后上传，避免服务器拉 npm 依赖）
//   - 只上传 compose + schema + .env，不动服务器其它目录
//   - MySQL/Redis 不映射宿主端口；app 只绑 127.0.0.1，安全组只需开 80/443
//   - 国内云主机常见「Docker Hub 不可达」：脚本会先配 registry-mirrors 再拉基础镜像
// ============================================================
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = process.env.DEPLOY_HOST || "";
const USER = process.env.DEPLOY_USER || "";
const KEY = process.env.DEPLOY_KEY || "";
const SUDO = process.env.DEPLOY_SUDO === "1";
const DIR = process.env.DEPLOY_DIR || "/opt/jiajiao";
const PORT = process.env.DEPLOY_PORT || "4300";
const IMAGE_TAR = process.env.IMAGE_TAR || path.join(os.tmpdir(), "jiajiao-app.tar");

/* 发布 tag：APP_IMAGE_TAG > git 短 sha > 时间戳（永远不空）
   用途：镜像不可变，回滚 = 切 tag，不需要重新构建/上传（见 deploy/rollback.sh） */
function releaseTag() {
  const env = (process.env.APP_IMAGE_TAG || "").trim();
  if (env) return env;
  const g = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (g.status === 0) {
    const s = (g.stdout || "").trim();
    if (/^[0-9a-f]{7,40}$/.test(s)) return s;
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `t${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
const RELEASE_TAG = releaseTag();
const MODE = process.argv.includes("--seed")
  ? "seed"
  : process.argv.includes("--status")
    ? "status"
    : "deploy";

if (!HOST) die("缺少 DEPLOY_HOST（ssh 别名或 IP）");
if (KEY && !fs.existsSync(KEY)) die(`DEPLOY_KEY 指向的私钥不存在：${KEY}`);

const SSH_BASE = [
  ...(KEY ? ["-i", KEY] : []),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
];
const TARGET = USER ? `${USER}@${HOST}` : HOST; // 不显式给 DEPLOY_USER 时用 ssh 配置里的用户名
const REMOTE_CMD = SUDO ? "sudo -n bash -s" : "bash -s";
const ssh = (script, { quiet = false } = {}) => {
  const r = spawnSync("ssh", [...SSH_BASE, TARGET, REMOTE_CMD], {
    input: script,
    encoding: "utf8",
  });
  if (!quiet) {
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
  }
  if (r.status !== 0) die(`远程命令失败（exit ${r.status}）`);
  return r.stdout || "";
};
const scp = (local, remote) => {
  const r = spawnSync("scp", [...SSH_BASE, local, `${TARGET}:${remote}`], { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "");
    die(`scp 失败：${local}`);
  }
};

function die(msg) {
  console.error("\n✗ " + msg);
  process.exit(1);
}
const step = (s) => console.log("\n=== " + s + " ===");

/* ---------- 0. 本地前置检查 ---------- */
const envPath = path.join(ROOT, "deploy", ".env");
if (!fs.existsSync(envPath)) {
  die("缺少 deploy/.env：先 cp deploy/.env.example deploy/.env 并填 AUTH_SECRET / DB_PASSWORD");
}
const envText = fs.readFileSync(envPath, "utf8");
for (const key of ["AUTH_SECRET", "DB_PASSWORD"]) {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(envText);
  const v = (m?.[1] || "").trim();
  if (!v || /please-change-me|<|xxx/i.test(v)) die(`deploy/.env 的 ${key} 未填或仍是占位值`);
  if (key === "AUTH_SECRET" && v.length < 32) die("AUTH_SECRET 必须 >= 32 字符");
  if (key === "DB_PASSWORD" && v.length < 16) die("DB_PASSWORD 建议 >= 16 字符");
}

/* ---------- 1. 只读状态 ---------- */
if (MODE === "status") {
  step("容器状态");
  ssh(`
set -e
if command -v docker >/dev/null 2>&1; then
  cd ${DIR}/deploy 2>/dev/null && docker compose -f docker-compose.prod.yml ps || true
  echo "--- health ---"
  curl -fsS http://127.0.0.1:${PORT}/api/health || echo "health 不通"
  if [ -x ${DIR}/bin/rollback.sh ]; then
    echo "--- 版本与回滚台账 ---"
    bash ${DIR}/bin/rollback.sh --list || true
  else
    echo "（${DIR}/bin/rollback.sh 未安装：先跑一次部署）"
  fi
else
  echo "服务器上没有 docker"
fi
`);
  process.exit(0);
}

/* ---------- 2. 只灌种子 ---------- */
if (MODE === "seed") {
  step("灌演示数据");
  ssh(`
set -e
cd ${DIR}/deploy
docker compose -f docker-compose.prod.yml run --rm seed
`);
  process.exit(0);
}

/* ---------- 3. 完整部署 ---------- */
if (!fs.existsSync(IMAGE_TAR)) die(`找不到镜像包：${IMAGE_TAR}（先 docker save -o "${IMAGE_TAR}" jiajiao-app:latest）`);

console.log(`发布 tag: jiajiao-app:${RELEASE_TAG}  （回滚：bash ${DIR}/bin/rollback.sh --previous）`);
step("0) 远端基本信息");
ssh(`
set -e
. /etc/os-release 2>/dev/null || true
echo "系统：\${PRETTY_NAME:-unknown}  $(uname -m)"
echo "内核：$(uname -r)"
if command -v docker >/dev/null 2>&1; then docker --version; docker compose version 2>/dev/null || echo "compose: 无插件"; else echo "docker：未安装"; fi
echo "磁盘：$(df -h / | tail -1 | awk '{print $4\" 可用 / \"$2\" 总量\"}')"
echo "端口占用："
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(80|443|${PORT})\\b' || echo "  80/443/${PORT} 均空闲"
`);

step("1) 本地打源码包");
const tgz = path.join(os.tmpdir(), "jiajiao-src.tgz");
if (fs.existsSync(tgz)) fs.rmSync(tgz);
const tar = spawnSync("tar", [
  "-czf", tgz,
  "-C", ROOT,
  "deploy/docker-compose.prod.yml",
  "deploy/nginx-jiajiao.conf.example",
  "deploy/backup-db.sh",
  "deploy/backup-notify.sh",
  "deploy/install-backup.sh",
  "deploy/security-integrity.sh",
  "deploy/rollback.sh",
  "deploy/systemd/jiajiao-security-integrity.service",
  "deploy/systemd/jiajiao-security-integrity.timer",
  "apps/api-nest/db/schema.mysql.sql",
  "apps/api-nest/db/seed-min.mjs",
], { encoding: "utf8" });
if (tar.status !== 0) {
  process.stderr.write(tar.stderr || "");
  die("打包失败");
}
console.log(`  ${tgz}  ${(fs.statSync(tgz).size / 1024).toFixed(1)} KB`);

step("2) 上传镜像与部署件");
const t0 = Date.now();
scp(IMAGE_TAR, "/tmp/jiajiao-app.tar");
console.log(`  镜像 ${(fs.statSync(IMAGE_TAR).size / 1024 / 1024).toFixed(1)} MB ↑ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
scp(tgz, "/tmp/jiajiao-src.tgz");
scp(envPath, "/tmp/jiajiao.env");
console.log("  源码包 + .env 已上传");

step("3) 检查 Docker + 配镜像加速 + 预拉基础镜像");
ssh(`
set -e
if ! command -v docker >/dev/null 2>&1; then
  echo "未安装 docker，用发行版仓库安装（国内不要用 get.docker.com）"
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y >/dev/null
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y docker docker-compose-plugin || dnf install -y docker docker-compose
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker docker-compose-plugin || yum install -y docker docker-compose
  fi
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
fi
command -v docker >/dev/null 2>&1 || { echo "docker 不可用，请手动安装后重跑"; exit 1; }
docker --version
(docker compose version 2>/dev/null || docker-compose version 2>/dev/null) | head -1

# Docker Hub 在国内云主机常不可达：配 registry-mirrors（不改其它已有配置）
if ! grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com", "https://docker.m.daocloud.io"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
JSON
  systemctl restart docker
  sleep 2
  echo "已写入 registry-mirrors"
fi
echo "--- 预拉基础镜像（走镜像加速）---"
docker pull mysql:8.0 | tail -2
docker pull redis:7-alpine | tail -2
`);

step("4) 载入镜像 + 落部署件");
ssh(`
set -e
# 首次接入 tag 策略：必须在 docker load 覆盖 latest 之前留住旧镜像，否则没有回滚目标
if [ -f ${DIR}/deploy/.env ] && ! grep -q '^APP_IMAGE_TAG=' ${DIR}/deploy/.env \
   && docker image inspect jiajiao-app:latest >/dev/null 2>&1; then
  LEG="legacy-$(date +%Y%m%d%H%M%S)"
  docker tag jiajiao-app:latest "jiajiao-app:$LEG"
  echo "  首次接入 tag 策略：旧镜像已留为 jiajiao-app:$LEG（回滚退路）"
fi
docker load -i /tmp/jiajiao-app.tar
mkdir -p ${DIR}
tar xzf /tmp/jiajiao-src.tgz -C ${DIR}
# 上传包在 Windows 上打包，解出来的文件可能带 666：这些文件会被 root 的定时任务与 compose 使用，
# 一律收紧到 644（.env 是 600 不会命中；bin/ 下的安装副本单独 755）
find ${DIR}/deploy -xdev -type f -perm -0002 -exec chmod 644 {} + 2>/dev/null || true
# 运维脚本同步到 ${DIR}/bin（此前只上传 compose/schema，导致备份脚本在服务器上是旧版）
mkdir -p ${DIR}/bin
for f in "${DIR}"/deploy/backup-db.sh "${DIR}"/deploy/backup-notify.sh "${DIR}"/deploy/security-integrity.sh "${DIR}"/deploy/rollback.sh; do
  [ -f "$f" ] || continue
  install -m 755 "$f" "${DIR}/bin/$(basename "$f")"
done
# 完整性校验 unit：服务端常驻排程（不存在则跳过，装好后由 harden-server.sh 启用）
for f in "${DIR}"/deploy/systemd/jiajiao-security-integrity.service "${DIR}"/deploy/systemd/jiajiao-security-integrity.timer; do
  [ -f "$f" ] || continue
  install -m 644 "$f" /etc/systemd/system/
done
systemctl daemon-reload 2>/dev/null || true
systemctl enable --now jiajiao-security-integrity.timer 2>/dev/null || true
# .env 落地前合并：保留服务器独有键（此前直接覆盖，会清掉服务器上手工加的红线配置）
cp -a /tmp/jiajiao.env /tmp/jiajiao.env.new
if [ -f ${DIR}/deploy/.env ]; then
  cp -a ${DIR}/deploy/.env "${DIR}/deploy/.env.bak-$(date +%Y%m%d%H%M%S)"
  kept=""
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    k=\${line%%=*}
    case "$k" in *[!A-Za-z0-9_]*) continue ;; esac
    if ! grep -q "^$k=" /tmp/jiajiao.env.new; then
      printf '%s\\n' "$line" >> /tmp/jiajiao.env.new
      kept="$kept $k"
    fi
  done < ${DIR}/deploy/.env
  if [ -n "$kept" ]; then echo "  已保留服务器独有键:$kept"; fi
  ls -1t ${DIR}/deploy/.env.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
fi
install -m 600 /tmp/jiajiao.env.new ${DIR}/deploy/.env
rm -f /tmp/jiajiao.env.new
# --- 发布 tag：镜像不可变，回滚 = 切 tag 重新 up（deploy/rollback.sh）---
TAG="${RELEASE_TAG}"
docker image inspect jiajiao-app:latest >/dev/null 2>&1 || { echo "x 载入的镜像包没有 jiajiao-app:latest 标签，无法建发布 tag"; exit 1; }
docker tag jiajiao-app:latest "jiajiao-app:$TAG"
if grep -q '^APP_IMAGE_TAG=' ${DIR}/deploy/.env; then
  sed -i "s|^APP_IMAGE_TAG=.*|APP_IMAGE_TAG=$TAG|" ${DIR}/deploy/.env
else
  printf 'APP_IMAGE_TAG=%s\n' "$TAG" >> ${DIR}/deploy/.env
fi
echo "  发布 tag：jiajiao-app:$TAG"
printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" deploy ok "$TAG" "image=$(docker image inspect -f '{{.Id}}' "jiajiao-app:$TAG" | cut -c8-19)" >> ${DIR}/releases.log
echo "  已记入 ${DIR}/releases.log"
rm -f /tmp/jiajiao-app.tar /tmp/jiajiao-src.tgz /tmp/jiajiao.env
cd ${DIR}/deploy
DC="docker compose"
docker compose version >/dev/null 2>&1 || DC="docker-compose"
echo "$DC -f docker-compose.prod.yml up -d --no-build"
$DC -f docker-compose.prod.yml up -d --no-build
`);

step("5) 等健康");
let healthy = false;
for (let i = 0; i < 40; i++) {
  const out = ssh(`curl -fsS http://127.0.0.1:${PORT}/api/health || true`, { quiet: true }).trim();
  if (out.includes('"ok"') || out.includes('"status":"ok"')) {
    console.log("  health ok: " + out.slice(0, 160));
    healthy = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!healthy) {
  console.error("\n✗ health 20 分钟未就绪 —— 尝试自动回滚到上一版");
  ssh(`bash ${DIR}/bin/rollback.sh --previous || true`);
  die("部署失败已尝试回滚；用 `bash ${DIR}/bin/rollback.sh --list` 看当前版本与 releases.log");
}
// 健康后清理旧镜像，只留最近 N 个发布 tag（JIAJIAO_KEEP_IMAGES，默认 3）
ssh(`bash ${DIR}/bin/rollback.sh --prune || true`, { quiet: true });

step("6) 容器与入口");
ssh(`
set -e
cd ${DIR}/deploy
DC="docker compose"; docker compose version >/dev/null 2>&1 || DC="docker-compose"
$DC -f docker-compose.prod.yml ps
echo "--- 本机入口（经 Nginx 前先直连验证）---"
for p in /api/health /admin-vue/ /m/ /parent.html; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}$p)
  echo "  $code  $p"
done
`);

console.log(`
下一步（HTTPS，需先把域名 A 记录指到 ${HOST} 且安全组放行 443）：
  1) 把 deploy/nginx-jiajiao.conf.example 里的 DOMAIN 换成真实域名
  2) 服务器上：apt-get install -y nginx certbot python3-certbot-nginx
  3) certbot --nginx -d <域名> --agree-tos -m <邮箱> --redirect
  4) 灌演示数据：node tools/deploy-remote.mjs --seed
`);
