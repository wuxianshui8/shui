// ============================================================
// 镜像运行阶段契约校验（Dockerfile runtime stage 的宿主机等价复演）
//
//   背景：本机 BIOS 关闭 VT-x（VirtualizationFirmwareEnabled=False）、Hyper-V/WSL
//   组件全 Disabled → dockerd 起不来，无法 `docker run` 真实容器。
//   这里把「容器里会发生什么」在宿主机按同一份 Dockerfile 复演：
//     A. 运行阶段声明：ENV / WORKDIR / COPY 集合 / USER / EXPOSE / HEALTHCHECK / CMD
//     B. 产物依赖：dist 里 require 的包必须都在 dependencies（否则 npm prune --omit=dev 后运行即崩）
//     C. 生产模式真起服：NODE_ENV=production + AUTH_SECRET + DEV_SMS=0，
//        验证 /api/health、HEALTHCHECK 命令、/admin-vue/、/m/、旧 5 端 UI、验证码不回显
//     D. 缺 AUTH_SECRET 时生产必须拒绝启动（config.ts 的保护）
//   ⚠️ 仍无法覆盖：容器内核/网络命名空间、USER node 的 uid 权限、镜像层与体积。
//      这些必须等有 Docker 的环境实测（见 docs/DEPLOY-CONTAINERS.md §5）。
//
// 依赖：MySQL(3307) + Redis(6380) 已就绪、apps/api-nest 已 tsc 编译。
//   单独跑：node tools/check-image-runtime.mjs
//   随门禁跑：E2E_SCRIPT="tools/check-image-runtime.mjs" node tools/gate-p6.mjs
// ============================================================
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = path.join(ROOT, "apps", "api-nest");
const PORT = Number(process.env.IMAGE_TEST_PORT || 4398);
const DEAD_PORT = PORT + 1;
const PROD_SECRET = "image-replay-secret-0123456789abcdef";
const MYSQL_PORT = process.env.MYSQL_PORT || "3307";
const REDIS_PORT = process.env.REDIS_PORT || "6380";

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fails.push(name + (detail ? "  " + detail : ""));
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOCKERFILE = process.env.IMAGE_DOCKERFILE
  ? path.resolve(process.env.IMAGE_DOCKERFILE)
  : path.join(ROOT, "deploy", "Dockerfile");

const containerEnv = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(PORT),
  AUTH_SECRET: PROD_SECRET,
  DEV_SMS: "0",
  TRUST_PROXY: "0",
  JOBS_ENABLED: "0",
  MYSQL_HOST: "127.0.0.1",
  MYSQL_PORT,
  MYSQL_USER: "root",
  MYSQL_PASSWORD: "",
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || "jiajiao",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT,
};

function spawnServer(env, port) {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: APP,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  let exited = null;
  child.on("exit", (code) => (exited = code));
  return { child, log, exited: () => exited, port };
}

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(800, () => {
      s.destroy();
      res(false);
    });
  });

async function waitPort(p, tries) {
  for (let i = 0; i < tries; i++) {
    if (await portOpen(p)) return true;
    await sleep(500);
  }
  return false;
}

const get = async (url) => {
  const r = await fetch(url, { headers: { "content-type": "application/json" } });
  const text = await r.text();
  return { status: r.status, type: r.headers.get("content-type") || "", text };
};

