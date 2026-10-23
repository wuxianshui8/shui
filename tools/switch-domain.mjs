// ============================================================
// 备案通过后一键切回「域名 + HTTPS」（默认把按 IP 的临时入口关掉）
//
// 用法（PowerShell）：
//   $env:DEPLOY_HOST = "kd211"                 # ssh 别名或 IP
//   $env:DEPLOY_SUDO = "1"                     # 非 root 账号 + 免密 sudo 时开
//   $env:DOMAIN      = "www.kd211.com"
//   $env:DOMAIN_ALT  = "kd211.com"             # 可选：一起签进同一张证书
//   $env:LETSENCRYPT_EMAIL = "admin@kd211.com"
//   node tools/switch-domain.mjs --dry-run     # 只探测 + 预演，不改服务器
//   node tools/switch-domain.mjs               # 真正切换
//
// 它做四件事：
//   1) 前置探测：域名是否解析到这台机器、**是否仍被「未备案」拦截**
//      （备案没通过会直接拒绝，避免把现在能用的 IP 入口关掉）
//   2) 写过渡配置（域名仅 HTTP + ACME，可选保留 IP 兜底段）→ certbot 签/续证书
//   3) 写最终配置：80 → 443 跳转 + HTTPS + HSTS；默认**移除按 IP 的 default_server**
//   4) 从本机复验：http 必须 301、https 四入口 200
//   任一步失败都会把 Nginx 配置回滚到备份（/etc/nginx/jiajiao.conf.bak）
//
// 其它参数：
//   --keep-ip       保留按 IP 直连的 80 default_server（备案后仍想用 IP 访问）
//   --force         跳过「仍被拦截」判定（换了已备案域名等场景才用）
// ============================================================
import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";

const HOST = process.env.DEPLOY_HOST || "";
const USER = process.env.DEPLOY_USER || "";
const KEY = process.env.DEPLOY_KEY || "";
const SUDO = process.env.DEPLOY_SUDO === "1";
const DOMAIN = (process.env.DOMAIN || "").trim();
const ALT = (process.env.DOMAIN_ALT || "").trim();
const EMAIL = process.env.LETSENCRYPT_EMAIL || "";
const DRY = process.argv.includes("--dry-run");
const KEEP_IP = process.argv.includes("--keep-ip");
const FORCE = process.argv.includes("--force");
// 演练/证书已有效时跳过 certbot（域名被拦截时 HTTP-01 必然失败，但仍要验证配置写入与限速）
const SKIP_CERTBOT = process.argv.includes("--skip-certbot");

const die = (m) => {
  console.error("\n✗ " + m);
  process.exit(1);
};
const step = (s) => console.log("\n=== " + s + " ===");

if (!HOST) die("缺少 DEPLOY_HOST（ssh 别名或 IP）");
if (!DOMAIN) die('缺少 DOMAIN，例如 $env:DOMAIN = "www.kd211.com"');
if (!EMAIL) die('缺少 LETSENCRYPT_EMAIL，例如 $env:LETSENCRYPT_EMAIL = "admin@example.com"');

const TARGET = USER ? `${USER}@${HOST}` : HOST;
const SSH_ARGS = [
  ...(KEY ? ["-i", KEY] : []),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
];
const REMOTE_CMD = SUDO ? "sudo -n bash -s" : "bash -s";

const ssh = (script, { quiet = false } = {}) => {
  const r = spawnSync("ssh", [...SSH_ARGS, TARGET, REMOTE_CMD], { input: script, encoding: "utf8" });
  if (!quiet) {
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
  }
  if (r.status !== 0) die(`远程命令失败（exit ${r.status}）`);
  return r.stdout || "";
};

/* ---------- 1) 前置探测 ---------- */
step("1) 解析与拦截探测");

let addrs = [];
try {
  addrs = (await dns.resolve4(DOMAIN)).sort();
} catch (e) {
  die(`${DOMAIN} 解析失败：${e.code || e.message}`);
}
console.log(`  ${DOMAIN} → ${addrs.join(", ")}`);

const serverIp = ssh(
  `curl -s --max-time 8 https://ifconfig.me || curl -s --max-time 8 https://api.ipify.org || echo`,
  { quiet: true },
).trim();
console.log(`  服务器公网 IP → ${serverIp || "(取不到，跳过比对)"}`);
if (serverIp && addrs.length && !addrs.includes(serverIp)) {
  die(`A 记录（${addrs.join(",")}）与服务器 IP（${serverIp}）不一致，先改 DNS`);
}

// 拦截探测：未备案时 HTTP 会被 302 到 webblock 页、HTTPS 常在 TLS 阶段被重置。
// 注意：拦截可能**按请求间歇生效**（同一秒里 `/` 可能放过、`/api/health` 被拦），
// 所以多点各探两次，任一命中即判定为「仍被拦截」。
const probe = async (url) => {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    return { status: r.status, loc: r.headers.get("location") || "" };
  } catch (e) {
    return { status: 0, err: e.cause?.code || e.message };
  }
};

