// ============================================================
// 门禁自检（meta 门禁）：验证「门禁真的会失败」
//
//   一个只会输出 ✓ 的检查等于没有检查。本脚本为每个门禁准备
//   「合法输入」与「明确非法输入」两份夹具，断言：
//     · 合法输入 → 退出码 0
//     · 非法输入 → 退出码 1
//   只要某条门禁变成"永远通过"，这里立刻红。
//
//   覆盖：check-docs-shell、check-windows-scripts、check-compose-schema、
//         check-trace-nest（各自都有 ROOT/FILE 覆盖开关，才能在临时目录里造夹具）
//
//   用法：node tools/check-gates-selftest.mjs
//       需要 YAML_LIB / AJV_LIB 才能跑 compose 的两条用例，缺失时自动标注跳过
// ============================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = path.join(ROOT, "tools");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));

const results = [];
const cleanup = () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
};
process.on("exit", cleanup);

function run(tool, env = {}, args = []) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, tool), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function check(name, tool, env, expect, args = []) {
  const r = run(tool, env, args);
  const pass = r.code === expect;
  results.push({ name, expect, actual: r.code, pass, note: pass ? "" : r.out.split(/\r?\n/).filter(Boolean).slice(-4).join(" / ") });
  return r;
}

function mk(dir, file, content) {
  const p = path.join(TMP, dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return path.join(TMP, dir);
}

/* ---------- 1. 文档 shell 写法门禁 ---------- */
const goodDocs = mk("docs-ok", "README.md", "# 好文档\n\n```powershell\ncd deploy\ncurl.exe -fsS http://localhost:4300/api/health\n```\n");
const badDocs = mk(
  "docs-bad",
  "docs/bad.md",
  "# 坏文档\n\n启动用 start.bat。\n\n```powershell\nnpm install && npm run build\n```\n\n见下表：A\\nB\n",
);
check("docs-shell · 合法文档应通过", "check-docs-shell.mjs", { DOCS_ROOT: goodDocs }, 0);
check("docs-shell · 非法文档应失败", "check-docs-shell.mjs", { DOCS_ROOT: badDocs }, 1);

/* ---------- 2. Windows 脚本门禁 ---------- */
const goodWin = mk("win-ok", "ok.bat", "@echo off\r\nchcp 65001 >nul\r\necho 你好\r\n");
mk("win-ok", "ok.ps1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-Output "你好"\r\n')]));
const badWin = mk("win-bad", "bad.bat", "@echo off\nchcp 65001 >nul\necho 你好\n");
mk("win-bad", "bad.ps1", 'Write-Output "中文但没有 BOM"\n');
check("windows-scripts · 合法脚本应通过", "check-windows-scripts.mjs", { WINSCRIPTS_ROOT: goodWin }, 0);
check("windows-scripts · 非法脚本应失败", "check-windows-scripts.mjs", { WINSCRIPTS_ROOT: badWin }, 1);

/* ---------- 3. compose 官方 Schema 门禁 ---------- */
const realCompose = path.join(ROOT, "deploy", "docker-compose.yml");
if (fs.existsSync(realCompose)) {
  const NO_LIBS = { YAML_LIB: "", AJV_LIB: "" };
  // 严格模式：缺依赖必须失败（否则这条门禁等于不存在）
  check("compose-schema · 缺依赖且未降级应失败", "check-compose-schema.mjs", NO_LIBS, 1);
  // 显式降级才允许跳过
  check("compose-schema · 缺依赖 + --allow-skip 应跳过", "check-compose-schema.mjs", NO_LIBS, 0, ["--allow-skip"]);

  const positive = check("compose-schema · 真实 compose 应通过", "check-compose-schema.mjs", {}, 0, ["--allow-skip"]);
  const skipped = /跳过/.test(positive.out);
  if (skipped) {
    const last = results[results.length - 1];
    last.pass = true;
    last.note = "跳过（未提供 YAML_LIB/AJV_LIB，CI 上即如此）";
  } else {
    const bad = fs
      .readFileSync(realCompose, "utf8")
      .replace(/^(\s*)image: mysql:8\.0$/m, "$1image: 12345");
    const badPath = path.join(TMP, "bad-compose.yml");
    fs.writeFileSync(badPath, bad);
    check("compose-schema · 非法 compose 应失败", "check-compose-schema.mjs", { COMPOSE_FILE: badPath }, 1);
  }
}

/* ---------- 4. 追溯矩阵门禁 ---------- */
const realTrace = path.join(ROOT, "docs", "TRACEABILITY-NEST.md");
if (fs.existsSync(realTrace)) {
  check("trace-check · 真实追溯矩阵应通过", "check-trace-nest.mjs", {}, 0);
  const src = fs.readFileSync(realTrace, "utf8");
  const injected = src.replace(/`(GET|POST|PUT|DELETE) (\/api\/[a-z0-9\-/:]+)`/i, "`POST /api/gate-selftest-nonexistent`");
  if (injected !== src) {
    const badTrace = path.join(TMP, "bad-trace.md");
    fs.writeFileSync(badTrace, injected);
    check("trace-check · 引用不存在接口应失败", "check-trace-nest.mjs", { TRACE_FILE: badTrace }, 1);
  }
}

/* ---------- 输出 ---------- */
console.log("门禁自检（验证每条门禁在非法输入下真的会失败）");
console.log(`  · 夹具目录：${TMP}`);
for (const r of results) {
  console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}  期望退出码 ${r.expect} / 实际 ${r.actual}${r.note ? "  " + r.note : ""}`);
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log(`\n✗ ${failed.length} 条门禁自检未通过（可能是门禁失去作用，或夹具本身不合法）：`);
  for (const f of failed) console.log("  - " + f.name + (f.note ? "（" + f.note + "）" : ""));
  process.exit(1);
}

console.log(`\n✓ ${results.length} 条用例全部符合预期：合法输入通过、非法输入被拦`);