function killTree(child) {
  try {
    process.kill(-child.pid);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/* ============ A. Dockerfile 运行阶段声明 ============ */
const text = fs.readFileSync(DOCKERFILE, "utf8");
const cut = text.lastIndexOf("AS runtime");
const runtime = cut >= 0 ? text.slice(cut) : "";

console.log("镜像运行阶段契约校验（Dockerfile 的宿主机等价复演）");
console.log("  · 来源：deploy/Dockerfile 最后一个 stage（AS runtime）");

ok("存在运行阶段（AS runtime）", Boolean(runtime));
ok("ENV NODE_ENV=production", /ENV[\s\S]{0,80}NODE_ENV=production/.test(runtime));
ok("ENV PORT=4300", /PORT=4300/.test(runtime));
ok("WORKDIR /app/apps/api-nest（main.ts 用 cwd 解析静态目录）", /WORKDIR \/app\/apps\/api-nest/.test(runtime));

const copyRules = [
  ["后端运行期依赖", /COPY --from=api \/app\/apps\/api-nest\/node_modules \.\/node_modules/],
  ["后端编译产物", /COPY --from=api \/app\/apps\/api-nest\/dist \.\/dist/],
  ["后端 package.json", /COPY --from=api \/app\/apps\/api-nest\/package\.json \.\/package\.json/],
  ["数据库脚本（compose seed 用）", /COPY apps\/api-nest\/db \.\/db/],
  ["PC 后台产物 → /app/apps/web-admin/dist", /COPY --from=web-admin \/app\/apps\/web-admin\/dist/],
  ["移动端 H5 → /app/apps/web-mobile/dist/build/h5", /COPY --from=web-mobile \/app\/apps\/web-mobile\/dist\/build\/h5/],
  ["旧 5 端 UI → /app/web", /COPY web \/app\/web/],
];
for (const [label, re] of copyRules) ok("COPY " + label, re.test(runtime));

ok("以非 root 用户运行（USER node）", /USER node\b/.test(runtime) && !/USER root/.test(runtime));
ok("EXPOSE 4300", /EXPOSE 4300/.test(runtime));
ok(
  "HEALTHCHECK 探 /api/health 且带 interval/timeout/retries",
  /HEALTHCHECK[\s\S]{0,200}api\/health/.test(runtime) &&
    /--interval=/.test(runtime) &&
    /--timeout=/.test(runtime) &&
    /--retries=/.test(runtime),
);
ok("CMD 为 node dist/main.js", /CMD \["node", "dist\/main\.js"\]/.test(runtime));

/* ============ B. 产物依赖必须都在 dependencies（npm prune --omit=dev 后仍可跑） ============ */
const pkg = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
const prodDeps = new Set(Object.keys(pkg.dependencies || {}));
const devDeps = new Set(Object.keys(pkg.devDependencies || {}));
const builtins = new Set(
  (await import("node:module")).builtinModules.flatMap((m) => [m, "node:" + m]),
);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const distDir = path.join(APP, "dist");
ok("dist 编译产物存在", fs.existsSync(path.join(distDir, "main.js")));

const used = new Map();
for (const file of walk(distDir)) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:require\(|from\s+)["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || builtins.has(spec)) continue;
    const bare = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
    if (!used.has(bare)) used.set(bare, path.relative(APP, file));
  }
}
const missing = [...used.keys()].filter((d) => !prodDeps.has(d));
const devOnly = [...used.keys()].filter((d) => devDeps.has(d) && !prodDeps.has(d));
ok("dist 引用的第三方包全部在 dependencies", missing.length === 0, `引用 ${used.size} 个包` + (missing.length ? "；缺：" + missing.join("、") : ""));
ok("没有「只在 devDependencies 却被运行时引用」的包", devOnly.length === 0, devOnly.length ? "违规：" + devOnly.join("、") : "");
ok("compose seed 服务的入口存在（db/seed-min.mjs）", fs.existsSync(path.join(APP, "db", "seed-min.mjs")));

/* ============ C. 生产模式真起服 ============ */
let server = spawnServer(containerEnv, PORT);
let up = await waitPort(PORT, 80);
if (!up) {
  console.error("\n[准备失败] 生产模式起服超时，服务器日志：\n" + server.log.join(""));
  killTree(server.child);
  process.exit(1);
}
const base = `http://127.0.0.1:${PORT}`;
console.log("\n生产模式起服（NODE_ENV=production + AUTH_SECRET + DEV_SMS=0）");

const health = await get(base + "/api/health");
let hp = {};
try {
  hp = JSON.parse(health.text);
} catch {}
const hpData = hp && typeof hp.data === "object" && hp.data ? hp.data : {};
ok("GET /api/health 返回 200", health.status === 200, `HTTP ${health.status}`);
ok("健康状态 ok", hp.code === 0 && hpData.status === "ok", JSON.stringify(hp).slice(0, 90));
ok(
  "匿名 health 不下发运维指标",
  !("users" in hpData) && !("orders" in hpData) && !("escrow" in hpData),
  "data.keys=" + Object.keys(hpData).join(","),
);
ok("服务器日志回显实际 MySQL 端口（环境变量真的生效）", server.log.join("").includes(`:${MYSQL_PORT}`));

const admin = await get(base + "/admin-vue/");
ok("GET /admin-vue/ 返回 PC 后台挂载页", admin.status === 200 && /html/.test(admin.type), `HTTP ${admin.status} ${admin.type}`);
const mobile = await get(base + "/m/");
ok("GET /m/ 返回 uni-app H5 挂载页", mobile.status === 200 && /html/.test(mobile.type), `HTTP ${mobile.status} ${mobile.type}`);
const legacy = await get(base + "/parent");
ok("GET /parent 返回旧 5 端 UI 页面", legacy.status === 200 && /html/.test(legacy.type), `HTTP ${legacy.status} ${legacy.type}`);

// HEALTHCHECK：用 Dockerfile 里的原始命令（只把端口换成测试端口）真实执行一次
const hcMatch = runtime.match(/CMD node -e "([^"]+)"/);
let hcCmd = hcMatch ? hcMatch[1].replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`) : "";
let hcCode = -1;
let hcErr = "";
if (hcCmd) {
  try {
    execFileSync(process.execPath, ["-e", hcCmd], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    hcCode = 0;
  } catch (e) {
    hcCode = typeof e.status === "number" ? e.status : 1;
    hcErr = String(e.stderr || e.message).slice(0, 120);
  }
}
ok("HEALTHCHECK 命令在镜像同一路径下退出码为 0", hcCmd && hcCode === 0, hcCmd ? `exit=${hcCode}${hcErr ? " " + hcErr : ""}` : "Dockerfile 未找到可解析的 CMD node -e");

// 生产环境验证码绝不回显
const sendCode = await fetch(base + "/api/auth/send-code", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone: "13900000998" }),
});
let scBody = {};
try {
  scBody = await sendCode.json();
} catch {}
ok(
  "生产模式验证码不回显（DEV_SMS=0）",
  sendCode.status === 200 && !("devCode" in scBody) && !JSON.stringify(scBody).match(/\d{6}.*验证码/),
  `HTTP ${sendCode.status} keys=${Object.keys(scBody).join(",")}`,
);

killTree(server.child);
await sleep(800);

/* ============ D. 生产缺 AUTH_SECRET 必须拒绝启动 ============ */
console.log("\n生产模式缺失密钥的启动保护");
const noSecretEnv = { ...containerEnv, PORT: String(DEAD_PORT) };
delete noSecretEnv.AUTH_SECRET;
const broken = spawnServer(noSecretEnv, DEAD_PORT);
let exited = broken.exited();
for (let i = 0; i < 60 && exited === null; i++) {
  await sleep(500);
  exited = broken.exited();
}
const bootLog = broken.log.join("");
ok("缺 AUTH_SECRET 且 NODE_ENV=production 时进程拒绝启动", exited !== null && exited !== 0, `exit=${exited}`);
ok("拒绝原因明确提示 AUTH_SECRET", /AUTH_SECRET/.test(bootLog), bootLog.split("\n").find((l) => /AUTH_SECRET/.test(l))?.trim()?.slice(0, 90) || "日志未包含 AUTH_SECRET");
ok("缺失密钥时并未真的对外监听", !(await portOpen(DEAD_PORT)));
killTree(broken.child);

/* ============ 汇总 ============ */
console.log("\n" + "=".repeat(49));
console.log(`镜像运行契约：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log("未通过：");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("Dockerfile 运行阶段的配置、产物依赖与生产运行契约全部成立 ✅");
console.log("⚠️ 仍未覆盖：容器内核/网络命名空间、USER node 的 uid 权限、镜像层与体积（需 Docker 环境）");
console.log("=".repeat(49));