// ALT 域名可能还没配 A 记录：能解析到本机才签进证书，否则会整张证书申请失败
const resolveToServer = async (name) => {
  try {
    const got = await dns.resolve4(name);
    return serverIp ? got.includes(serverIp) : got.length > 0;
  } catch {
    return false;
  }
};
const usableNames = [DOMAIN];
if (ALT) {
  if (await resolveToServer(ALT)) usableNames.push(ALT);
  else console.log(`  ⚠️ ${ALT} 没有解析到本机，本次不签进证书（补好 A 记录后重跑即可）`);
}

const probes = [
  [`http://${DOMAIN}/`, "HTTP  /"],
  [`http://${DOMAIN}/api/health`, "HTTP  /api/health"],
  [`https://${DOMAIN}/api/health`, "HTTPS /api/health"],
  [`https://${DOMAIN}/m/`, "HTTPS /m/"],
];
let blocked = false;
for (const [url, label] of probes) {
  for (let round = 0; round < 2; round++) {
    const r = await probe(url);
    if (r.status === 0) {
      console.log(`  ${label} → ${r.err}`);
      if (/ECONNRESET|UND_ERR|socket|ETIMEDOUT|EAI_AGAIN/i.test(String(r.err))) blocked = true;
    } else {
      console.log(`  ${label} → ${r.status}${r.loc ? " " + r.loc : ""}`);
      if (/webblock|dnspod\.qcloud\.com/.test(r.loc)) blocked = true;
    }
  }
}


if (blocked && !FORCE) {
  die(
    `仍然被「未备案」拦截（HTTP 302 到 webblock 或 HTTPS 握手被重置）。\n` +
      `  备案没通过前不要切：切完会把现在能用的「按 IP 测试入口」也关掉。\n` +
      `  确认要强切（比如换了已备案域名）再加 --force。`,
  );
}
console.log(blocked ? "  ⚠️ 仍可疑，但你指定了 --force，继续" : "  ✓ 未被拦截（备案已生效）");

/* ---------- 2) 配置模板 ---------- */
const NAMES = usableNames;
const CERT_DIR = `/etc/letsencrypt/live/${DOMAIN}`;
const serverNames = NAMES.join(" ");

// 认证类接口限速块：由 switch-domain 直接写进每个「反代到应用」的 server 块，
// 不再依赖「切完记得再跑 harden-server.sh」；limit_req_zone 由下面 00-hardening.conf 提供
const authLimitBlock = `
    # 认证类接口限速（挡撞库 / 短信轰炸）：30r/m，突发 10（zone 见 /etc/nginx/conf.d/00-hardening.conf）
    location ~ ^/api/auth/(login|login-password|login-account|send-code|wechat) {
        limit_req zone=authlimit burst=10 nodelay;
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
`;

// 全局加固文件（http 上下文）：隐藏版本号 + 定义限速区
// 内容必须与 deploy/harden-server.sh 里写的那份**逐字节一致**（两个脚本谁后跑都行）
const hardeningConf = `server_tokens off;
limit_req_zone $binary_remote_addr zone=authlimit:10m rate=30r/m;
limit_req_status 429;
`;

const ipBlock = KEEP_IP
  ? `
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 8m;

${authLimitBlock}
    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`
  : "";

// 过渡配置：域名仅 HTTP（ACME 用）+ IP 兜底段，签证书期间测试入口不断
const preConf = `
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
${ipBlock}`;

// 最终配置：域名 80→443 + HTTPS + HSTS（含可选 IP 兜底段）
const finalConf = `
# ============================================================
# 家教上门撮合平台 · ${DOMAIN}
#   应用容器只监听 127.0.0.1:4300，全部经本反代对外
#   证书：Let's Encrypt（${NAMES.join(" + ")}），certbot.timer 自动续期
# ============================================================

server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};

    # certbot http-01 续期必须走 80，不能被跳转吃掉
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${serverNames};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=15552000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    client_max_body_size 8m;

${authLimitBlock}
    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location = /api/health {
        access_log off;
        proxy_pass http://127.0.0.1:4300/api/health;
        proxy_set_header Host $host;
    }
}
${ipBlock}`;

if (DRY) {
  step("2) 预演（--dry-run，不改服务器）");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switch-domain-"));
  fs.writeFileSync(path.join(dir, "00-hardening.conf"), hardeningConf, "utf8");
  fs.writeFileSync(path.join(dir, "jiajiao.conf"), finalConf, "utf8");
  console.log(`  过渡配置 server_name：${serverNames}${KEEP_IP ? "（含 IP 兜底段）" : ""}`);
  console.log(
    `  certbot certonly --webroot -w /var/www/certbot ${NAMES.map((n) => "-d " + n).join(" ")} ` +
      `--non-interactive --agree-tos -m ${EMAIL} --keep-until-expiring --expand`,
  );
  console.log(`  最终配置：80→443 + HTTPS + HSTS + 认证限速；IP 直连段：${KEEP_IP ? "保留" : "移除"}`);
  console.log(`  生成的配置已写到本机临时目录供检查：`);
  console.log(`    ${path.join(dir, "jiajiao.conf")}`);
  console.log(`    ${path.join(dir, "00-hardening.conf")}`);
  process.exit(0);
}

