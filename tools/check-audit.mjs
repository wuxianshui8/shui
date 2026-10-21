// ============================================================
// 依赖漏洞门禁（D3）：npm audit --omit=dev + 预算制
//
//   为什么用「预算」而不是「允许清单」：
//     允许清单容易变成永久豁免（写一次就没人再看）。这里每个 workspace 声明
//       · block：哪些级别阻断（high/critical 或只有 critical）
//       · budget：该级别当前可接受的条数（多 1 条即失败 → 新漏洞无法悄悄混入）
//       · expires：配置到期日（过期即失败，强制重审）
//
//   判定：
//     - 实际条数 > budget            → 失败（列出包名与公告链接）
//     - 实际条数 < budget            → 告警「预算可收紧」（不失败，避免噪声）
//     - expires 已过                 → 失败
//     - 某 workspace 跑不出 JSON     → 失败（缺依赖/网络不可用不能算通过）
//     - 全部 workspace 都没解析到条目 → 失败（防空检查）
//
// 用法：
//   node tools/check-audit.mjs
//   AUDIT_ALLOW_SKIP=1 node tools/check-audit.mjs    # 离线/受限网络的显式降级（会打印跳过原因）
// ============================================================
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = process.env.AUDIT_BUDGET || path.join(ROOT, "deploy", "audit-budget.json");
const ALLOW_SKIP = process.env.AUDIT_ALLOW_SKIP === "1";
const LEVELS = ["info", "low", "moderate", "high", "critical"];

const problems = [];
const warnings = [];
const fail = (m) => problems.push(m);

function runAudit(dir) {
  // npm 在 Windows 上是 npm.cmd，必须经 shell 执行；--json 走 stdout，stderr 单独留作诊断
  const r = spawnSync("npm audit --omit=dev --json", {
    cwd: dir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  const stdout = r.stdout || "";
  const stderr = (r.stderr || "").trim();
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, error: (stderr || stdout).slice(0, 600) || "无输出", code: r.status };
  }
  if (!json || !json.metadata || !json.metadata.vulnerabilities) {
    return { ok: false, error: "JSON 缺少 metadata.vulnerabilities", code: r.status };
  }
  const details = [];
  for (const [name, v] of Object.entries(json.vulnerabilities || {})) {
    const advisories = (v.via || [])
      .filter((x) => typeof x === "object" && x.url)
      .map((x) => x.url.replace("https://github.com/advisories/", ""));
    details.push({ name, severity: v.severity, advisories });
  }
  return { ok: true, counts: json.metadata.vulnerabilities, details };
}

if (!fs.existsSync(CONFIG)) {
  console.log("✗ 缺少漏洞预算配置：" + path.relative(ROOT, CONFIG));
  console.log("  该文件声明每个 workspace 的阻断级别、可接受条数与到期日；缺了它门禁就等于不存在。");
  process.exit(1);
}

let cfg;
try {
  // 容忍 UTF-8 BOM：Windows 编辑器/Set-Content -Encoding UTF8 会写 BOM，
  // 不剥掉就会得到「不是合法 JSON」这种假红，把真正的配置问题掩盖掉。
  cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, ""));
} catch (e) {
  console.log("✗ 预算配置不是合法 JSON：" + e.message);
  process.exit(1);
}

const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];
if (!workspaces.length) {
  console.log("✗ 预算配置里没有任何 workspace（空检查比不检查更糟）");
  process.exit(1);
}

console.log("依赖漏洞门禁（npm audit --omit=dev，预算制）");
console.log("  · 配置：" + path.relative(ROOT, CONFIG) + "（更新于 " + (cfg.updated || "?") + "）");
console.log("  · workspace：" + workspaces.length + " 个");

const today = new Date().toISOString().slice(0, 10);
const rows = [];
let parsedAny = false;
let skipped = 0;

