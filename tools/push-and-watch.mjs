// ============================================================
// 推送并盯 Actions 首跑（token 只从环境变量读取，绝不写进 .git/config）
//
//   用途：一次性完成「推送 → 等待 workflow 跑完 → 打印每个 job / 失败步骤日志」，
//   避免手动把 token 拼进 remote URL（那样会留在 .git/config 里，随仓库泄露）。
//
// 用法（PowerShell）：
//   $env:GH_TOKEN = "ghp_xxx"          # 需要 repo + workflow 两个 scope
//   node tools/push-and-watch.mjs
//   可选：BRANCH=main REMOTE=origin TIMEOUT_MIN=25 POLL_SEC=15
//         SKIP_WATCH=1   只推送不等待
//
// 说明：GitHub 规定通过 HTTPS 推送 .github/workflows/* 必须带 workflow scope，
//       缺该 scope 时推送会被拒；本脚本会识别这种错误并打印补救步骤。
// ============================================================
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REMOTE = process.env.REMOTE || "origin";
const BRANCH = process.env.BRANCH || "main";
const TIMEOUT_MIN = Number(process.env.TIMEOUT_MIN || 25);
const POLL_SEC = Number(process.env.POLL_SEC || 15);
const SKIP_WATCH = process.env.SKIP_WATCH === "1";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

const GIT = fs.existsSync("D:/shui/tools/git/cmd/git.exe") ? "D:/shui/tools/git/cmd/git.exe" : "git";
const git = (args, opts = {}) =>
  execFileSync(GIT, args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();

function die(msg) {
  console.error("\n✗ " + msg);
  process.exit(1);
}

/* ---------- 0. 前置检查 ---------- */
if (!TOKEN) {
  die("缺少 token：请先设置环境变量 GH_TOKEN（需要 repo + workflow 两个 scope）\n" +
    "   PowerShell: $env:GH_TOKEN = \"ghp_xxx\"");
}

const remoteUrl = git(["remote", "get-url", REMOTE]);
if (/ghp_|github_pat_|AUTHORIZATION/.test(remoteUrl)) {
  console.log("⚠️ 远端 URL 里带着凭据，正在改成干净地址（token 不该留在 .git/config）");
  const clean = remoteUrl.replace(/\/\/[^@/]+@/, "//");
  git(["remote", "set-url", REMOTE, clean]);
  console.log("   已改为：" + clean);
} else {
  console.log("远端：" + remoteUrl);
}
const cfg = fs.readFileSync(path.join(ROOT, ".git", "config"), "utf8");
if (/ghp_|github_pat_/.test(cfg)) die(".git/config 里仍有 token，请先执行 git remote set-url origin <干净地址>");

const localBranch = git(["branch", "--show-current"]);
const headSha = git(["rev-parse", "HEAD"]);
const commits = git(["rev-list", "--count", "HEAD"]);
const repoSlug = (() => {
  const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(\.git)?$/.exec(git(["remote", "get-url", REMOTE]));
  return m ? `${m[1]}/${m[2]}` : "";
})();
console.log(`待推送：${commits} 个提交，本地分支 ${localBranch} → ${REMOTE}/${BRANCH}，HEAD ${headSha.slice(0, 8)}`);
if (repoSlug) console.log(`仓库：${repoSlug}`);

/* ---------- 1. 推送 ---------- */
const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const push = spawnSync(
  GIT,
  [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
    "push",
    ...(process.env.FORCE === "1" ? ["--force-with-lease"] : []),
    "-u",
    REMOTE,
    `${localBranch}:${BRANCH}`,
  ],
  { cwd: ROOT, encoding: "utf8" },
);
const pushOut = `${push.stdout ?? ""}${push.stderr ?? ""}`;
process.stdout.write(pushOut);

if (push.status !== 0) {
  if (/without `workflow` scope|workflow scope/i.test(pushOut)) {
    console.error("\n✗ 推送被拒：token 缺少 workflow scope（GitHub 不允许用无该 scope 的 PAT 推送 .github/workflows/*）");
    console.error("   补救（30 秒，二选一）：");
    console.error("   A. 复用现有 token：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)");
    console.error("      → 找到该 token → Edit → 勾上 workflow（repo 保留）→ Update token → 重跑本脚本");
    console.error("   B. 新建 classic token，勾 repo + workflow，然后：$env:GH_TOKEN = \"新 token\"; node tools/push-and-watch.mjs");
    process.exit(2);
  }
  die("推送失败（见上方 git 输出）");
}
console.log("✓ 推送成功");

/* ---------- 2. 盯 Actions ---------- */
if (SKIP_WATCH) process.exit(0);
if (!repoSlug) die("无法从远端解析 owner/repo，无法查询 Actions");

const api = async (p) => {
  const r = await fetch(`https://api.github.com${p}`, {
    headers: { Authorization: `token ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "pi-desktop" },
  });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
let run = null;

console.log(`\n等待 GitHub Actions 首跑（最多 ${TIMEOUT_MIN} 分钟，每 ${POLL_SEC}s 轮询）…`);
while (Date.now() < deadline) {
  const runs = await (await api(`/repos/${repoSlug}/actions/runs?per_page=20`)).json();
  const list = (runs?.workflow_runs ?? []).filter((r) => r.head_sha === headSha);
  if (list.length) {
    run = list[0];
    if (run.status === "completed") break;
    process.stdout.write(`\r  运行中：${run.status}/${run.conclusion ?? "-"} (${run.name} #${run.run_number})   `);
  } else {
    process.stdout.write(`\r  尚未出现在运行列表（可能排队中）…   `);
  }
  await sleep(POLL_SEC * 1000);
}

if (!run) {
  console.error(`\n✗ ${TIMEOUT_MIN} 分钟内没有看到该提交的 workflow 运行。`);
  console.error(`   去这里看：https://github.com/${repoSlug}/actions`);
  process.exit(3);
}

console.log(`\n\n运行：${run.name} #${run.run_number}  结论：${run.conclusion}`);
console.log(`链接：${run.html_url}`);

const jobs = await (await api(`/repos/${repoSlug}/actions/runs/${run.id}/jobs`)).json();
for (const j of jobs.jobs ?? []) {
  console.log(`\n=== job: ${j.name}  →  ${j.status}/${j.conclusion} ===`);
  for (const s of j.steps ?? []) {
    const icon = s.conclusion === "success" ? "✓" : s.conclusion === "skipped" ? "-" : "✗";
    console.log(`  ${icon} ${s.name}`);
  }
}

if (run.conclusion !== "success") {
  const failedJob = (jobs.jobs ?? []).find((j) => j.conclusion === "failure") ?? (jobs.jobs ?? [])[0];
  if (failedJob) {
    console.log(`\n--- 失败 job「${failedJob.name}」日志尾部 ---`);
    try {
      const logsRes = await fetch(`https://api.github.com/repos/${repoSlug}/actions/jobs/${failedJob.id}/logs`, {
        headers: { Authorization: `token ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "pi-desktop" },
        redirect: "follow",
      });
      const text = await logsRes.text();
      const lines = text.split(/\r?\n/);
      console.log(lines.slice(-80).join("\n"));
      const dump = path.join(os.tmpdir(), `actions-${failedJob.id}.log`);
      fs.writeFileSync(dump, text, "utf8");
      console.log(`\n（完整日志已存：${dump}）`);
    } catch (e) {
      console.log("  取日志失败：" + e.message);
      console.log(`  请在浏览器查看：${run.html_url}`);
    }
  }
  process.exit(1);
}

console.log("\n✓ Actions 首跑全绿");
