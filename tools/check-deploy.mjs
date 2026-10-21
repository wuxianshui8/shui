// ============================================================
// 部署与 CI 配置的静态校验（不需要 Docker 守护进程）
//   校验 compose / Dockerfile / GitHub Actions 之间的一致性：
//     1. YAML 能被解析（有 yaml 库时严格解析，否则做结构检查）
//     2. compose 引用的文件、服务名、依赖条件、端口映射与 healthcheck 自洽
//     3. Dockerfile 的每个 COPY 源路径真实存在；构建命令引用的 npm script 存在
//     4. workflow 里 `run:` 用到的脚本/测试文件都存在，服务端口与 BASE_URL 一致
//     5. 生产相关开关符合安全基线（NODE_ENV=production / DEV_SMS=0 / AUTH_SECRET 必填）
// 用法：node tools/check-deploy.mjs
//   可选：YAML_LIB=<yaml 模块路径或包名> 启用严格 YAML 解析
// ============================================================
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const exists = (p) => existsSync(path.join(ROOT, p));

/* ---------------- YAML 解析（可选严格模式） ---------------- */
let parseYaml = null;
const yamlTarget = process.env.YAML_LIB
  ? pathToFileURL(path.resolve(process.env.YAML_LIB)).href
  : "yaml";
try {
  const mod = await import(yamlTarget);
  parseYaml = (mod.default || mod).parse;
  notes.push("YAML 严格解析：已启用（" + yamlTarget + "）");
} catch (e) {
  notes.push("YAML 严格解析：未启用（设置 YAML_LIB 指向 yaml 包可开启）：" + e.message);
}

/** 极简结构检查：确认缩进层级与键存在（作为解析库的降级方案） */
function structuralYaml(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^services:\s*$/.test(l))) fail("compose/workflow 缺少顶层 services:");
  const tabbed = lines.findIndex((l) => l.includes("\t"));
  if (tabbed >= 0) fail("YAML 第 " + (tabbed + 1) + " 行使用了 Tab（YAML 只允许空格缩进）");
  const badIndent = lines.findIndex((l) => /^\s+\S/.test(l) && (l.match(/^ +/)[0].length % 2) === 1);
  if (badIndent >= 0) notes.push("提示：第 " + (badIndent + 1) + " 行缩进为奇数，确认是否误用");
}