for (const ws of workspaces) {
  const dir = path.join(ROOT, ws.dir);
  const blocked = Array.isArray(ws.block) ? ws.block : ["high", "critical"];
  const budget = ws.budget || {};

  if (!fs.existsSync(path.join(dir, "package-lock.json"))) {
    fail(ws.dir + " 缺少 package-lock.json（npm audit 必须有锁文件）");
    continue;
  }
  if (!fs.existsSync(dir)) {
    fail(ws.dir + " 目录不存在");
    continue;
  }

  const res = runAudit(dir);
  if (!res.ok) {
    if (ALLOW_SKIP) {
      skipped++;
      warnings.push(ws.dir + " 审计被跳过（AUDIT_ALLOW_SKIP=1）：" + res.error);
      rows.push({ dir: ws.dir, skipped: true, counts: null, blocked });
      continue;
    }
    fail(ws.dir + " 无法获取审计结果：" + res.error + "（离线时可用 AUDIT_ALLOW_SKIP=1 显式降级）");
    rows.push({ dir: ws.dir, error: true, counts: null, blocked });
    continue;
  }
  parsedAny = true;

  const counts = {};
  for (const lv of LEVELS) counts[lv] = Number(res.counts[lv] || 0);
  counts.total = Number(res.counts.total || 0);

  for (const lv of blocked) {
    const actual = counts[lv] || 0;
    const allowed = Number(budget[lv] || 0);
    if (actual > allowed) {
      const pkgs = res.details
        .filter((d) => d.severity === lv)
        .map((d) => d.name + (d.advisories.length ? "（" + d.advisories.join(", ") + "）" : ""));
      fail(ws.dir + " 的 " + lv + " 漏洞 " + actual + " 条，超出预算 " + allowed + " 条：" + pkgs.join("；"));
    } else if (actual < allowed) {
      warnings.push(ws.dir + " 的 " + lv + " 已降到 " + actual + " 条（预算 " + allowed + "），可收紧 deploy/audit-budget.json");
    }
  }

  if (ws.expires && ws.expires < today) {
    fail(ws.dir + " 的漏洞预算已于 " + ws.expires + " 到期（今天 " + today + "），必须重新评估并更新配置");
  }

  rows.push({ dir: ws.dir, counts, blocked, budget, expires: ws.expires });
}

if (!parsedAny && !skipped) fail("没有任何 workspace 产出可解析的审计结果");

console.log("\n生产依赖漏洞计数（--omit=dev）：");
for (const r of rows) {
  if (r.skipped) {
    console.log("  ⚠ " + r.dir.padEnd(20) + "已跳过");
    continue;
  }
  if (r.error) {
    console.log("  ✗ " + r.dir.padEnd(20) + "无法审计");
    continue;
  }
  const c = r.counts;
  const blockedTxt = r.blocked.join("/");
  console.log(
    "  · " +
      r.dir.padEnd(20) +
      " low " + String(c.low).padStart(2) +
      " moderate " + String(c.moderate).padStart(2) +
      " high " + String(c.high).padStart(2) +
      " critical " + String(c.critical).padStart(2) +
      "  阻断级别 " + blockedTxt +
      "（预算 " + r.blocked.map((lv) => lv + "=" + Number(r.budget?.[lv] || 0)).join(" ") + "）" +
      (r.expires ? "  到期 " + r.expires : "")
  );
}

if (warnings.length) {
  console.log("\n提示：");
  for (const w of warnings) console.log("  - " + w);
}

if (problems.length) {
  console.log("\n✗ 依赖漏洞门禁未通过：");
  for (const p of problems) console.log("  - " + p);
  console.log("\n修复方向：能升就 `npm audit fix`（先看是否跨大版本）；确实需跨大版本的，调 deploy/audit-budget.json 的 budget 并写清理由与到期日。");
  process.exit(1);
}

console.log("\n✓ " + rows.length + " 个 workspace 的生产依赖漏洞均在预算内" + (skipped ? "（" + skipped + " 个被显式跳过）" : ""));
