// ============================================================
// 文档 shell 写法门禁（防止 Windows 用户照着文档敲出错命令）
//
//   背景：一次真实事故——`docs/DEPLOY-CONTAINERS.md` 里写了
//     docker compose up -d --build && docker compose run --rm seed
//   Windows PowerShell 5.1 用户在 PS 里粘贴后直接解析失败：
//     「标记"&&"不是此版本中的有效语句分隔符 / InvalidEndOfLine」
//   命令一个字都没执行。同类坑还有：PS 5.1 里 curl 是 Invoke-WebRequest 别名。
//
//   本门禁检查 docs/*.md 与 README.md：
//     1. ``` 围栏必须成对（否则渲染错位、文档等于废掉）
//     2. 代码块之外不得出现字面 \n（历史 bug：合并行时写成 \n 而非换行）
//     3. ```powershell 块里不得出现 &&（PS 5.1 不支持）
//     4. ```powershell 块里不得出现裸 curl（必须写 curl.exe，否则 -fsS 报参数错误）
//     5. Windows 向文档（含 start.bat / .ps1 / D:\ 路径）的 ```bash 块若出现 &&，
//        文件内必须同时给出「PowerShell 5.1」相关提示（说明逐行执行）
//
// 用法：node tools/check-docs-shell.mjs
//       DOCS_ROOT=<目录> 可覆盖扫描根目录（用于负向验证）
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.DOCS_ROOT
  ? path.resolve(process.env.DOCS_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));

const files = [];
const readme = path.join(ROOT, "README.md");
if (fs.existsSync(readme)) files.push(readme);
const docsDir = path.join(ROOT, "docs");
if (fs.existsSync(docsDir)) {
  for (const f of fs.readdirSync(docsDir)) {
    if (f.endsWith(".md")) files.push(path.join(docsDir, f));
  }
}

const problems = [];
const fail = (file, line, msg) => problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);
const WINDOWS_HINT = /PowerShell\s*5\.1|逐行执行/;
const WINDOWS_DOC = /start\.bat|\.ps1\b|D:\\|\.bat\b/;

let blocks = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const isWindowsDoc = WINDOWS_DOC.test(text);
  const hasHint = lines.some((l) => WINDOWS_HINT.test(l));

  let inFence = false;
  let lang = "";
  let fenceStart = 0;
  let fenceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^```(\w*)/.exec(line);

    if (m) {
      fenceCount++;
      if (!inFence) {
        inFence = true;
        lang = m[1].toLowerCase();
        fenceStart = i + 1;
        if (lang) blocks++;
      } else {
        inFence = false;
        lang = "";
      }
      continue;
    }

    if (!inFence) {
      // 规则 2：代码块之外的字面 \n
      if (/[^`\\]\\n[^`]/.test(line) && !/\\n/.test(line.match(/`[^`]*`/g)?.join("") ?? "")) {
        if (/\\n/.test(line)) fail(file, i + 1, '代码块外出现字面 "\\n"（应为真实换行）');
      }
      continue;
    }

    // 规则 3 / 4：powershell 块（先剔除注释与行内反引号，避免把「说明文字里的 &&」误判为运算符）
    if (lang === "powershell" || lang === "ps1") {
      const code = line.replace(/(^|\s)#.*$/, "").replace(/`[^`]*`/g, "");
      if (/&&/.test(code)) fail(file, i + 1, "powershell 块内出现 &&（PS 5.1 不支持，请逐行写）");
      if (/(^|\s)curl(\s|$)/.test(code)) {
        fail(file, i + 1, "powershell 块内出现裸 curl（PS 5.1 会走 Invoke-WebRequest 别名，应写 curl.exe）");
      }
    }

    // 规则 5：Windows 向文档的 bash 块
    if (lang === "bash" || lang === "sh" || lang === "shell") {
      if (/&&/.test(line) && isWindowsDoc && !hasHint) {
        fail(
          file,
          i + 1,
          "Windows 向文档的 bash 块里用了 &&，但全文没有「PowerShell 5.1 / 逐行执行」提示",
        );
      }
    }
  }

  // 规则 1：围栏成对
  if (fenceCount % 2 !== 0) {
    fail(file, fenceCount, `代码围栏不成对（共 ${fenceCount} 个 \`\`\`，最后一个起于第 ${fenceStart} 行）`);
  }
  if (inFence) {
    fail(file, fenceStart, "代码围栏未闭合");
  }
}

console.log("文档 shell 写法门禁（Windows 用户照抄文档不会踩坑）");
console.log(`  · 扫描文件：${files.length} 个（README.md + docs/*.md）`);
console.log(`  · 代码块数：${blocks} 个`);

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 处问题：`);
  for (const p of problems.slice(0, 40)) console.log("  - " + p);
  if (problems.length > 40) console.log(`  …… 其余 ${problems.length - 40} 处省略`);
  process.exit(1);
}

console.log("\n✓ 围栏全部成对；无字面 \\n；powershell 块无 && 与裸 curl；Windows 向 bash 块有 PS 提示");