/* ---------------- 1. docker-compose.yml ---------------- */
const composePath = "deploy/docker-compose.yml";
if (!exists(composePath)) {
  fail("缺少 " + composePath);
} else {
  const text = readFileSync(path.join(ROOT, composePath), "utf8");
  structuralYaml(text);
  let doc = null;
  if (parseYaml) {
    try {
      doc = parseYaml(text);
    } catch (e) {
      fail("compose YAML 解析失败：" + e.message);
    }
  }
  const raw = (k) => text.includes(k);

  if (doc) {
    const services = doc.services || {};
    for (const name of ["mysql", "redis", "app"]) {
      if (!services[name]) fail("compose 缺少服务：" + name);
    }
    const app = services.app || {};
    const deps = app.depends_on || {};
    for (const name of ["mysql", "redis"]) {
      const d = deps[name];
      const cond = typeof d === "object" ? d.condition : null;
      if (!dependsOk(cond)) fail("app 未以 service_healthy 等待 " + name);
    }
    function dependsOk(cond) {
      return cond === "service_healthy";
    }
    // AUTH_SECRET 必须是必填语法，避免用弱默认值上线
    const env = app.environment || {};
    const secret = String(env.AUTH_SECRET || "");
    if (!secret.includes(":?") && !secret.includes("${AUTH_SECRET")) {
      fail("compose 的 AUTH_SECRET 未使用 ${AUTH_SECRET:?…} 必填语法（生产必须显式提供）");
    }
    // 生产开关
    if (String(env.NODE_ENV) !== "production") fail("compose 的 app.NODE_ENV 应为 production");
    if (String(env.DEV_SMS) !== "0") fail("compose 的 DEV_SMS 应为 0（生产禁止回显验证码）");
    // 容器内网端口（应用连的是容器网络里的 3306/6379）
    if (String(env.MYSQL_PORT) !== "3306") fail("app 的 MYSQL_PORT 应指向容器网络内的 3306（不是宿主 3307）");
    if (String(env.REDIS_PORT) !== "6379") fail("app 的 REDIS_PORT 应指向容器网络内的 6379（不是宿主 6380）");
    // 端口映射
    for (const [name, want] of [["mysql", "3307:3306"], ["redis", "6380:6379"], ["app", "4300:4300"]]) {
      const ports = (services[name] || {}).ports || [];
      if (!ports.map(String).includes(want)) fail("compose 服务 " + name + " 缺少端口映射 " + want);
    }
    // 挂载的建表脚本必须存在
    const volumes = (services.mysql || {}).volumes || [];
    for (const v of volumes.map(String)) {
      if (v.startsWith("..")) {
        const src = v.split(":")[0].replace(/^\.\.\//, "");
        if (!exists(src)) fail("compose 挂载的宿主机文件不存在：" + src);
      }
    }
    // healthcheck 连续可用性
    for (const name of ["mysql", "redis"]) {
      if (!(services[name] || {}).healthcheck) fail("compose 服务 " + name + " 缺少 healthcheck");
    }
    // 构建上下文与 Dockerfile
    const build = app.build || {};
    if (String(build.context) !== "..") fail("app.build.context 应为 ..（仓库根目录）");
    const df = String(build.dockerfile || "");
    if (!df || !exists(df)) fail("app.build.dockerfile 不存在：" + df);
  }
  // 文本级兜底断言（不依赖解析库）
  if (!raw("AUTH_SECRET")) fail("compose 未声明 AUTH_SECRET");
  if (!raw("service_healthy")) fail("compose 未使用 service_healthy 依赖条件");
}

/* ---------------- 2. Dockerfile ---------------- */
const dfPath = "deploy/Dockerfile";
if (!exists(dfPath)) {
  fail("缺少 " + dfPath);
} else {
  const text = readFileSync(path.join(ROOT, dfPath), "utf8");
  // 阶段之间 copy 的源是镜像内路径，只校验「从构建上下文 COPY」的源
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^COPY\s+(?!--from)([^\s]+)\s+/);
    if (!m) continue;
    const src = m[1];
    if (src.includes("*")) continue;
    if (!exists(src)) fail("Dockerfile COPY 源不存在：" + src);
  }
  // 前端构建脚本必须存在
  for (const [app, script] of [["apps/web-admin", "build"], ["apps/web-mobile", "build:h5"]]) {
    const pkg = path.join(ROOT, app, "package.json");
    if (!existsSync(pkg)) {
      fail("缺少 " + app + "/package.json");
      continue;
    }
    const scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts || {};
    if (!scripts[script]) fail(app + " 缺少 npm script: " + script);
  }
  // 后端编译命令与产物
  if (!exists("apps/api-nest/tsconfig.json")) fail("缺少 apps/api-nest/tsconfig.json");
  if (!/CMD \["node", "dist\/main\.js"\]/.test(text)) fail("Dockerfile 的 CMD 应为 node dist/main.js");
  if (!/HEALTHCHECK/.test(text)) fail("Dockerfile 缺少 HEALTHCHECK");
  if (!/USER node/.test(text)) fail("Dockerfile 未切换到非 root 用户（USER node）");
}

