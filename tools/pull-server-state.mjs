// ============================================================
// 把服务器上「直接改过」的配置抓回仓库（回写 / 漂移检查）
//
// 用法（本机）：
//   $env:DEPLOY_HOST = "kd211"; $env:DEPLOY_SUDO = "1"
//   node tools/pull-server-state.mjs            # 抓回 deploy/server-state/ 并写 MANIFEST
//   node tools/pull-server-state.mjs --check    # 只比对：仓库与服务器不一致则非零退出
//   node tools/pull-server-state.mjs --list     # 只列出会抓哪些文件
//
// 为什么要有它：
//   约定「配置类改动可以直接在服务器上做」，但那会让仓库与服务器漂移。
//   固定流程：改服务器 → 跑本脚本回写 → git diff 看变化 → 提交。
//   --check 用来随时确认「仓库里的期望状态」与「线上真实状态」是否一致。
//
// ⚠️ 只抓配置，**绝不抓 `.env`**（含 AUTH_SECRET / DB_PASSWORD / webhook 等密钥）。
// ============================================================
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(ROOT, "deploy", "server-state");

const HOST = process.env.DEPLOY_HOST || "";
const USER = process.env.DEPLOY_USER || "";
const KEY = process.env.DEPLOY_KEY || "";
const SUDO = process.env.DEPLOY_SUDO === "1";
const MODE = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--list")
    ? "list"
    : "pull";

// 要回写的文件：远程路径 → 仓库内相对路径（不含任何 .env）
const FILES = [
  ["/etc/nginx/sites-available/jiajiao.conf", "nginx/jiajiao.conf"],
  ["/etc/nginx/conf.d/00-hardening.conf", "nginx/00-hardening.conf"],
  ["/etc/ssh/sshd_config.d/99-hardening.conf", "ssh/99-hardening.conf"],
  ["/etc/fail2ban/jail.local", "fail2ban/jail.local"],
  ["/etc/sysctl.d/99-hardening.conf", "sysctl/99-hardening.conf"],
  ["/etc/docker/daemon.json", "docker/daemon.json"],
  ["/etc/systemd/system/jiajiao-backup.service", "systemd/jiajiao-backup.service"],
  ["/etc/systemd/system/jiajiao-backup.timer", "systemd/jiajiao-backup.timer"],
  ["/etc/systemd/system/jiajiao-backup-notify.service", "systemd/jiajiao-backup-notify.service"],
  ["/opt/jiajiao/bin/backup-db.sh", "bin/backup-db.sh"],
  ["/opt/jiajiao/bin/backup-notify.sh", "bin/backup-notify.sh"],
  ["/opt/jiajiao/deploy/docker-compose.prod.yml", "compose/docker-compose.prod.yml"],
];

