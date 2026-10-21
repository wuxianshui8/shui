// ============================================================
// 文档 shell 写法门禁（防止 Windows 用户照着文档敲出错命令）
//
//   背景：一次真实事故——`docs/DEPLOY-CONTAINERS.md` 里写了
//     docker compose up -d --build && docker compose run --rm seed
//   Windows PowerShell 5.1 用户粘贴后直接解析失败：
//     「标记"&&"不是此版本中的有效语句分隔符 / InvalidEndOfLine」
//   命令一个字都没执行。同类坑：PS 5.1 里 curl 是 Invoke-WebRequest 别名。
//
//   规则（扫描 README.md + docs/**/*.md，递归）：
//     1. 代码围栏必须成对（支持 0–3 空格缩进、``` 与 ~~~、3 个以上）
//     2. 代码块之外不得出现字面 \n（历史 bug：合并行时写成 \n 而非换行）
//     3. ```powershell 块里不得出现 &&（PS 5.1 不支持）
//     4. ```powershell 块里不得出现裸 curl（必须写 curl.exe）
//     5. Windows 向文档的 ```bash 块若出现 &&，文件内必须给出「PowerShell 5.1 / 逐行执行 / cmd /c」提示
//
//   判定前会剔除注释与引号内文本，避免把说明文字里的 && 误判为运算符。
//
// 用法：node tools/check-docs-shell.mjs
//       DOCS_ROOT=<目录> 可覆盖扫描根（用于负向验证）
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.DOCS_ROOT
  ? path.resolve(process.env.DOCS_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));

const files = [];
function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      collect(p);
    } else if (e.name.endsWith(".md")) {
      files.push(p);
    }
  }
}
files.push(...[path.join(ROOT, "README.md")].filter((p) => fs.existsSync(p)));
collect(path.join(ROOT, "docs"));
files.sort();

const problems = [];
const fail = (file, line, msg) => problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);

const WINDOWS_HINT = /PowerShell\s*5\.1|逐行执行|cmd\s*\/c/i;
const WINDOWS_DOC = /start\.bat|\.ps1\b|\.bat\b|D:\\|PowerShell\s*5\.1|cmd\s*\/c/i;

/** 剥掉注释与引号内文本（用于判断「真正的运算符」） */
function stripNoise(line, commentChar) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (commentChar === "#" && ch === "#") break;
    out += ch;
  }
  return out;
}

/** 反引号区间（行内 code span），用于规则 2 排除文档里的 `\n` 写法示例 */
function backtickRanges(line) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "`") {
      if (start === -1) start = i;
      else {
        ranges.push([start, i]);
        start = -1;
      }
    }
  }
  return ranges;
}

let blocks = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const isWindowsDoc = WINDOWS_DOC.test(text);
  const hasHint = lines.some((l) => WINDOWS_HINT.test(l));

  let fence = null; // { char, len, start, lang }
  let fenceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 围栏：最多 3 空格缩进，``` 或 ~~~，长度 >= 3
    const m = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);

    if (m && (!fence || m[1][0] === fence.char)) {
      const sameChar = !fence || m[1][0] === fence.char;
      const longEnough = !fence || m[1].length >= fence.len;
      if (sameChar && longEnough) {
        fenceCount++;
        if (!fence) {
          fence = { char: m[1][0], len: m[1].length, start: i + 1, lang: (m[2] || "").toLowerCase() };
          if (fence.lang) blocks++;
        } else {
          fence = null;
        }
        continue;
      }
    }

    if (!fence) {
      // 规则 2：代码块之外的字面 \n（排除行内 code span 里的写法示例）
      const ranges = backtickRanges(line);
      const inRange = (pos) => ranges.some(([a, b]) => pos > a && pos < b);
      for (let idx = line.indexOf("\\n"); idx !== -1; idx = line.indexOf("\\n", idx + 2)) {
        if (!inRange(idx)) {
          fail(file, i + 1, '代码块外出现字面 "\\n"（应为真实换行）');
          break;
        }
      }
      continue;
    }

    const lang = fence.lang;
    if (lang === "powershell" || lang === "ps1" || lang === "pwsh") {
      const code = stripNoise(line, "#");
      if (/&&/.test(code)) fail(file, i + 1, "powershell 块内出现 &&（PS 5.1 不支持，请逐行写）");
      if (/(^|\s)curl(\s|$)/.test(code)) {
        fail(file, i + 1, "powershell 块内出现裸 curl（PS 5.1 会走 Invoke-WebRequest 别名，应写 curl.exe）");
      }
    }

    if (lang === "bash" || lang === "sh" || lang === "shell" || lang === "console") {
      const code = stripNoise(line, "#");
      if (/&&/.test(code) && isWindowsDoc && !hasHint) {
        fail(file, i + 1, "Windows 向文档的 bash 块里用了 &&，但全文没有「PowerShell 5.1 / 逐行执行 / cmd /c」提示");
      }
    }
  }

  if (fence) {
    fail(file, fence.start, `代码围栏未闭合（自第 ${fence.start} 行开始，共 ${fenceCount} 个围栏标记）`);
  } else if (fenceCount % 2 !== 0) {
    fail(file, fenceCount, `代码围栏不成对（共 ${fenceCount} 个围栏标记）`);
  }
}

console.log("文档 shell 写法门禁（Windows 用户照抄文档不会踩坑）");
console.log(`  · 扫描文件：${files.length} 个（README.md + docs/**/*.md 递归）`);
console.log(`  · 代码块数：${blocks} 个`);

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 处问题：`);
  for (const p of problems.slice(0, 40)) console.log("  - " + p);
  if (problems.length > 40) console.log(`  …… 其余 ${problems.length - 40} 处省略`);
  process.exit(1);
}

console.log("\n✓ 围栏全部成对；无字面 \\n；powershell 块无 && 与裸 curl；Windows 向 bash 块有 PS 提示");