/* ---------------- 3. GitHub Actions workflow ---------------- */
const wfPath = ".github/workflows/ci.yml";
if (!exists(wfPath)) {
  fail("缺少 " + wfPath);
} else {
  const text = readFileSync(path.join(ROOT, wfPath), "utf8");
  let doc = null;
  if (parseYaml) {
    try {
      doc = parseYaml(text);
    } catch (e) {
      fail("workflow YAML 解析失败：" + e.message);
    }
  }
  // 从 run: 里提取 node <file> 与 npm --prefix <dir> run <script>
  // 注意：step 可能带 working-directory，脚本路径先按 step 目录解析，再按仓库根解析
  const cwdOf = (idx) => {
    const before = text.slice(0, idx).split(/\r?\n/);
    for (let i = before.length - 1; i >= 0 && i > before.length - 12; i--) {
      const m = before[i].match(/^\s+working-directory:\s*(\S+)\s*$/);
      if (m) return m[1];
    }
    return "";
  };
  const resolveRef = (ref, cwd) => {
    const cand = ref.replace(/^\.\//, "");
    if (path.posix.isAbsolute(cand)) return "generated"; // runner 提供的绝对路径
    const attempts = [];
    if (cwd) attempts.push(path.posix.normalize(path.posix.join(cwd, cand)));
    attempts.push(path.posix.normalize(cand));
    // 兜底：去掉前导 ../（对应 `working-directory: apps/api-nest` + `node ../tools/x.mjs` 的写法）
    attempts.push(path.posix.normalize(cand.replace(/^(\.\.\/)+/, "")));
    const hit = attempts.find((p) => exists(p));
    if (hit) return hit;
    // 构建产物（dist / node_modules）在 CI 里由前序步骤生成，不在仓库中
    if (attempts.some((p) => /(^|\/)(dist|node_modules)\//.test(p))) return "generated";
    return null;
  };
  for (const m of text.matchAll(/node\s+(\.{0,2}\/?[\w./-]+\.(?:mjs|js|ts))/g)) {
    const resolvedRef = resolveRef(m[1], cwdOf(m.index ?? 0));
    if (resolvedRef === null) {
      fail("workflow 引用的脚本不存在：" + m[1] + "（工作目录 " + (cwdOf(m.index ?? 0) || "仓库根") + "）");
    }
  }
  for (const m of text.matchAll(/npm\s+--prefix\s+(\S+)\s+run\s+(\S+)/g)) {
    const [, dirRef, script] = m;
    const dir = resolveDir(dirRef, cwdOf(m.index ?? 0));
    if (!dir) {
      fail("workflow 的 npm --prefix 目录不存在：" + dirRef);
      continue;
    }
    const scripts = JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).scripts || {};
    if (!scripts[script]) fail("workflow 要跑的 npm script 不存在：" + dir + " run " + script);
  }
  function resolveDir(ref, cwd) {
    const cand = ref.replace(/^\.\//, "");
    const attempts = [];
    if (cwd) attempts.push(path.posix.normalize(path.posix.join(cwd, cand)));
    attempts.push(path.posix.normalize(cand));
    return attempts.find((p) => existsSync(path.join(ROOT, p, "package.json"))) || null;
  }
  // 端口一致性
  const envBlock = (text.match(/^env:[\s\S]*?\n(?=\w)/m) || [""])[0];
  const baseUrl = (envBlock.match(/BASE_URL:\s*(\S+)/) || [])[1];
  if (baseUrl && !baseUrl.endsWith(":4300")) fail("workflow BASE_URL 应指向 4300，当前：" + baseUrl);
  if (!/AUTH_SECRET:/.test(envBlock)) fail("workflow 未设置 AUTH_SECRET（NODE_ENV=production 时应用会拒绝启动）");
  if (!/DEV_SMS:\s*["']?1/.test(envBlock)) fail("workflow 需要 DEV_SMS=1（e2e 用 devCode 走验证码登录）");
  if (!/mysql:8/.test(text)) fail("workflow 未使用 mysql:8 服务容器");
  if (!/redis:/.test(text)) fail("workflow 未使用 redis 服务容器");
  if (doc) {
    const jobs = doc.jobs || {};
    for (const job of ["static", "integration"]) {
      if (!jobs[job]) fail("workflow 缺少 job：" + job);
    }
    if ((jobs.integration || {}).needs !== "static") fail("integration job 应 needs: static");
  }
}

/* ---------------- 4. 输出 ---------------- */
console.log("部署与 CI 配置校验");
notes.forEach((n) => console.log("  · " + n));
if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ compose / Dockerfile / workflow 的路径、端口、脚本与安全开关一致");
console.log("  注意：本项为静态校验；容器运行时行为需在有 Docker 的环境实测（见 docs/DEPLOY-CONTAINERS.md）");
