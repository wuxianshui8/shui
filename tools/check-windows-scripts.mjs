// ============================================================
// Windows 脚本门禁（.bat / .cmd / .ps1）
//
//   背景：本项目实际在 Windows PowerShell 5.1 上运行，但 CI 跑在 Ubuntu 上，
//   Windows 脚本的换行/BOM/编码问题一直没有机器门禁。历史真实事故：
//     · .bat 存成纯 LF → cmd 解析多行 if 失败，表现为"双击无反应"
//     · .bat 带 UTF-8 BOM → cmd 把 `﻿@echo off` 当命令，报"不是内部或外部命令"
//     · .ps1 含中文但没有 BOM → PS 5.1 按 ANSI 读取，实测报
//       「The string is missing the terminator: "」直接无法运行（setup-services.ps1 曾中招）
//     · .ps1 里用 `&&` → PS 5.1 不支持（那是 bash / pwsh 7+ 语法）
//
//   规则：
//     .bat/.cmd ① 必须 CRLF ② 不得带 UTF-8 BOM ③ 含非 ASCII 时必须有 chcp 65001
//     .ps1      ① 含非 ASCII 时必须有 UTF-8 BOM ② 不得出现 && ③ 用 PS 解析器做语法检查
//               （无 powershell.exe 的环境自动跳过语法检查并注明，不算失败）
//
// 用法：node tools/check-windows-scripts.mjs
//       WINSCRIPTS_ROOT=<目录> 可覆盖扫描根（用于负向验证）
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.WINSCRIPTS_ROOT
  ? path.resolve(process.env.WINSCRIPTS_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));

const SKIP_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
// 按仓库相对路径前缀跳过（便携版二进制目录）
const SKIP_PREFIX = [
  "tools/node",
  "tools/git",
  "tools/mysql-8.4.0-winx64",
  "tools/mysql-data",
  "tools/redis",
  "tools/bin",
].map((p) => p.split("/").join(path.sep));

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p);
    if (SKIP_PREFIX.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
    if (e.isDirectory()) {
      if (SKIP_NAMES.has(e.name)) continue;
      walk(p);
    } else if (/\.(bat|cmd|ps1)$/i.test(e.name)) {
      files.push(p);
    }
  }
}
walk(ROOT);
files.sort();

const problems = [];
const notes = [];
const fail = (file, msg) => problems.push(`${path.relative(ROOT, file)}  ${msg}`);

const ps1 = [];
let batCount = 0;
let ps1Count = 0;

for (const file of files) {
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  const nonAscii = buf.some((b) => b > 127);
  const hasLF = buf.includes(0x0a);
  const hasCR = buf.includes(0x0d);
  // 每个 LF 前面都必须是 CR，才算全 CRLF
  let lfOnly = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) {
      lfOnly = true;
      break;
    }
  }
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  // 该文件用 UTF-8 读回再写一遍是否字节一致（不一致 = 另存成了 ANSI/GBK 等编码）
  const utf8RoundTrip = Buffer.from(text.replace(/^\uFEFF/, ""), "utf8").equals(
    hasBom ? buf.subarray(3) : buf,
  );

  if (/\.(bat|cmd)$/i.test(file)) {
    batCount++;
    // 只有「存在未被 CR 前导的 LF」或「纯 LF」才算换行错误；单行无换行文件不算
    if (lfOnly || (hasLF && !hasCR)) {
      fail(file, "批处理必须是 CRLF 换行（纯 LF 会让 cmd 解析多行 if 失败，表现为「双击无反应」）");
    }
    if (hasCR && !hasLF && buf.length > 0) {
      fail(file, "批处理只有 CR 换行（老 Mac 风格），cmd 无法正确分行");
    }
    if (utf16) fail(file, "批处理不是 UTF-8 编码（检测到 UTF-16 BOM），请另存为 UTF-8");
    if (hasBom) fail(file, "批处理不得带 UTF-8 BOM（cmd 会把 BOM 当命令内容，报「不是内部或外部命令」）");
    if (nonAscii && !utf8RoundTrip) {
      fail(file, "批处理含非 ASCII 但文件不是合法 UTF-8（很可能另存成了 ANSI/GBK，chcp 65001 也救不回来）");
    }
    if (nonAscii && !/chcp\s+65001/i.test(text)) {
      fail(file, "批处理含非 ASCII 字符但没有 chcp 65001（默认 936 代码页下中文会乱码）");
    }
    continue;
  }

  // .ps1
  ps1Count++;
  ps1.push(file);
  if (nonAscii && !hasBom) {
    fail(file, "PowerShell 脚本含中文但没有 UTF-8 BOM（PS 5.1 会按 ANSI 读取，实测直接语法报错）");
  }
  const codeLines = text.split(/\r?\n/);
  codeLines.forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, "").replace(/`[^`]*`/g, "");
    if (/&&/.test(code)) fail(file, `第 ${i + 1} 行用了 &&（PS 5.1 不支持，请拆成多行或用 if/foreach）`);
  });
}

/* ---------- PowerShell 语法检查（无 powershell 则跳过）---------- */
const hasPwsh = process.platform === "win32" && spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"]).status === 0;
if (hasPwsh && ps1.length) {
  const list = ps1.map((f) => "'" + f.replace(/'/g, "''") + "'").join(",");
  const cmd =
    `$files=@(${list}); foreach($f in $files){` +
    `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e);` +
    `if($e){ Write-Output ($f + '|ERR|' + $e[0].Message) } else { Write-Output ($f + '|OK') } }`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (out.error || out.status !== 0) {
    // 语法检查进程本身失败：不能当成"通过"，否则这项检查会静默消失
    fail(
      path.join(ROOT, "tools"),
      `PowerShell 语法检查未能执行：${out.error ? out.error.message : "exit=" + out.status}` +
        `${out.stderr ? " / " + String(out.stderr).split(/\r?\n/)[0] : ""}`,
    );
    notes.push("PowerShell 语法检查：执行失败（见上方问题）");
  } else {
    const lines = `${out.stdout ?? ""}`.split(/\r?\n/).filter(Boolean);
    let checked = 0;
    for (const line of lines) {
      const [f, state, msg] = line.split("|");
      if (!f) continue;
      checked++;
      if (state === "ERR") fail(f, "PowerShell 语法检查失败：" + (msg || "未知错误"));
    }
    if (checked !== ps1.length) {
      fail(path.join(ROOT, "tools"), `PowerShell 语法检查只返回了 ${checked}/${ps1.length} 个结果（解析器输出异常）`);
    }
    notes.push(`PowerShell 语法检查：已解析 ${checked}/${ps1.length} 个脚本（Windows PowerShell 5.1 解析器）`);
  }
} else {
  notes.push("PowerShell 语法检查：跳过（本机无 powershell.exe）");
}

/* ---------- 输出 ---------- */
console.log("Windows 脚本门禁（换行 / BOM / 编码 / PS 5.1 语法）");
console.log(`  · 扫描：${files.length} 个脚本（批处理 ${batCount}、PowerShell ${ps1Count}）`);
console.log(`  · 跳过的目录：node_modules、.git、dist、build、tools/{node,git,mysql*,redis,bin}`);
notes.forEach((n) => console.log("  · " + n));

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}

console.log("\n✓ 批处理均为 CRLF 且无 BOM；含中文的 .ps1 均有 BOM；无 `&&`；语法检查通过");
