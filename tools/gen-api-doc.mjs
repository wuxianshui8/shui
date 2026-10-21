// ============================================================
// 接口清单生成器 / 漂移门禁
//   从 apps/api-nest/src/**/*.controller.ts 提取全部路由，生成 docs/API-NEST.md 的自动区块，
//   使「代码里的接口」与「交付文档里的接口」永远一致（不靠人工维护）。
//
// 用法：
//   node tools/gen-api-doc.mjs          生成/刷新 docs/API-NEST.md 自动区块
//   node tools/gen-api-doc.mjs --check  只校验是否漂移（退出码 1 = 文档过期，可用于 CI）
// ============================================================
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "apps", "api-nest", "src");
const DOC = path.join(ROOT, "docs", "API-NEST.md");
const BEGIN = "<!-- BEGIN:AUTO-GEN -->";
const END = "<!-- END:AUTO-GEN -->";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".controller.ts")) out.push(p);
  }
  return out;
}

/** 解析一个控制器文件的路由表 */
function parseController(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const routes = [];
  let prefix = "";
  let classRoles = null;
  let classPublic = false;
  let buf = { roles: null, public: false, httpCode: null, route: null };
  let seenController = false;
  // 类级装饰器只出现在 `export class` 之前；进入类体后的 @Public/@Roles 一律属于「下一个方法」
  let inBody = false;

  const flush = () => {
    if (buf.route) {
      routes.push({
        method: buf.route.method,
        path: "/api" + joinPath(prefix, buf.route.path),
        roles: buf.roles ?? classRoles,
        isPublic: buf.public || classPublic,
        httpCode: buf.httpCode,
        file: path.relative(SRC, file).replace(/\\/g, "/"),
      });
    }
    buf = { roles: null, public: false, httpCode: null, route: null };
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^(export\s+)?class\s+\w+/.test(line)) {
      inBody = true;
      continue;
    }
    const ctl = line.match(/^@Controller\((.*)\)/);
    if (ctl) {
      prefix = unquote(ctl[1]);
      seenController = true;
      continue;
    }
    const route = line.match(/^@(Get|Post|Put|Patch|Delete)\((.*)\)/);
    if (route) {
      buf.route = { method: route[1].toUpperCase(), path: unquote(route[2]) };
      continue;
    }
    const roles = line.match(/^@Roles\((.*)\)/);
    if (roles) {
      const list = roles[1]
        .split(",")
        .map((s) => unquote(s))
        .filter(Boolean);
      if (seenController && !inBody) classRoles = list;
      else buf.roles = list;
      continue;
    }
    if (/^@Public\(\)/.test(line)) {
      if (seenController && !inBody) classPublic = true;
      else buf.public = true;
      continue;
    }
    const code = line.match(/^@HttpCode\((\d+)\)/);
    if (code) {
      buf.httpCode = Number(code[1]);
      continue;
    }
    // 方法签名行 → 一条路由装饰器块结束
    if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(/.test(line) && buf.route) flush();
  }
  flush();
  return routes;
}

function unquote(s) {
  return String(s || "")
    .split(",")[0]
    .trim()
    .replace(/^["'`]/, "")
    .replace(/["'`]$/, "")
    .trim();
}

function joinPath(prefix, sub) {
  const parts = [prefix, sub].filter((p) => p && p.length);
  return "/" + parts.join("/");
}

/** 生成自动区块 markdown */
function render() {
  const files = walk(SRC).sort();
  const all = files.flatMap(parseController);
  all.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const byFile = new Map();
  for (const r of all) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }

  const out = [];
  out.push(BEGIN);
  out.push("<!-- 本区块由 tools/gen-api-doc.mjs 自动生成，请勿手工编辑；改接口后执行 npm run api:doc -->");
  out.push("");
  out.push("总计 **" + all.length + "** 个路由，分布在 **" + byFile.size + "** 个控制器。");
  out.push("");
  out.push("| 控制器 | 路由数 |");
  out.push("| --- | --- |");
  for (const [f, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push("| `" + f + "` | " + list.length + " |");
  }
  out.push("");
  for (const [f, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push("### `" + f + "`");
    out.push("");
    out.push("| 方法 | 路径 | 角色 | 说明 |");
    out.push("| --- | --- | --- | --- |");
    for (const r of list.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
      const roles = r.isPublic ? "公开" : r.roles && r.roles.length ? r.roles.join(" / ") : "登录用户";
      const extra = [];
      if (r.isPublic) extra.push("无需令牌");
      if (r.httpCode === 200) extra.push("200");
      out.push("| " + r.method + " | `" + r.path + "` | " + roles + " | " + (extra.join("，") || "") + " |");
    }
    out.push("");
  }
  out.push(END);
  return { md: out.join("\n"), total: all.length, controllers: byFile.size };
}

const { md, total, controllers } = render();
const checkMode = process.argv.includes("--check");

if (checkMode) {
  if (!existsSync(DOC)) {
    console.error("✗ 缺少 docs/API-NEST.md，请先执行 npm run api:doc");
    process.exit(1);
  }
  const cur = readFileSync(DOC, "utf8");
  const b = cur.indexOf(BEGIN);
  const e = cur.indexOf(END);
  if (b < 0 || e < 0) {
    console.error("✗ docs/API-NEST.md 缺少自动区块标记（" + BEGIN + " / " + END + "）");
    process.exit(1);
  }
  const existing = cur.slice(b, e + END.length).replace(/\r\n/g, "\n");
  if (existing !== md) {
    console.error("✗ 接口文档已过期（代码 " + total + " 个路由）。请执行：node tools/gen-api-doc.mjs");
    // 只提示首处差异，避免刷屏
    const a = existing.split("\n");
    const c = md.split("\n");
    for (let i = 0; i < Math.max(a.length, c.length); i++) {
      if (a[i] !== c[i]) {
        console.error("  首个差异在第 " + (i + 1) + " 行：");
        console.error("    文档： " + (a[i] ?? "(缺失)"));
        console.error("    代码： " + (c[i] ?? "(缺失)"));
        break;
      }
    }
    process.exit(1);
  }
  console.log("✓ 接口文档与代码一致：" + total + " 个路由 / " + controllers + " 个控制器");
  process.exit(0);
}

const header = existsSync(DOC)
  ? readFileSync(DOC, "utf8").split(BEGIN)[0].replace(/\s+$/, "\n\n")
  : "";
if (!header.trim()) {
  console.error("✗ docs/API-NEST.md 缺少手写说明部分（BEGIN 标记之前的内容），请先创建文件骨架");
  process.exit(1);
}
writeFileSync(DOC, header.replace(/\r\n/g, "\n") + md + "\n", "utf8");
console.log("✓ 已写入 docs/API-NEST.md：" + total + " 个路由 / " + controllers + " 个控制器");