/* ---------- 3) 过渡配置 + 签证书（失败自动回滚） ---------- */
step("2) 写过渡配置 + 签证书");

const CONF = "/etc/nginx/sites-available/jiajiao.conf";
const BACKUP = "/etc/nginx/jiajiao.conf.bak";
const rollback = `cp ${BACKUP} ${CONF} 2>/dev/null || true; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true`;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

ssh(`
set -e
mkdir -p /var/www/certbot
cp ${CONF} ${BACKUP} 2>/dev/null || true
echo '${b64(preConf)}' | base64 -d > ${CONF}
ln -sf ${CONF} /etc/nginx/sites-enabled/jiajiao.conf
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t 2>&1; then
  echo "✗ 过渡配置语法错误，回滚"
  ${rollback}
  exit 1
fi
systemctl reload nginx
echo "过渡配置已生效（域名仅 HTTP）；原配置备份在 ${BACKUP}"
`);

const certbotCmd = [
  "certbot certonly --webroot -w /var/www/certbot",
  ...NAMES.map((n) => `-d ${n}`),
  "--non-interactive --agree-tos",
  `-m ${EMAIL}`,
  "--keep-until-expiring",
  // 证书里加新域名（如 apex）必须带 --expand，否则 certbot 会停下来问
  "--expand",
].join(" ");

if (SKIP_CERTBOT) {
  step("2b) 跳过签证书（--skip-certbot）");
  console.log(`  certbot 命令（备案通过后去掉 --skip-certbot 会实际执行）：`);
  console.log(`    ${certbotCmd}`);
  console.log(`  证书目录：${CERT_DIR}（服务器上已有则沿用，无需重签）`);
} else {
  ssh(`
set -eo pipefail
echo "--- certbot ---"
if ! ${certbotCmd} 2>&1 | tail -10; then
  echo "✗ 证书申请失败，回滚配置"
  ${rollback}
  exit 1
fi
if [ ! -f ${CERT_DIR}/fullchain.pem ]; then
  echo "✗ 未找到 ${CERT_DIR}/fullchain.pem，回滚配置"
  ${rollback}
  exit 1
fi
openssl x509 -in ${CERT_DIR}/fullchain.pem -noout -subject -enddate
`);
}

/* ---------- 4) 最终配置 ---------- */
step("3) 写最终配置（80→443 + HTTPS + HSTS）");
ssh(`
set -e
# 先写全局加固（server_tokens off + 限速区），保证下面的 limit_req zone=authlimit 有定义；
# 这台服务器上 deploy/harden-server.sh 写的是同一份内容，二者谁后跑都一致
mkdir -p /etc/nginx/conf.d
echo '${b64(hardeningConf)}' | base64 -d > /etc/nginx/conf.d/00-hardening.conf
echo '${b64(finalConf)}' | base64 -d > ${CONF}
if ! nginx -t 2>&1; then
  echo "✗ 最终配置语法错误，回滚"
  ${rollback}
  exit 1
fi
systemctl reload nginx
sleep 2
echo "最终配置已生效（IP 直连段：${KEEP_IP ? "保留" : "已移除"}）"
echo "--- 服务器本机验证 ---"
curl -s -o /dev/null -w '  http  %{http_code}（期望 301）\\n' -H 'Host: ${DOMAIN}' http://127.0.0.1/api/health
curl -sk -o /dev/null -w '  https %{http_code}（期望 200）\\n' --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/api/health
echo "--- 续期演练 ---"
certbot renew --dry-run 2>&1 | tail -3
`);

/* ---------- 5) 外部复验 ---------- */
step("4) 从本机复验（公网）");
const check = async (url) => {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    return { status: r.status, loc: r.headers.get("location") || "" };
  } catch (e) {
    return { status: 0, err: e.cause?.code || e.message };
  }
};

let fails = 0;
const httpRoot = await check(`http://${DOMAIN}/`);
if (httpRoot.status === 301 && /^https:/.test(httpRoot.loc)) {
  console.log(`  ✓ http → ${httpRoot.status} ${httpRoot.loc}`);
} else {
  fails++;
  console.log(`  ✗ http 期望 301 到 https，实际 ${httpRoot.status} ${httpRoot.loc || httpRoot.err}`);
}
for (const p of ["/api/health", "/admin-vue/", "/m/", "/parent.html"]) {
  const r = await check(`https://${DOMAIN}${p}`);
  if (r.status === 200) {
    console.log(`  ✓ https ${p} 200`);
  } else {
    fails++;
    console.log(`  ✗ https ${p} ${r.status} ${r.err || ""}`);
  }
}

console.log(
  fails === 0
    ? `\n✓ 切换完成：https://${DOMAIN}/ 已可用（http 301 跳转、四入口 200）`
    : `\n✗ 切换后仍有 ${fails} 项未通过，见上面输出（Nginx 配置备份在 ${BACKUP}）`,
);
process.exit(fails === 0 ? 0 : 1);