// 密钥泄露防护：只认「行首赋值且确实有值」或整段 PEM 私钥；
// 脚本里引用变量名（如 grep '^BACKUP_WEBHOOK_URL='）不算
const SECRET_PATTERNS = [
  /^\s*(AUTH_SECRET|DB_PASSWORD|MYSQL_PASSWORD|BACKUP_WEBHOOK_URL|TENCENT_SECRET_KEY|TENCENT_SMS_SECRET_KEY|WECHAT_PAY_PRIVATE_KEY|WECHAT_SECRET)\s*=\s*\S+/m,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const die = (m) => {
  console.error("\n✗ " + m);
  process.exit(1);
};
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

if (MODE === "list") {
  console.log("会抓取以下文件（不含 .env）：");
  for (const [remote, local] of FILES) console.log(`  ${remote}\n    → deploy/server-state/${local}`);
  process.exit(0);
}

if (!HOST) die("缺少 DEPLOY_HOST（ssh 别名或 IP）");
const TARGET = USER ? `${USER}@${HOST}` : HOST;
const SSH_ARGS = [
  ...(KEY ? ["-i", KEY] : []),
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
];
const REMOTE_CMD = SUDO ? "sudo -n bash -s" : "bash -s";

const ssh = (script) => {
  const r = spawnSync("ssh", [...SSH_ARGS, TARGET, REMOTE_CMD], { input: script, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "");
    die(`远程命令失败（exit ${r.status}）`);
  }
  return r.stdout || "";
};

const MARK = (i) => `@@FILE:${i}@@`;
const remoteScript = [
  "set -u",
  ...FILES.map(
    ([remote], i) => `echo '${MARK(i)}'\nif [ -f ${remote} ]; then cat ${remote}; else echo '__MISSING__'; fi`,
  ),
].join("\n");
const raw = ssh(remoteScript);

const captured = [];
for (let i = 0; i < FILES.length; i++) {
  const start = raw.indexOf(MARK(i));
  if (start < 0) continue;
  const next = i + 1 < FILES.length ? raw.indexOf(MARK(i + 1)) : raw.length;
  const body = raw.slice(start + MARK(i).length, next).replace(/^\r?\n/, "");
  captured.push({ remote: FILES[i][0], local: FILES[i][1], body });
}

if (captured.length !== FILES.length) {
  die(`只取回 ${captured.length}/${FILES.length} 个文件，检查路径或 sudo 权限`);
}
const missing = captured.filter((c) => c.body.trim() === "__MISSING__");
if (missing.length) {
  die(`服务器上缺这些文件：${missing.map((m) => m.remote).join(", ")}（是否还没跑过对应安装脚本？）`);
}
for (const c of captured) {
  if (SECRET_PATTERNS.some((re) => re.test(c.body))) {
    die(`捕获内容里出现疑似密钥（赋值或私钥）：${c.remote}（已中止，检查是否误抓 .env）`);
  }
}

/* ---------- --check：只比对 ---------- */
if (MODE === "check") {
  let drift = 0;
  console.log(`比对 ${captured.length} 个文件：${TARGET}\n`);
  for (const c of captured) {
    const p = path.join(OUT_DIR, c.local);
    const repo = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    if (repo === null) {
      console.log(`  ✗ 仓库里还没有：deploy/server-state/${c.local}`);
      drift++;
    } else if (repo !== c.body) {
      console.log(`  ✗ 不一致：${c.remote}（仓库 ${sha(repo)} / 服务器 ${sha(c.body)}）`);
      drift++;
    } else {
      console.log(`  ✓ ${c.remote}`);
    }
  }
  console.log(
    drift === 0
      ? "\n✓ 仓库期望状态与服务器一致"
      : `\n✗ 有 ${drift} 个文件不一致 —— 若是刚在服务器上改的，跑 node tools/pull-server-state.mjs 回写并提交`,
  );
  process.exit(drift === 0 ? 0 : 1);
}

/* ---------- pull：写入仓库 ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const c of captured) {
  const p = path.join(OUT_DIR, c.local);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c.body, "utf8");
}

const manifest = [
  "# 服务器配置现状（自动生成，勿手改）",
  "",
  `- 抓取时间：${new Date().toISOString()}`,
  `- 来源主机：\`${TARGET}\``,
  "- 生成工具：`node tools/pull-server-state.mjs`（`npm run sync:server-state`）",
  "- 用途：把「直接在服务器上改过的配置」回写进仓库，便于 diff / 回滚 / 审计",
  "- **不包含** `deploy/.env` 等任何密钥文件",
  "",
  "| 服务器路径 | 仓库内文件 | sha256(16) |",
  "| --- | --- | --- |",
  ...captured.map((c) => `| \`${c.remote}\` | \`${c.local}\` | \`${sha(c.body)}\` |`),
  "",
  "改了服务器上的配置后：跑一次 `npm run sync:server-state` → `git diff` 看变化 → 提交。",
  "",
].join("\n");
fs.writeFileSync(path.join(OUT_DIR, "MANIFEST.md"), manifest, "utf8");

console.log(`已回写 ${captured.length} 个文件到 deploy/server-state/`);
for (const c of captured) console.log(`  ${c.remote}  ${sha(c.body)}`);
console.log("\n下一步：git diff 看变化 → 提交（这是「服务器改动进仓库」的唯一入口）");
